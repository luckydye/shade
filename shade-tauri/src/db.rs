use std::sync::Arc;
use tokio::sync::Mutex as TokioMutex;
use crate::paths::{library_db_path, library_index_db_path, thumbnail_cache_db_path};


pub(crate) static LIBRARY_DB: tokio::sync::OnceCell<LibraryDb> = tokio::sync::OnceCell::const_new();
pub(crate) static LIBRARY_INDEX_DB: tokio::sync::OnceCell<Arc<shade_io::LibraryIndexDb>> =
    tokio::sync::OnceCell::const_new();
pub struct LibraryDb {
    pub(crate) _db: libsql::Database,
    pub(crate) conn: TokioMutex<libsql::Connection>,
}
pub(crate) async fn init_library_db() -> Result<LibraryDb, String> {
    let path = library_db_path()?;
    let parent = path
        .parent()
        .ok_or_else(|| format!("invalid library db path: {}", path.display()))?;
    std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let db = libsql::Builder::new_local(&path)
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
        "CREATE TABLE IF NOT EXISTS images (
            fingerprint TEXT PRIMARY KEY NOT NULL,
            source_name TEXT,
            created_at INTEGER NOT NULL
        )",
        (),
    )
    .await
    .map_err(|e| e.to_string())?;
    rename_file_hash_column(&conn, "images").await?;
    rename_file_hash_column(&conn, "edit_versions").await?;
    rename_file_hash_column(&conn, "media_ratings").await?;
    rename_file_hash_column(&conn, "media_tags").await?;
    rename_file_hash_column(&conn, "collection_items").await?;
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_images_source_name ON images(source_name)",
        (),
    )
    .await
    .map_err(|e| e.to_string())?;
    // Migrate from old integer-version schema to UUID-based schema if needed.
    let needs_migration = {
        let mut rows = conn
            .query(
                "SELECT COUNT(*) FROM pragma_table_info('edit_versions') WHERE name = 'version'",
                (),
            )
            .await
            .map_err(|e| e.to_string())?;
        let row = rows.next().await.map_err(|e| e.to_string())?;
        row.map(|r| r.get::<i64>(0).unwrap_or(0) > 0)
            .unwrap_or(false)
    };
    if needs_migration {
        conn.execute_batch(
            "BEGIN;
             ALTER TABLE edit_versions RENAME TO edit_versions_old;
             CREATE TABLE edit_versions (
                 id TEXT PRIMARY KEY NOT NULL,
                 fingerprint TEXT NOT NULL,
                 created_at INTEGER NOT NULL,
                 layers_json TEXT NOT NULL,
                 peer_origin TEXT,
                 FOREIGN KEY (fingerprint) REFERENCES images(fingerprint)
             );
             INSERT INTO edit_versions (id, fingerprint, created_at, layers_json, peer_origin)
                 SELECT lower(hex(randomblob(16))), fingerprint, created_at, layers_json, NULL
                 FROM edit_versions_old;
             DROP TABLE edit_versions_old;
             COMMIT;",
        )
        .await
        .map_err(|e| e.to_string())?;
    } else {
        conn.execute(
            "CREATE TABLE IF NOT EXISTS edit_versions (
                id TEXT PRIMARY KEY NOT NULL,
                fingerprint TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                layers_json TEXT NOT NULL,
                peer_origin TEXT,
                FOREIGN KEY (fingerprint) REFERENCES images(fingerprint)
            )",
            (),
        )
        .await
        .map_err(|e| e.to_string())?;
    }
    conn.execute(
        "CREATE TABLE IF NOT EXISTS media_ratings (
            fingerprint TEXT PRIMARY KEY NOT NULL,
            rating INTEGER NOT NULL CHECK(rating BETWEEN 1 AND 5),
            updated_at INTEGER NOT NULL
        )",
        (),
    )
    .await
    .map_err(|e| e.to_string())?;
    conn.execute(
        "CREATE TABLE IF NOT EXISTS media_tags (
            fingerprint TEXT NOT NULL,
            tag TEXT NOT NULL,
            updated_at INTEGER NOT NULL,
            PRIMARY KEY (fingerprint, tag)
        )",
        (),
    )
    .await
    .map_err(|e| e.to_string())?;
    if table_has_column(&conn, "media_ratings", "media_id").await? {
        conn.execute_batch(
            "BEGIN;
             ALTER TABLE media_ratings RENAME TO media_ratings_old;
             CREATE TABLE media_ratings (
                 fingerprint TEXT PRIMARY KEY NOT NULL,
                 rating INTEGER NOT NULL CHECK(rating BETWEEN 1 AND 5),
                 updated_at INTEGER NOT NULL
             );
             INSERT INTO media_ratings (fingerprint, rating, updated_at)
                 SELECT images.fingerprint, old.rating, old.updated_at
                 FROM media_ratings_old old
                 JOIN images ON images.source_name = old.media_id;
             DROP TABLE media_ratings_old;
             COMMIT;",
        )
        .await
        .map_err(|e| e.to_string())?;
    }
    if table_has_column(&conn, "media_tags", "media_id").await? {
        conn.execute_batch(
            "BEGIN;
             ALTER TABLE media_tags RENAME TO media_tags_old;
             CREATE TABLE media_tags (
                 fingerprint TEXT NOT NULL,
                 tag TEXT NOT NULL,
                 updated_at INTEGER NOT NULL,
                 PRIMARY KEY (fingerprint, tag)
             );
             INSERT INTO media_tags (fingerprint, tag, updated_at)
                 SELECT images.fingerprint, old.tag, old.updated_at
                 FROM media_tags_old old
                 JOIN images ON images.source_name = old.media_id;
             DROP TABLE media_tags_old;
             COMMIT;",
        )
        .await
        .map_err(|e| e.to_string())?;
    }
    shade_io::create_collections_tables(&conn).await?;
    Ok(LibraryDb {
        _db: db,
        conn: TokioMutex::new(conn),
    })
}
pub(crate) async fn library_db_conn() -> tokio::sync::MutexGuard<'static, libsql::Connection> {
    LIBRARY_DB
        .get()
        .expect("library db not initialized")
        .conn
        .lock()
        .await
}
pub async fn setup_library_db() -> Result<(), String> {
    let db = init_library_db().await?;
    LIBRARY_DB
        .set(db)
        .map_err(|_| "library db already initialized".to_string())
}
pub async fn setup_library_index_db() -> Result<Arc<shade_io::LibraryIndexDb>, String> {
    let path = library_index_db_path()?;
    let db = Arc::new(shade_io::LibraryIndexDb::open(&path).await?);
    LIBRARY_INDEX_DB
        .set(db.clone())
        .map_err(|_| "library index db already initialized".to_string())?;
    Ok(db)
}
pub(crate) fn library_index_db() -> &'static Arc<shade_io::LibraryIndexDb> {
    LIBRARY_INDEX_DB
        .get()
        .expect("library index db not initialized")
}
pub(crate) const SUPERSEDED_IMAGE_LOAD_ERROR: &str = "image load superseded by newer request";
pub async fn open_thumbnail_cache_db() -> Result<shade_io::ThumbnailCacheDb, String> {
    shade_io::ThumbnailCacheDb::open(&thumbnail_cache_db_path()?).await
}
/// One-shot rename of a legacy `file_hash` column to `fingerprint` on an
/// existing table. Idempotent — does nothing if the table doesn't exist
/// or already uses the new name.
pub(crate) async fn rename_file_hash_column(
    conn: &libsql::Connection,
    table: &str,
) -> Result<(), String> {
    if !table_has_column(conn, table, "file_hash").await? {
        return Ok(());
    }
    let stmt = format!("ALTER TABLE {table} RENAME COLUMN file_hash TO fingerprint");
    conn.execute(stmt.as_str(), ())
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}
pub(crate) async fn table_has_column(
    conn: &libsql::Connection,
    table: &str,
    column: &str,
) -> Result<bool, String> {
    let query =
        format!("SELECT COUNT(*) FROM pragma_table_info('{table}') WHERE name = ?1");
    let mut rows = conn
        .query(query.as_str(), libsql::params![column])
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
