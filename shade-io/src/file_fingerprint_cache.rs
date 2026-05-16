//! Persistent fingerprint cache and lookup workflow
//! (see `docs/distributed-file-identification.md`, §5 + §6).
//!
//! Backed by libSQL. Stores `(fingerprint, locator)` rows with the freshness
//! data (`size`, `mtime_ms`, `etag`) needed to invalidate them. Provides the
//! lazy [`get_or_compute`] entry point that wraps callers in a single-flight
//! coalescer and only computes on cache miss.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use tokio::sync::Mutex;

use crate::file_fingerprint::{
    Fingerprint, FingerprintError, ALGO_V1_SAMPLES, ALGO_V_S3_ETAG,
};
use crate::file_fingerprint_io::{coalesce, FingerprintHints, FingerprintResult};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LocatorKind {
    Local,
    S3,
    Http,
    Peer,
}

impl LocatorKind {
    pub fn as_str(self) -> &'static str {
        match self {
            LocatorKind::Local => "local",
            LocatorKind::S3 => "s3",
            LocatorKind::Http => "http",
            LocatorKind::Peer => "peer",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "local" => Some(LocatorKind::Local),
            "s3" => Some(LocatorKind::S3),
            "http" => Some(LocatorKind::Http),
            "peer" => Some(LocatorKind::Peer),
            _ => None,
        }
    }
}

#[derive(Clone, Debug)]
pub struct FingerprintRow {
    pub fingerprint: Fingerprint,
    pub size: u64,
    pub locator: String,
    pub locator_kind: LocatorKind,
    pub mtime_ms: Option<i64>,
    pub etag: Option<String>,
    pub computed_at: i64,
    pub algo_version: u32,
}

pub fn file_fingerprints_db_path(config_dir: &Path) -> PathBuf {
    config_dir.join("fingerprints.db")
}

pub struct FileFingerprintDb {
    _db: libsql::Database,
    conn: Mutex<libsql::Connection>,
}

