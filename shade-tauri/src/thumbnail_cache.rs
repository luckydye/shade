use std::path::Path;
use tokio::sync::Mutex;

pub struct ThumbnailCacheDb(Mutex<libsql::Connection>);

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
        conn.execute(
            "CREATE TABLE IF NOT EXISTS thumbnails (
                picture_id TEXT PRIMARY KEY NOT NULL,
                data BLOB NOT NULL
            )",
            (),
        )
        .await
        .map_err(|e| e.to_string())?;
        Ok(Self(Mutex::new(conn)))
    }

    pub async fn get(&self, picture_id: &str) -> Result<Option<Vec<u8>>, String> {
        let conn = self.0.lock().await;
        let mut rows = conn
            .query(
                "SELECT data FROM thumbnails WHERE picture_id = ?1",
                [picture_id],
            )
            .await
            .map_err(|e| e.to_string())?;
        match rows.next().await.map_err(|e| e.to_string())? {
            Some(row) => Ok(Some(row.get(0).map_err(|e| e.to_string())?)),
            None => Ok(None),
        }
    }

    pub async fn put(&self, picture_id: &str, data: &[u8]) -> Result<(), String> {
        let conn = self.0.lock().await;
        conn.execute(
            "INSERT OR REPLACE INTO thumbnails (picture_id, data) VALUES (?1, ?2)",
            libsql::params![picture_id, data.to_vec()],
        )
        .await
        .map_err(|e| e.to_string())?;
        Ok(())
    }
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
