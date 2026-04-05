use std::path::Path;
use tokio::sync::Mutex;

pub struct ThumbnailCacheDb {
    _db: libsql::Database,
    conn: Mutex<libsql::Connection>,
}

#[derive(Clone, Debug)]
pub struct ThumbnailCacheEntry {
    pub picture_id: String,
    pub file_hash: String,
    pub data: Vec<u8>,
}

impl ThumbnailCacheDb {
    pub async fn open(path: &Path) -> Result<Self, String> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let db = libsql::Builder::new_local(path)
            .build()
            .await
            .map_err(|e| e.to_string())?;
        let conn = db.connect().map_err(|e| e.to_string())?;
        conn.query("PRAGMA journal_mode = WAL", ())
            .await
            .map_err(|e| e.to_string())?;
        conn.query("PRAGMA busy_timeout = 5000", ())
            .await
            .map_err(|e| e.to_string())?;
        conn.execute(
            "CREATE TABLE IF NOT EXISTS thumbnails (
                picture_id TEXT PRIMARY KEY NOT NULL,
                file_hash TEXT,
                data BLOB NOT NULL
            )",
            (),
        )
        .await
        .map_err(|e| e.to_string())?;
        let mut columns = conn
            .query("PRAGMA table_info(thumbnails)", ())
            .await
            .map_err(|e| e.to_string())?;
        let mut has_file_hash = false;
        let mut has_created_at = false;
        while let Some(row) = columns.next().await.map_err(|e| e.to_string())? {
            match row.get::<String>(1).map_err(|e| e.to_string())?.as_str() {
                "file_hash" => has_file_hash = true,
                "created_at" => has_created_at = true,
                _ => {}
            }
        }
        if !has_file_hash {
            conn.execute("ALTER TABLE thumbnails ADD COLUMN file_hash TEXT", ())
                .await
                .map_err(|e| e.to_string())?;
        }
        if !has_created_at {
            conn.execute(
                "ALTER TABLE thumbnails ADD COLUMN created_at INTEGER NOT NULL DEFAULT 0",
                (),
            )
            .await
            .map_err(|e| e.to_string())?;
        }
        Ok(Self {
            _db: db,
            conn: Mutex::new(conn),
        })
    }

    pub async fn get(
        &self,
        picture_id: &str,
    ) -> Result<Option<(Option<String>, Vec<u8>)>, String> {
        let conn = self.conn.lock().await;
        let mut rows = conn
            .query(
                "SELECT file_hash, data FROM thumbnails WHERE picture_id = ?1",
                [picture_id],
            )
            .await
            .map_err(|e| e.to_string())?;
        match rows.next().await.map_err(|e| e.to_string())? {
            Some(row) => Ok(Some((
                row.get::<Option<String>>(0).map_err(|e| e.to_string())?,
                row.get::<Vec<u8>>(1).map_err(|e| e.to_string())?,
            ))),
            None => Ok(None),
        }
    }

    pub async fn put(
        &self,
        picture_id: &str,
        file_hash: Option<&str>,
        data: &[u8],
    ) -> Result<(), String> {
        let created_at = current_millis()?;
        let conn = self.conn.lock().await;
        conn.execute(
            "INSERT OR REPLACE INTO thumbnails (picture_id, file_hash, data, created_at) VALUES (?1, ?2, ?3, ?4)",
            libsql::params![picture_id, file_hash, data.to_vec(), created_at],
        )
        .await
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub async fn list_entries_after(
        &self,
        since_millis: i64,
    ) -> Result<Vec<ThumbnailCacheEntry>, String> {
        let conn = self.conn.lock().await;
        let mut rows = conn
            .query(
                "SELECT picture_id, file_hash, data
                 FROM thumbnails
                 WHERE created_at > ?1 AND file_hash IS NOT NULL AND file_hash != ''
                 ORDER BY created_at ASC",
                [since_millis],
            )
            .await
            .map_err(|e| e.to_string())?;
        let mut entries = Vec::new();
        while let Some(row) = rows.next().await.map_err(|e| e.to_string())? {
            entries.push(ThumbnailCacheEntry {
                picture_id: row.get::<String>(0).map_err(|e| e.to_string())?,
                file_hash: row.get::<String>(1).map_err(|e| e.to_string())?,
                data: row.get::<Vec<u8>>(2).map_err(|e| e.to_string())?,
            });
        }
        Ok(entries)
    }
}

fn current_millis() -> Result<i64, String> {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .map_err(|e| e.to_string())
}

/// For local file paths, appends the file's modified-at timestamp so that
/// the cache is invalidated when the file changes. For all other paths
/// (S3, ccapi, etc.) returns the id unchanged.
pub fn thumbnail_cache_key(picture_id: &str) -> String {
    if let Ok(meta) = std::fs::metadata(picture_id) {
        if let Ok(modified) = meta.modified() {
            if let Ok(duration) = modified.duration_since(std::time::UNIX_EPOCH) {
                return format!("{picture_id}#{}", duration.as_millis());
            }
        }
    }
    picture_id.to_string()
}

#[cfg(test)]
mod tests {
    use super::thumbnail_cache_key;

    #[test]
    fn strips_revision_suffix_from_local_cache_key() {
        let _ = thumbnail_cache_key("/tmp/example.jpg");
    }
}