impl FileFingerprintDb {
    pub async fn open(db_path: &Path) -> Result<Self, String> {
        if let Some(parent) = db_path.parent() {
            if !parent.as_os_str().is_empty() {
                std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
            }
        }
        let db = libsql::Builder::new_local(db_path)
            .build()
            .await
            .map_err(|error| error.to_string())?;
        let conn = db.connect().map_err(|error| error.to_string())?;
        conn.query("PRAGMA journal_mode = WAL", ())
            .await
            .map_err(|error| error.to_string())?;
        conn.query("PRAGMA busy_timeout = 5000", ())
            .await
            .map_err(|error| error.to_string())?;
        conn.execute(
            "CREATE TABLE IF NOT EXISTS file_fingerprints (
                fingerprint   BLOB    NOT NULL,
                size          INTEGER NOT NULL,
                locator       TEXT    NOT NULL,
                locator_kind  TEXT    NOT NULL,
                mtime_ms      INTEGER,
                etag          TEXT,
                computed_at   INTEGER NOT NULL,
                algo_version  INTEGER NOT NULL DEFAULT 1,
                PRIMARY KEY (fingerprint, locator)
            )",
            (),
        )
        .await
        .map_err(|error| error.to_string())?;
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_file_fp_locator ON file_fingerprints(locator)",
            (),
        )
        .await
        .map_err(|error| error.to_string())?;
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_file_fp_size ON file_fingerprints(size)",
            (),
        )
        .await
        .map_err(|error| error.to_string())?;
        Ok(Self {
            _db: db,
            conn: Mutex::new(conn),
        })
    }

    /// Cache lookup keyed by `(locator, size, mtime_ms, etag, algo_version)`
    /// per §6.2 step 3. Uses SQL `IS` so NULL freshness signals match rows
    /// with NULL freshness.
    pub async fn lookup(
        &self,
        locator: &str,
        size: u64,
        mtime_ms: Option<i64>,
        etag: Option<&str>,
        algo_version: u32,
    ) -> Result<Option<FingerprintRow>, String> {
        let conn = self.conn.lock().await;
        let mut rows = conn
            .query(
                "SELECT fingerprint, size, locator, locator_kind, mtime_ms, etag,
                        computed_at, algo_version
                 FROM file_fingerprints
                 WHERE locator       = ?1
                   AND size          = ?2
                   AND mtime_ms      IS ?3
                   AND etag          IS ?4
                   AND algo_version  = ?5
                 LIMIT 1",
                libsql::params![
                    locator,
                    i64::try_from(size).map_err(|e| e.to_string())?,
                    mtime_ms,
                    etag.map(str::to_string),
                    i64::from(algo_version),
                ],
            )
            .await
            .map_err(|error| error.to_string())?;
        match rows.next().await.map_err(|error| error.to_string())? {
            Some(row) => Ok(Some(row_to_fingerprint(&row)?)),
            None => Ok(None),
        }
    }

    /// All rows pointing at a given fingerprint — peer "do you have X?" answer.
    pub async fn lookup_by_fingerprint(
        &self,
        fingerprint: &Fingerprint,
    ) -> Result<Vec<FingerprintRow>, String> {
        let conn = self.conn.lock().await;
        let mut rows = conn
            .query(
                "SELECT fingerprint, size, locator, locator_kind, mtime_ms, etag,
                        computed_at, algo_version
                 FROM file_fingerprints
                 WHERE fingerprint = ?1",
                libsql::params![fingerprint.as_bytes().to_vec()],
            )
            .await
            .map_err(|error| error.to_string())?;
        let mut out = Vec::new();
        while let Some(row) = rows.next().await.map_err(|error| error.to_string())? {
            out.push(row_to_fingerprint(&row)?);
        }
        Ok(out)
    }

    /// Insert or replace a row. On `(fingerprint, locator)` conflict the row
    /// with the newer `computed_at` wins (last-writer-wins, §6.4).
    pub async fn upsert(&self, row: &FingerprintRow) -> Result<(), String> {
        let conn = self.conn.lock().await;
        conn.execute(
            "INSERT INTO file_fingerprints
                (fingerprint, size, locator, locator_kind, mtime_ms, etag,
                 computed_at, algo_version)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
             ON CONFLICT(fingerprint, locator) DO UPDATE SET
                size         = excluded.size,
                locator_kind = excluded.locator_kind,
                mtime_ms     = excluded.mtime_ms,
                etag         = excluded.etag,
                computed_at  = excluded.computed_at,
                algo_version = excluded.algo_version
             WHERE excluded.computed_at > file_fingerprints.computed_at",
            libsql::params![
                row.fingerprint.as_bytes().to_vec(),
                i64::try_from(row.size).map_err(|e| e.to_string())?,
                row.locator.as_str(),
                row.locator_kind.as_str(),
                row.mtime_ms,
                row.etag.clone(),
                row.computed_at,
                i64::from(row.algo_version),
            ],
        )
        .await
        .map_err(|error| error.to_string())?;
        Ok(())
    }

    /// Manual invalidation (§6.3). Returns the number of removed rows.
    pub async fn delete_by_prefix(&self, prefix: &str) -> Result<usize, String> {
        let conn = self.conn.lock().await;
        let pattern = format!("{}%", prefix.replace('%', r"\%").replace('_', r"\_"));
        let changes = conn
            .execute(
                "DELETE FROM file_fingerprints WHERE locator LIKE ?1 ESCAPE '\\'",
                libsql::params![pattern],
            )
            .await
            .map_err(|error| error.to_string())?;
        Ok(usize::try_from(changes).unwrap_or(0))
    }

    /// Export rows touched at or after `since_ms` for peer sync (§6.4).
    pub async fn export_rows(
        &self,
        since_ms: i64,
    ) -> Result<Vec<FingerprintRow>, String> {
        let conn = self.conn.lock().await;
        let mut rows = conn
            .query(
                "SELECT fingerprint, size, locator, locator_kind, mtime_ms, etag,
                        computed_at, algo_version
                 FROM file_fingerprints
                 WHERE computed_at >= ?1",
                libsql::params![since_ms],
            )
            .await
            .map_err(|error| error.to_string())?;
        let mut out = Vec::new();
        while let Some(row) = rows.next().await.map_err(|error| error.to_string())? {
            out.push(row_to_fingerprint(&row)?);
        }
        Ok(out)
    }

    /// Import peer-supplied rows under last-writer-wins semantics.
    pub async fn import_rows(&self, rows: &[FingerprintRow]) -> Result<(), String> {
        for row in rows {
            self.upsert(row).await?;
        }
        Ok(())
    }
}

