//! Async fingerprinting over local, HTTP, and S3 sources
//! (see `docs/distributed-file-identification.md`, §4 + §6 + §7).
//!
//! Builds on the sync digest format from [`crate::file_fingerprint`]. Adds:
//! - `HEAD` / `HeadObject` metadata fetch.
//! - Parallel ranged GETs for the sample scheme.
//! - The S3 ETag fast path (§3.6) when `x-amz-server-side-encryption` is
//!   absent or `AES256`.
//! - Per-stage semaphores (§7).
//! - Single-flight coalescing keyed by canonical locator (§6.2).

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use tokio::sync::{Mutex, OnceCell, Semaphore};

use crate::file_fingerprint::{
    fingerprint_from_s3_etag, fingerprint_from_samples, fingerprint_local, sample_plan,
    Fingerprint, FingerprintError, ALGO_V1_SAMPLES, ALGO_V_S3_ETAG,
};
use crate::library_source::{
    get_s3_object_range, head_s3_object_metadata, S3LibraryConfig,
};

/// Hints supplied by the caller (typically populated from listings) so the
/// fingerprint compute can skip a `HEAD`/stat.
#[derive(Default, Clone, Debug)]
pub struct FingerprintHints {
    pub size: Option<u64>,
    pub mtime_ms: Option<i64>,
    pub etag: Option<String>,
    pub sse_mode: Option<String>,
}

#[derive(Clone, Debug)]
pub struct FingerprintResult {
    pub fingerprint: Fingerprint,
    pub size: u64,
    pub mtime_ms: Option<i64>,
    pub etag: Option<String>,
    pub algo_version: u32,
}

// ── §7: Semaphores ────────────────────────────────────────────────────────────

fn local_read_semaphore() -> &'static Semaphore {
    static S: OnceLock<Semaphore> = OnceLock::new();
    S.get_or_init(|| Semaphore::new(64))
}

fn http_get_semaphore() -> &'static Semaphore {
    static S: OnceLock<Semaphore> = OnceLock::new();
    S.get_or_init(|| Semaphore::new(100))
}

fn http_head_semaphore() -> &'static Semaphore {
    static S: OnceLock<Semaphore> = OnceLock::new();
    S.get_or_init(|| Semaphore::new(200))
}

// ── HTTP source ────────────────────────────────────────────────────────────────

pub async fn fingerprint_http(
    client: &reqwest::Client,
    url: &str,
    hints: FingerprintHints,
) -> Result<FingerprintResult, FingerprintError> {
    let (size, etag) = match hints.size {
        Some(size) => (size, hints.etag.clone()),
        None => http_head(client, url).await?,
    };

    let plan = sample_plan(size);
    let chunks = fetch_http_ranges(client, url, &plan).await?;
    let samples: Vec<(u64, &[u8])> = plan
        .iter()
        .zip(chunks.iter())
        .map(|((offset, _), chunk)| (*offset, chunk.as_slice()))
        .collect();

    Ok(FingerprintResult {
        fingerprint: fingerprint_from_samples(size, &samples),
        size,
        mtime_ms: hints.mtime_ms,
        etag,
        algo_version: ALGO_V1_SAMPLES,
    })
}

async fn http_head(
    client: &reqwest::Client,
    url: &str,
) -> Result<(u64, Option<String>), FingerprintError> {
    let _permit = http_head_semaphore().acquire().await.map_err(io_other)?;
    let response = with_retry(|| async {
        client
            .head(url)
            .send()
            .await
            .and_then(|r| r.error_for_status())
            .map_err(io_other)
    })
    .await?;
    let size = response
        .headers()
        .get(reqwest::header::CONTENT_LENGTH)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<u64>().ok())
        .ok_or_else(|| io_other(format!("HEAD {url}: missing Content-Length")))?;
    let etag = response
        .headers()
        .get(reqwest::header::ETAG)
        .and_then(|value| value.to_str().ok())
        .map(|value| value.trim_matches('"').to_string())
        .filter(|value| !value.is_empty());
    Ok((size, etag))
}

async fn fetch_http_ranges(
    client: &reqwest::Client,
    url: &str,
    plan: &[(u64, u32)],
) -> Result<Vec<Vec<u8>>, FingerprintError> {
    match plan {
        [] => Ok(Vec::new()),
        [(o, l)] => Ok(vec![fetch_http_range(client, url, *o, *l).await?]),
        [s1, s2, s3, s4] => {
            let (a, b, c, d) = tokio::try_join!(
                fetch_http_range(client, url, s1.0, s1.1),
                fetch_http_range(client, url, s2.0, s2.1),
                fetch_http_range(client, url, s3.0, s3.1),
                fetch_http_range(client, url, s4.0, s4.1),
            )?;
            Ok(vec![a, b, c, d])
        }
        _ => Err(io_other(format!(
            "unexpected sample plan length: {}",
            plan.len()
        ))),
    }
}

