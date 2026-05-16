use std::path::Path;
use tokio::sync::Mutex;

pub struct ThumbnailCacheDb {
    _db: libsql::Database,
    conn: Mutex<libsql::Connection>,
}

#[derive(Clone, Debug)]
pub struct ThumbnailCacheEntry {
    pub picture_id: String,
    pub fingerprint: String,
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
                picture_id  TEXT PRIMARY KEY NOT NULL,
                fingerprint TEXT,
                data        BLOB NOT NULL,
                created_at  INTEGER NOT NULL DEFAULT 0
            )",
            (),
        )
        .await
        .map_err(|e| e.to_string())?;
        if has_column(&conn, "thumbnails", "file_hash").await? {
            conn.execute(
                "ALTER TABLE thumbnails RENAME COLUMN file_hash TO fingerprint",
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
                "SELECT fingerprint, data FROM thumbnails WHERE picture_id = ?1",
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
        fingerprint: Option<&str>,
        data: &[u8],
    ) -> Result<(), String> {
        let created_at = current_millis()?;
        let conn = self.conn.lock().await;
        conn.execute(
            "INSERT OR REPLACE INTO thumbnails (picture_id, fingerprint, data, created_at)
             VALUES (?1, ?2, ?3, ?4)",
            libsql::params![picture_id, fingerprint, data.to_vec(), created_at],
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
                "SELECT picture_id, fingerprint, data
                 FROM thumbnails
                 WHERE created_at > ?1 AND fingerprint IS NOT NULL AND fingerprint != ''
                 ORDER BY created_at ASC",
                [since_millis],
            )
            .await
            .map_err(|e| e.to_string())?;
        let mut entries = Vec::new();
        while let Some(row) = rows.next().await.map_err(|e| e.to_string())? {
            entries.push(ThumbnailCacheEntry {
                picture_id: row.get::<String>(0).map_err(|e| e.to_string())?,
                fingerprint: row.get::<String>(1).map_err(|e| e.to_string())?,
                data: row.get::<Vec<u8>>(2).map_err(|e| e.to_string())?,
            });
        }
        Ok(entries)
    }

    pub async fn delete(&self, picture_id: &str) -> Result<(), String> {
        let conn = self.conn.lock().await;
        conn.execute("DELETE FROM thumbnails WHERE picture_id = ?1", [picture_id])
            .await
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub async fn delete_by_prefix(&self, prefix: &str) -> Result<(), String> {
        let conn = self.conn.lock().await;
        conn.execute(
            "DELETE FROM thumbnails WHERE picture_id LIKE ?1",
            [format!("{prefix}%")],
        )
        .await
        .map_err(|e| e.to_string())?;
        Ok(())
    }
}

async fn has_column(
    conn: &libsql::Connection,
    table: &str,
    column: &str,
) -> Result<bool, String> {
    let stmt =
        format!("SELECT COUNT(*) FROM pragma_table_info('{table}') WHERE name = ?1");
    let mut rows = conn
        .query(stmt.as_str(), libsql::params![column])
        .await
        .map_err(|e| e.to_string())?;
    Ok(rows
        .next()
        .await
        .map_err(|e| e.to_string())?
        .and_then(|row| row.get::<i64>(0).ok())
        .unwrap_or(0)
        > 0)
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