fn row_to_fingerprint(row: &libsql::Row) -> Result<FingerprintRow, String> {
    let bytes = row.get::<Vec<u8>>(0).map_err(|error| error.to_string())?;
    let array: [u8; 32] = bytes
        .as_slice()
        .try_into()
        .map_err(|_| format!("fingerprint blob is {} bytes, expected 32", bytes.len()))?;
    let size = row.get::<i64>(1).map_err(|error| error.to_string())?;
    let locator = row.get::<String>(2).map_err(|error| error.to_string())?;
    let locator_kind_raw = row.get::<String>(3).map_err(|error| error.to_string())?;
    let locator_kind = LocatorKind::parse(&locator_kind_raw)
        .ok_or_else(|| format!("unknown locator_kind: {locator_kind_raw}"))?;
    let mtime_ms = row
        .get::<Option<i64>>(4)
        .map_err(|error| error.to_string())?;
    let etag = row
        .get::<Option<String>>(5)
        .map_err(|error| error.to_string())?;
    let computed_at = row.get::<i64>(6).map_err(|error| error.to_string())?;
    let algo_version = row.get::<i64>(7).map_err(|error| error.to_string())?;
    Ok(FingerprintRow {
        fingerprint: Fingerprint::from_bytes(array),
        size: u64::try_from(size).map_err(|e| e.to_string())?,
        locator,
        locator_kind,
        mtime_ms,
        etag,
        computed_at,
        algo_version: u32::try_from(algo_version).map_err(|e| e.to_string())?,
    })
}

/// Lazy compute entry point per §6.2.
///
/// 1. If `hints` carries enough freshness data, look up the cache for both
///    the S3-ETag fast-path and the sample-scheme rows; on hit, return
///    without invoking `compute`.
/// 2. On miss, run `compute` inside a single-flight coalescer keyed by
///    `locator` so concurrent callers share one I/O round-trip, then upsert
///    the resulting row.
pub async fn get_or_compute<F, Fut>(
    db: &FileFingerprintDb,
    locator: &str,
    locator_kind: LocatorKind,
    hints: FingerprintHints,
    compute: F,
) -> Result<FingerprintResult, FingerprintError>
where
    F: FnOnce(FingerprintHints) -> Fut,
    Fut: std::future::Future<Output = Result<FingerprintResult, FingerprintError>>,
{
    if let Some(size) = hints.size {
        for algo in lookup_algos(locator_kind, hints.etag.is_some()) {
            if let Some(row) = db
                .lookup(locator, size, hints.mtime_ms, hints.etag.as_deref(), *algo)
                .await
                .map_err(io_error)?
            {
                return Ok(FingerprintResult {
                    fingerprint: row.fingerprint,
                    size: row.size,
                    mtime_ms: row.mtime_ms,
                    etag: row.etag,
                    algo_version: row.algo_version,
                });
            }
        }
    }

    let key = format!("get_or_compute:{locator}");
    let locator_owned = locator.to_string();
    let hints_for_compute = hints;

    let result = coalesce(key, || async {
        let result = compute(hints_for_compute).await?;
        db.upsert(&FingerprintRow {
            fingerprint: result.fingerprint,
            size: result.size,
            locator: locator_owned,
            locator_kind,
            mtime_ms: result.mtime_ms,
            etag: result.etag.clone(),
            computed_at: now_ms(),
            algo_version: result.algo_version,
        })
        .await
        .map_err(io_error)?;
        Ok(result)
    })
    .await
    .map_err(unwrap_arc)?;

    Ok(result)
}