async fn fetch_http_range(
    client: &reqwest::Client,
    url: &str,
    offset: u64,
    len: u32,
) -> Result<Vec<u8>, FingerprintError> {
    let _permit = http_get_semaphore().acquire().await.map_err(io_other)?;
    let end = offset + u64::from(len.saturating_sub(1));
    let range = format!("bytes={offset}-{end}");
    let bytes = with_retry(|| async {
        let response = client
            .get(url)
            .header(reqwest::header::RANGE, &range)
            .send()
            .await
            .and_then(|r| r.error_for_status())
            .map_err(io_other)?;
        response.bytes().await.map_err(io_other)
    })
    .await?;
    if bytes.len() as u64 != u64::from(len) {
        return Err(FingerprintError::TruncatedRead {
            offset,
            requested: len,
            got: bytes.len().min(u32::MAX as usize) as u32,
        });
    }
    Ok(bytes.to_vec())
}

// ── S3 source ──────────────────────────────────────────────────────────────────

/// Whether the supplied SSE mode means the ETag is a true content hash (§3.6).
pub fn etag_is_content_hash(sse_mode: Option<&str>) -> bool {
    match sse_mode {
        None => true,
        Some(mode) => mode.eq_ignore_ascii_case("AES256"),
    }
}

pub async fn fingerprint_s3(
    config: &S3LibraryConfig,
    key: &str,
    hints: FingerprintHints,
) -> Result<FingerprintResult, FingerprintError> {
    let (size, etag, sse_mode, mtime_ms) =
        match (&hints.size, &hints.etag, &hints.sse_mode) {
            (Some(size), Some(etag), sse) => {
                (*size, Some(etag.clone()), sse.clone(), hints.mtime_ms)
            }
            _ => {
                let metadata = head_s3_object_metadata(config, key)
                    .await
                    .map_err(io_other)?;
                (
                    metadata.size,
                    metadata.etag,
                    metadata.sse_mode,
                    metadata.modified_at.map(|ms| ms as i64).or(hints.mtime_ms),
                )
            }
        };

    if let Some(etag_value) = etag.as_deref() {
        if etag_is_content_hash(sse_mode.as_deref()) {
            return Ok(FingerprintResult {
                fingerprint: fingerprint_from_s3_etag(size, etag_value),
                size,
                mtime_ms,
                etag,
                algo_version: ALGO_V_S3_ETAG,
            });
        }
    }

    let plan = sample_plan(size);
    let chunks = fetch_s3_ranges(config, key, &plan).await?;
    let samples: Vec<(u64, &[u8])> = plan
        .iter()
        .zip(chunks.iter())
        .map(|((offset, _), chunk)| (*offset, chunk.as_slice()))
        .collect();

    Ok(FingerprintResult {
        fingerprint: fingerprint_from_samples(size, &samples),
        size,
        mtime_ms,
        etag,
        algo_version: ALGO_V1_SAMPLES,
    })
}

async fn fetch_s3_ranges(
    config: &S3LibraryConfig,
    key: &str,
    plan: &[(u64, u32)],
) -> Result<Vec<Vec<u8>>, FingerprintError> {
    match plan {
        [] => Ok(Vec::new()),
        [(o, l)] => Ok(vec![fetch_s3_range(config, key, *o, *l).await?]),
        [s1, s2, s3, s4] => {
            let (a, b, c, d) = tokio::try_join!(
                fetch_s3_range(config, key, s1.0, s1.1),
                fetch_s3_range(config, key, s2.0, s2.1),
                fetch_s3_range(config, key, s3.0, s3.1),
                fetch_s3_range(config, key, s4.0, s4.1),
            )?;
            Ok(vec![a, b, c, d])
        }
        _ => Err(io_other(format!(
            "unexpected sample plan length: {}",
            plan.len()
        ))),
    }
}

async fn fetch_s3_range(
    config: &S3LibraryConfig,
    key: &str,
    offset: u64,
    len: u32,
) -> Result<Vec<u8>, FingerprintError> {
    let bytes = with_retry(|| async {
        get_s3_object_range(config, key, offset, len)
            .await
            .map_err(io_other)
    })
    .await?;
    if bytes.len() as u64 != u64::from(len) {
        return Err(FingerprintError::TruncatedRead {
            offset,
            requested: len,
            got: bytes.len().min(u32::MAX as usize) as u32,
        });
    }
    Ok(bytes)
}

// ── Local source (async wrapper around step 1) ─────────────────────────────────

pub async fn fingerprint_local_async(
    path: PathBuf,
) -> Result<FingerprintResult, FingerprintError> {
    let _permit = local_read_semaphore().acquire().await.map_err(io_other)?;
    let local = tokio::task::spawn_blocking(move || fingerprint_local(&path))
        .await
        .map_err(io_other)??;
    Ok(FingerprintResult {
        fingerprint: local.fingerprint,
        size: local.size,
        mtime_ms: local.mtime_ms,
        etag: None,
        algo_version: ALGO_V1_SAMPLES,
    })
}

// ── Single-flight ──────────────────────────────────────────────────────────────

type SharedResult = Result<FingerprintResult, Arc<FingerprintError>>;
type InflightCell = Arc<OnceCell<SharedResult>>;

fn inflight() -> &'static Mutex<HashMap<String, InflightCell>> {
    static MAP: OnceLock<Mutex<HashMap<String, InflightCell>>> = OnceLock::new();
    MAP.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Coalesce concurrent fingerprint computes that share `key`. The first
/// caller runs the closure; later callers await the same result (success or
/// failure). Errors are shared via `Arc` since `FingerprintError` is not
/// `Clone`.
pub async fn coalesce<F, Fut>(key: String, factory: F) -> SharedResult
where
    F: FnOnce() -> Fut,
    Fut: std::future::Future<Output = Result<FingerprintResult, FingerprintError>>,
{
    let cell = {
        let mut map = inflight().lock().await;
        map.entry(key.clone())
            .or_insert_with(|| Arc::new(OnceCell::new()))
            .clone()
    };
    let result = cell
        .get_or_init(|| async { factory().await.map_err(Arc::new) })
        .await
        .clone();
    {
        let mut map = inflight().lock().await;
        if map
            .get(&key)
            .map(|stored| Arc::ptr_eq(stored, &cell))
            .unwrap_or(false)
        {
            map.remove(&key);
        }
    }
    result
}

// ── Helpers ────────────────────────────────────────────────────────────────────

fn io_other<E: std::fmt::Display>(error: E) -> FingerprintError {
    FingerprintError::Io(std::io::Error::new(
        std::io::ErrorKind::Other,
        error.to_string(),
    ))
}

async fn with_retry<T, F, Fut>(mut op: F) -> Result<T, FingerprintError>
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = Result<T, FingerprintError>>,
{
    let mut attempt = 0u32;
    loop {
        attempt += 1;
        match op().await {
            Ok(value) => return Ok(value),
            Err(error) if attempt < 3 && is_retryable(&error) => {
                let delay = Duration::from_millis(100u64 << (attempt - 1));
                tokio::time::sleep(delay).await;
            }
            Err(error) => return Err(error),
        }
    }
}