fn lookup_algos(locator_kind: LocatorKind, has_etag: bool) -> &'static [u32] {
    match (locator_kind, has_etag) {
        (LocatorKind::S3, true) => &[ALGO_V_S3_ETAG, ALGO_V1_SAMPLES],
        _ => &[ALGO_V1_SAMPLES],
    }
}

fn io_error<E: std::fmt::Display>(error: E) -> FingerprintError {
    FingerprintError::Io(std::io::Error::new(
        std::io::ErrorKind::Other,
        error.to_string(),
    ))
}

fn unwrap_arc(error: Arc<FingerprintError>) -> FingerprintError {
    Arc::try_unwrap(error).unwrap_or_else(|arc| io_error(arc.to_string()))
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::file_fingerprint::fingerprint_from_samples;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
    use std::time::Duration;

    static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

    struct TempDb {
        path: PathBuf,
    }

    impl TempDb {
        fn path(name: &str) -> Self {
            let n = TEMP_COUNTER.fetch_add(1, Ordering::SeqCst);
            let path = std::env::temp_dir().join(format!(
                "shade-fpcache-{}-{}-{}.db",
                std::process::id(),
                n,
                name
            ));
            let _ = std::fs::remove_file(&path);
            Self { path }
        }
    }

    impl Drop for TempDb {
        fn drop(&mut self) {
            let _ = std::fs::remove_file(&self.path);
            let wal = self.path.with_extension("db-wal");
            let shm = self.path.with_extension("db-shm");
            let _ = std::fs::remove_file(wal);
            let _ = std::fs::remove_file(shm);
        }
    }

    fn synth_fingerprint(seed: u64) -> Fingerprint {
        fingerprint_from_samples(seed, &[(0, &seed.to_le_bytes())])
    }

    fn synth_row(
        seed: u64,
        locator: &str,
        kind: LocatorKind,
        mtime: Option<i64>,
        etag: Option<&str>,
        computed_at: i64,
        algo: u32,
    ) -> FingerprintRow {
        FingerprintRow {
            fingerprint: synth_fingerprint(seed),
            size: 1024 + seed,
            locator: locator.to_string(),
            locator_kind: kind,
            mtime_ms: mtime,
            etag: etag.map(str::to_string),
            computed_at,
            algo_version: algo,
        }
    }

    #[tokio::test]
    async fn round_trip_three_locators_for_one_fingerprint() {
        let temp = TempDb::path("round-trip");
        let db = FileFingerprintDb::open(&temp.path).await.unwrap();

        let fp = synth_fingerprint(1);
        for (locator, kind, mtime, etag) in [
            ("/local/path", LocatorKind::Local, Some(1000), None),
            ("s3://bucket/key", LocatorKind::S3, None, Some("etag-1")),
            ("https://host/x", LocatorKind::Http, None, Some("etag-1")),
        ] {
            db.upsert(&FingerprintRow {
                fingerprint: fp,
                size: 4096,
                locator: locator.to_string(),
                locator_kind: kind,
                mtime_ms: mtime,
                etag: etag.map(str::to_string),
                computed_at: 1,
                algo_version: ALGO_V1_SAMPLES,
            })
            .await
            .unwrap();
        }

        let rows = db.lookup_by_fingerprint(&fp).await.unwrap();
        assert_eq!(rows.len(), 3);

        let hit = db
            .lookup("/local/path", 4096, Some(1000), None, ALGO_V1_SAMPLES)
            .await
            .unwrap()
            .expect("local hit");
        assert_eq!(hit.fingerprint, fp);
        assert_eq!(hit.locator_kind, LocatorKind::Local);

        let miss = db
            .lookup("/local/path", 4096, Some(2000), None, ALGO_V1_SAMPLES)
            .await
            .unwrap();
        assert!(miss.is_none(), "different mtime must not hit");
    }

    #[tokio::test]
    async fn cache_hit_skips_compute_with_full_hints() {
        let temp = TempDb::path("hit-skips");
        let db = FileFingerprintDb::open(&temp.path).await.unwrap();
        let counter = Arc::new(AtomicUsize::new(0));

        let fp = synth_fingerprint(7);
        let hints = FingerprintHints {
            size: Some(2048),
            mtime_ms: Some(42_000),
            ..Default::default()
        };

        // Prime the cache.
        let counter_a = counter.clone();
        let _ = get_or_compute(
            &db,
            "/cache/me",
            LocatorKind::Local,
            hints.clone(),
            move |_| {
                let counter = counter_a.clone();
                async move {
                    counter.fetch_add(1, Ordering::SeqCst);
                    Ok(FingerprintResult {
                        fingerprint: fp,
                        size: 2048,
                        mtime_ms: Some(42_000),
                        etag: None,
                        algo_version: ALGO_V1_SAMPLES,
                    })
                }
            },
        )
        .await
        .unwrap();
        assert_eq!(counter.load(Ordering::SeqCst), 1);

        // Second call must hit the cache.
        let counter_b = counter.clone();
        let result =
            get_or_compute(&db, "/cache/me", LocatorKind::Local, hints, move |_| {
                let counter = counter_b.clone();
                async move {
                    counter.fetch_add(1, Ordering::SeqCst);
                    panic!("compute must not run on cache hit");
                }
            })
            .await
            .unwrap();
        assert_eq!(counter.load(Ordering::SeqCst), 1);
        assert_eq!(result.fingerprint, fp);
    }

    #[tokio::test]
    async fn local_mtime_change_triggers_recompute() {
        let temp = TempDb::path("mtime-change");
        let db = FileFingerprintDb::open(&temp.path).await.unwrap();
        let counter = Arc::new(AtomicUsize::new(0));

        for (mtime, fp_seed) in [(100, 1u64), (200, 2u64)] {
            let counter = counter.clone();
            let result = get_or_compute(
                &db,
                "/file",
                LocatorKind::Local,
                FingerprintHints {
                    size: Some(2048),
                    mtime_ms: Some(mtime),
                    ..Default::default()
                },
                move |_| {
                    let counter = counter.clone();
                    async move {
                        counter.fetch_add(1, Ordering::SeqCst);
                        Ok(FingerprintResult {
                            fingerprint: synth_fingerprint(fp_seed),
                            size: 2048,
                            mtime_ms: Some(mtime),
                            etag: None,
                            algo_version: ALGO_V1_SAMPLES,
                        })
                    }
                },
            )
            .await
            .unwrap();
            assert_eq!(result.fingerprint, synth_fingerprint(fp_seed));
        }
        assert_eq!(counter.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn s3_etag_change_triggers_recompute() {
        let temp = TempDb::path("etag-change");
        let db = FileFingerprintDb::open(&temp.path).await.unwrap();
        let counter = Arc::new(AtomicUsize::new(0));

        for (etag, fp_seed) in [("v1", 11u64), ("v2", 22u64)] {
            let counter = counter.clone();
            let result = get_or_compute(
                &db,
                "s3://bucket/object",
                LocatorKind::S3,
                FingerprintHints {
                    size: Some(2048),
                    etag: Some(etag.to_string()),
                    sse_mode: Some("aws:kms".to_string()),
                    ..Default::default()
                },
                move |_| {
                    let counter = counter.clone();
                    async move {
                        counter.fetch_add(1, Ordering::SeqCst);
                        Ok(FingerprintResult {
                            fingerprint: synth_fingerprint(fp_seed),
                            size: 2048,
                            mtime_ms: None,
                            etag: Some(etag.to_string()),
                            algo_version: ALGO_V1_SAMPLES,
                        })
                    }
                },
            )
            .await
            .unwrap();
            assert_eq!(result.fingerprint, synth_fingerprint(fp_seed));
        }
        assert_eq!(counter.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn algo_version_migration_keeps_old_row_and_inserts_new() {
        let temp = TempDb::path("algo-migration");
        let db = FileFingerprintDb::open(&temp.path).await.unwrap();

        // Seed a v=0 row (legacy).
        let legacy = synth_row(99, "/path", LocatorKind::Local, Some(50), None, 1, 0);
        db.upsert(&legacy).await.unwrap();

        // A v=0 lookup still hits.
        assert_eq!(
            db.lookup("/path", legacy.size, Some(50), None, 0)
                .await
                .unwrap()
                .map(|r| r.fingerprint),
            Some(legacy.fingerprint)
        );

        // A v=1 lookup misses (different algo_version).
        assert!(db
            .lookup("/path", legacy.size, Some(50), None, ALGO_V1_SAMPLES)
            .await
            .unwrap()
            .is_none());

        // get_or_compute at v=1 produces a fresh fingerprint, inserts a new row.
        let counter = Arc::new(AtomicUsize::new(0));
        let counter_c = counter.clone();
        let result = get_or_compute(
            &db,
            "/path",
            LocatorKind::Local,
            FingerprintHints {
                size: Some(legacy.size),
                mtime_ms: Some(50),
                ..Default::default()
            },
            move |_| {
                let counter = counter_c.clone();
                async move {
                    counter.fetch_add(1, Ordering::SeqCst);
                    Ok(FingerprintResult {
                        fingerprint: synth_fingerprint(100),
                        size: legacy.size,
                        mtime_ms: Some(50),
                        etag: None,
                        algo_version: ALGO_V1_SAMPLES,
                    })
                }
            },
        )
        .await
        .unwrap();
        assert_eq!(counter.load(Ordering::SeqCst), 1);
        assert_eq!(result.algo_version, ALGO_V1_SAMPLES);

        // Both rows now exist.
        let v0 = db
            .lookup("/path", legacy.size, Some(50), None, 0)
            .await
            .unwrap();
        let v1 = db
            .lookup("/path", legacy.size, Some(50), None, ALGO_V1_SAMPLES)
            .await
            .unwrap();
        assert!(v0.is_some(), "legacy v=0 row must remain selectable");
        assert!(v1.is_some(), "new v=1 row must be inserted");
        assert_ne!(v0.unwrap().fingerprint, v1.unwrap().fingerprint);
    }

    #[tokio::test]
    async fn delete_by_prefix_removes_only_matching_rows() {
        let temp = TempDb::path("delete-prefix");
        let db = FileFingerprintDb::open(&temp.path).await.unwrap();

        for (i, locator, kind) in [
            (1u64, "s3://bucket-x/a", LocatorKind::S3),
            (2, "s3://bucket-x/b", LocatorKind::S3),
            (3, "s3://bucket-y/c", LocatorKind::S3),
            (4, "/local/d", LocatorKind::Local),
        ] {
            db.upsert(&synth_row(i, locator, kind, None, Some("e"), 1, 1))
                .await
                .unwrap();
        }

        let removed = db.delete_by_prefix("s3://bucket-x/").await.unwrap();
        assert_eq!(removed, 2);

        for fp_seed in [1, 2] {
            assert!(db
                .lookup_by_fingerprint(&synth_fingerprint(fp_seed))
                .await
                .unwrap()
                .is_empty());
        }
        for fp_seed in [3, 4] {
            assert_eq!(
                db.lookup_by_fingerprint(&synth_fingerprint(fp_seed))
                    .await
                    .unwrap()
                    .len(),
                1
            );
        }
    }

    #[tokio::test]
    async fn upsert_is_last_writer_wins_by_computed_at() {
        let temp = TempDb::path("lww");
        let db = FileFingerprintDb::open(&temp.path).await.unwrap();

        let newer = synth_row(5, "/x", LocatorKind::Local, Some(10), None, 1_000, 1);
        db.upsert(&newer).await.unwrap();

        let older = FingerprintRow {
            mtime_ms: Some(20),
            computed_at: 500, // older than the row already in the DB
            ..newer.clone()
        };
        db.upsert(&older).await.unwrap();

        // Stored row must remain the newer one (mtime 10).
        let row = db
            .lookup("/x", newer.size, Some(10), None, 1)
            .await
            .unwrap()
            .expect("newer row preserved");
        assert_eq!(row.mtime_ms, Some(10));
        assert_eq!(row.computed_at, 1_000);
    }

    #[tokio::test]
    async fn export_import_round_trip_is_idempotent() {
        let src_temp = TempDb::path("export-src");
        let dst_temp = TempDb::path("export-dst");
        let src = FileFingerprintDb::open(&src_temp.path).await.unwrap();
        let dst = FileFingerprintDb::open(&dst_temp.path).await.unwrap();

        let rows = vec![
            synth_row(1, "/a", LocatorKind::Local, Some(1), None, 100, 1),
            synth_row(2, "s3://b/c", LocatorKind::S3, None, Some("e"), 200, 1),
            synth_row(3, "https://h/x", LocatorKind::Http, None, Some("h"), 300, 1),
        ];
        for row in &rows {
            src.upsert(row).await.unwrap();
        }

        let exported = src.export_rows(0).await.unwrap();
        assert_eq!(exported.len(), 3);

        // Import twice (idempotent).
        dst.import_rows(&exported).await.unwrap();
        dst.import_rows(&exported).await.unwrap();

        let mut imported = dst.export_rows(0).await.unwrap();
        imported.sort_by(|a, b| a.locator.cmp(&b.locator));
        let mut original = rows.clone();
        original.sort_by(|a, b| a.locator.cmp(&b.locator));

        assert_eq!(imported.len(), original.len());
        for (a, b) in imported.iter().zip(original.iter()) {
            assert_eq!(a.fingerprint, b.fingerprint);
            assert_eq!(a.locator, b.locator);
            assert_eq!(a.locator_kind, b.locator_kind);
            assert_eq!(a.mtime_ms, b.mtime_ms);
            assert_eq!(a.etag, b.etag);
            assert_eq!(a.size, b.size);
            assert_eq!(a.algo_version, b.algo_version);
        }
    }

    #[tokio::test]
    async fn concurrent_get_or_compute_coalesces_to_one_compute() {
        let temp = TempDb::path("coalesce");
        let db = Arc::new(FileFingerprintDb::open(&temp.path).await.unwrap());
        let counter = Arc::new(AtomicUsize::new(0));

        let mut handles = Vec::new();
        for _ in 0..50 {
            let db = db.clone();
            let counter = counter.clone();
            handles.push(tokio::spawn(async move {
                get_or_compute(
                    &db,
                    "/concurrent",
                    LocatorKind::Local,
                    FingerprintHints::default(), // no hints ⇒ skip cache lookup
                    move |_| {
                        let counter = counter.clone();
                        async move {
                            tokio::time::sleep(Duration::from_millis(50)).await;
                            counter.fetch_add(1, Ordering::SeqCst);
                            Ok(FingerprintResult {
                                fingerprint: synth_fingerprint(123),
                                size: 4096,
                                mtime_ms: Some(0),
                                etag: None,
                                algo_version: ALGO_V1_SAMPLES,
                            })
                        }
                    },
                )
                .await
            }));
        }
        for h in handles {
            h.await.unwrap().unwrap();
        }
        assert_eq!(counter.load(Ordering::SeqCst), 1);

        // After settle, exactly one row exists.
        let rows = db
            .lookup_by_fingerprint(&synth_fingerprint(123))
            .await
            .unwrap();
        assert_eq!(rows.len(), 1);
    }
}