fn is_retryable(error: &FingerprintError) -> bool {
    match error {
        FingerprintError::Io(_) => true,
        FingerprintError::TruncatedRead { .. } | FingerprintError::InvalidHex(_) => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::file_fingerprint::fingerprint_from_samples;
    use std::io::Write;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
    use std::sync::Arc;
    use wiremock::matchers::{method, path as path_matcher};
    use wiremock::{Mock, MockServer, Request, Respond, ResponseTemplate};

    static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

    struct TempFile {
        path: PathBuf,
    }

    impl TempFile {
        fn create(contents: &[u8]) -> Self {
            let n = TEMP_COUNTER.fetch_add(1, Ordering::SeqCst);
            let path = std::env::temp_dir().join(format!(
                "shade-fpio-test-{}-{}.bin",
                std::process::id(),
                n
            ));
            let mut file = std::fs::File::create(&path).expect("create temp file");
            file.write_all(contents).expect("write temp file");
            file.sync_all().ok();
            Self { path }
        }
    }

    impl Drop for TempFile {
        fn drop(&mut self) {
            let _ = std::fs::remove_file(&self.path);
        }
    }

    fn deterministic_bytes(seed: u64, len: usize) -> Vec<u8> {
        let mut state = seed.wrapping_mul(0x9E37_79B9_7F4A_7C15).wrapping_add(1);
        let mut out = Vec::with_capacity(len);
        while out.len() < len {
            state = state
                .wrapping_mul(6_364_136_223_846_793_005)
                .wrapping_add(1_442_695_040_888_963_407);
            out.extend_from_slice(&state.to_le_bytes());
        }
        out.truncate(len);
        out
    }

    /// Wiremock responder that serves byte ranges from an in-memory buffer
    /// and counts how many ranged GETs it has handled.
    struct RangedFile {
        bytes: Arc<Vec<u8>>,
        get_count: Arc<AtomicUsize>,
    }

    impl Respond for RangedFile {
        fn respond(&self, request: &Request) -> ResponseTemplate {
            self.get_count.fetch_add(1, Ordering::SeqCst);
            let total = self.bytes.len();
            let range_header = request
                .headers
                .get("range")
                .and_then(|values| values.to_str().ok())
                .map(str::to_string);
            match range_header {
                Some(value) => {
                    let bytes_part = value.trim().strip_prefix("bytes=").unwrap_or("");
                    let mut parts = bytes_part.split('-');
                    let start: usize = parts.next().unwrap_or("0").parse().unwrap_or(0);
                    let end: usize = parts
                        .next()
                        .and_then(|v| v.parse().ok())
                        .unwrap_or(total - 1);
                    let end = end.min(total - 1);
                    if start > end || start >= total {
                        return ResponseTemplate::new(416);
                    }
                    let slice = self.bytes[start..=end].to_vec();
                    ResponseTemplate::new(206)
                        .insert_header("Content-Length", slice.len().to_string())
                        .insert_header(
                            "Content-Range",
                            format!("bytes {start}-{end}/{total}"),
                        )
                        .set_body_bytes(slice)
                }
                None => ResponseTemplate::new(200)
                    .insert_header("Content-Length", total.to_string())
                    .set_body_bytes(self.bytes.as_ref().clone()),
            }
        }
    }

    /// Wiremock responder that serves HEAD with a configurable header set
    /// and counts how many HEADs it has answered.
    struct HeadResponder {
        size: usize,
        etag: Option<String>,
        sse: Option<String>,
        head_count: Arc<AtomicUsize>,
    }

    impl Respond for HeadResponder {
        fn respond(&self, _request: &Request) -> ResponseTemplate {
            self.head_count.fetch_add(1, Ordering::SeqCst);
            let mut tmpl = ResponseTemplate::new(200)
                .insert_header("Content-Length", self.size.to_string());
            if let Some(etag) = &self.etag {
                tmpl = tmpl.insert_header("ETag", format!("\"{etag}\""));
            }
            if let Some(sse) = &self.sse {
                tmpl = tmpl.insert_header("x-amz-server-side-encryption", sse.as_str());
            }
            tmpl
        }
    }

    fn http_test_client() -> reqwest::Client {
        reqwest::Client::builder()
            .http1_only()
            .build()
            .expect("build test http client")
    }

    #[tokio::test]
    async fn local_async_matches_in_memory() {
        let bytes = deterministic_bytes(1, 200 * 1024);
        let temp = TempFile::create(&bytes);
        let local = fingerprint_local_async(temp.path.clone()).await.unwrap();

        let plan = sample_plan(local.size);
        let samples: Vec<(u64, &[u8])> = plan
            .iter()
            .map(|(offset, len)| {
                let s = *offset as usize;
                let e = s + *len as usize;
                (*offset, &bytes[s..e])
            })
            .collect();
        assert_eq!(
            local.fingerprint,
            fingerprint_from_samples(local.size, &samples)
        );
        assert_eq!(local.algo_version, ALGO_V1_SAMPLES);
    }

    #[tokio::test]
    async fn http_fingerprint_matches_in_memory() {
        let bytes = deterministic_bytes(2, 200 * 1024);
        let body = Arc::new(bytes.clone());
        let get_count = Arc::new(AtomicUsize::new(0));
        let head_count = Arc::new(AtomicUsize::new(0));

        let server = MockServer::start().await;
        Mock::given(method("HEAD"))
            .and(path_matcher("/object"))
            .respond_with(HeadResponder {
                size: bytes.len(),
                etag: None,
                sse: None,
                head_count: head_count.clone(),
            })
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path_matcher("/object"))
            .respond_with(RangedFile {
                bytes: body,
                get_count: get_count.clone(),
            })
            .mount(&server)
            .await;

        let url = format!("{}/object", server.uri());
        let client = http_test_client();
        let result = fingerprint_http(&client, &url, FingerprintHints::default())
            .await
            .unwrap();

        let plan = sample_plan(result.size);
        let samples: Vec<(u64, &[u8])> = plan
            .iter()
            .map(|(offset, len)| {
                let s = *offset as usize;
                let e = s + *len as usize;
                (*offset, &bytes[s..e])
            })
            .collect();
        assert_eq!(
            result.fingerprint,
            fingerprint_from_samples(result.size, &samples)
        );
        assert_eq!(result.algo_version, ALGO_V1_SAMPLES);
        assert_eq!(head_count.load(Ordering::SeqCst), 1);
        assert_eq!(get_count.load(Ordering::SeqCst), 4);
    }

    #[tokio::test]
    async fn http_fingerprint_with_full_hints_skips_head() {
        let bytes = deterministic_bytes(3, 200 * 1024);
        let body = Arc::new(bytes.clone());
        let get_count = Arc::new(AtomicUsize::new(0));
        let head_count = Arc::new(AtomicUsize::new(0));

        let server = MockServer::start().await;
        Mock::given(method("HEAD"))
            .and(path_matcher("/object"))
            .respond_with(HeadResponder {
                size: bytes.len(),
                etag: None,
                sse: None,
                head_count: head_count.clone(),
            })
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path_matcher("/object"))
            .respond_with(RangedFile {
                bytes: body,
                get_count: get_count.clone(),
            })
            .mount(&server)
            .await;

        let url = format!("{}/object", server.uri());
        let client = http_test_client();
        let hints = FingerprintHints {
            size: Some(bytes.len() as u64),
            ..Default::default()
        };
        let result = fingerprint_http(&client, &url, hints).await.unwrap();

        assert_eq!(result.size, bytes.len() as u64);
        assert_eq!(head_count.load(Ordering::SeqCst), 0);
        assert_eq!(get_count.load(Ordering::SeqCst), 4);
    }

    #[tokio::test]
    async fn http_truncated_response_returns_truncated_read() {
        // Mock that always returns 8 bytes regardless of requested range.
        let server = MockServer::start().await;
        Mock::given(method("HEAD"))
            .and(path_matcher("/short"))
            .respond_with(
                ResponseTemplate::new(200).insert_header("Content-Length", "200000"),
            )
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path_matcher("/short"))
            .respond_with(
                ResponseTemplate::new(206)
                    .insert_header("Content-Length", "8")
                    .set_body_bytes(vec![0u8; 8]),
            )
            .mount(&server)
            .await;

        let url = format!("{}/short", server.uri());
        let client = http_test_client();
        let result = fingerprint_http(&client, &url, FingerprintHints::default()).await;
        assert!(matches!(
            result,
            Err(FingerprintError::TruncatedRead { .. })
        ));
    }

    #[tokio::test]
    async fn etag_eligibility_helper() {
        assert!(etag_is_content_hash(None));
        assert!(etag_is_content_hash(Some("AES256")));
        assert!(etag_is_content_hash(Some("aes256")));
        assert!(!etag_is_content_hash(Some("aws:kms")));
        assert!(!etag_is_content_hash(Some("aws:kms:dsse")));
    }

    fn s3_test_config(server: &MockServer) -> S3LibraryConfig {
        S3LibraryConfig {
            id: "test".to_string(),
            name: None,
            endpoint: server.uri(),
            bucket: "mybucket".to_string(),
            region: "us-east-1".to_string(),
            access_key_id: "AKIAIOSFODNN7EXAMPLE".to_string(),
            secret_access_key: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY".to_string(),
            prefix: None,
        }
    }

    #[tokio::test]
    async fn s3_fast_path_uses_etag_when_eligible() {
        let bytes = deterministic_bytes(4, 200 * 1024);
        let body = Arc::new(bytes.clone());
        let get_count = Arc::new(AtomicUsize::new(0));
        let head_count = Arc::new(AtomicUsize::new(0));

        let server = MockServer::start().await;
        Mock::given(method("HEAD"))
            .and(path_matcher("/mybucket/mykey"))
            .respond_with(HeadResponder {
                size: bytes.len(),
                etag: Some("d41d8cd98f00b204e9800998ecf8427e".to_string()),
                sse: Some("AES256".to_string()),
                head_count: head_count.clone(),
            })
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path_matcher("/mybucket/mykey"))
            .respond_with(RangedFile {
                bytes: body,
                get_count: get_count.clone(),
            })
            .mount(&server)
            .await;

        let config = s3_test_config(&server);
        let result = fingerprint_s3(&config, "mykey", FingerprintHints::default())
            .await
            .unwrap();

        assert_eq!(result.algo_version, ALGO_V_S3_ETAG);
        assert_eq!(
            result.fingerprint,
            crate::file_fingerprint::fingerprint_from_s3_etag(
                bytes.len() as u64,
                "d41d8cd98f00b204e9800998ecf8427e"
            )
        );
        assert_eq!(head_count.load(Ordering::SeqCst), 1);
        assert_eq!(get_count.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn s3_sse_kms_falls_back_to_sample_scheme() {
        let bytes = deterministic_bytes(5, 200 * 1024);
        let body = Arc::new(bytes.clone());
        let get_count = Arc::new(AtomicUsize::new(0));
        let head_count = Arc::new(AtomicUsize::new(0));

        let server = MockServer::start().await;
        Mock::given(method("HEAD"))
            .and(path_matcher("/mybucket/mykey"))
            .respond_with(HeadResponder {
                size: bytes.len(),
                etag: Some("ignored-when-kms".to_string()),
                sse: Some("aws:kms".to_string()),
                head_count: head_count.clone(),
            })
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path_matcher("/mybucket/mykey"))
            .respond_with(RangedFile {
                bytes: body,
                get_count: get_count.clone(),
            })
            .mount(&server)
            .await;

        let config = s3_test_config(&server);
        let result = fingerprint_s3(&config, "mykey", FingerprintHints::default())
            .await
            .unwrap();

        assert_eq!(result.algo_version, ALGO_V1_SAMPLES);
        let plan = sample_plan(result.size);
        let samples: Vec<(u64, &[u8])> = plan
            .iter()
            .map(|(offset, len)| {
                let s = *offset as usize;
                let e = s + *len as usize;
                (*offset, &bytes[s..e])
            })
            .collect();
        assert_eq!(
            result.fingerprint,
            fingerprint_from_samples(result.size, &samples)
        );
        assert_eq!(head_count.load(Ordering::SeqCst), 1);
        assert_eq!(get_count.load(Ordering::SeqCst), 4);
    }

    #[tokio::test]
    async fn single_flight_coalesces_concurrent_calls() {
        let counter = Arc::new(AtomicUsize::new(0));
        let key = format!(
            "test://single-flight/{}",
            TEMP_COUNTER.fetch_add(1, Ordering::SeqCst)
        );

        let mut handles = Vec::new();
        for _ in 0..50 {
            let counter = counter.clone();
            let key = key.clone();
            handles.push(tokio::spawn(async move {
                coalesce(key, move || async move {
                    // Yield so all 50 callers are queued before the first compute completes.
                    tokio::time::sleep(Duration::from_millis(50)).await;
                    counter.fetch_add(1, Ordering::SeqCst);
                    Ok(FingerprintResult {
                        fingerprint: fingerprint_from_samples(0, &[]),
                        size: 0,
                        mtime_ms: None,
                        etag: None,
                        algo_version: ALGO_V1_SAMPLES,
                    })
                })
                .await
            }));
        }

        let mut results = Vec::new();
        for handle in handles {
            results.push(handle.await.unwrap().unwrap());
        }

        assert_eq!(counter.load(Ordering::SeqCst), 1);
        let first = results[0].fingerprint;
        for r in &results {
            assert_eq!(r.fingerprint, first);
        }
    }

    #[tokio::test]
    async fn single_flight_shares_errors() {
        let counter = Arc::new(AtomicUsize::new(0));
        let key = format!(
            "test://single-flight-err/{}",
            TEMP_COUNTER.fetch_add(1, Ordering::SeqCst)
        );

        let mut handles = Vec::new();
        for _ in 0..10 {
            let counter = counter.clone();
            let key = key.clone();
            handles.push(tokio::spawn(async move {
                coalesce(key, move || async move {
                    tokio::time::sleep(Duration::from_millis(20)).await;
                    counter.fetch_add(1, Ordering::SeqCst);
                    Err::<FingerprintResult, _>(FingerprintError::TruncatedRead {
                        offset: 0,
                        requested: 1,
                        got: 0,
                    })
                })
                .await
            }));
        }

        for handle in handles {
            let result = handle.await.unwrap();
            assert!(matches!(
                result.as_ref().map_err(|e| e.as_ref()),
                Err(FingerprintError::TruncatedRead { .. })
            ));
        }
        assert_eq!(counter.load(Ordering::SeqCst), 1);
    }
}
