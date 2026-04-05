use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Collection {
    pub id: String,
    pub library_id: String,
    pub name: String,
    pub position: i64,
    pub created_at: u64,
    pub item_count: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct CollectionItem {
    pub file_hash: String,
    pub position: i64,
    pub added_at: u64,
}

/// Create the collections tables on an already-open connection.
/// Called as part of the unified library DB setup.
pub async fn create_collections_tables(conn: &libsql::Connection) -> Result<(), String> {
    conn.execute(
        "CREATE TABLE IF NOT EXISTS collections (
            id TEXT PRIMARY KEY NOT NULL,
            library_id TEXT NOT NULL,
            name TEXT NOT NULL,
            position INTEGER NOT NULL DEFAULT 0,
            created_at INTEGER NOT NULL
        )",
        (),
    )
    .await
    .map_err(|e| e.to_string())?;
    conn.execute(
        "CREATE TABLE IF NOT EXISTS collection_items (
            collection_id TEXT NOT NULL,
            file_hash TEXT NOT NULL,
            position INTEGER NOT NULL DEFAULT 0,
            added_at INTEGER NOT NULL,
            PRIMARY KEY (collection_id, file_hash)
        )",
        (),
    )
    .await
    .map_err(|e| e.to_string())?;
    let mut columns = conn
        .query("PRAGMA table_info(collection_items)", ())
        .await
        .map_err(|e| e.to_string())?;
    let mut has_file_hash = false;
    while let Some(row) = columns.next().await.map_err(|e| e.to_string())? {
        if row.get::<String>(1).map_err(|e| e.to_string())? == "file_hash" {
            has_file_hash = true;
            break;
        }
    }
    if !has_file_hash {
        conn.execute_batch(
            "BEGIN;
             ALTER TABLE collection_items RENAME TO collection_items_old;
             CREATE TABLE collection_items (
                 collection_id TEXT NOT NULL,
                 file_hash TEXT NOT NULL,
                 position INTEGER NOT NULL DEFAULT 0,
                 added_at INTEGER NOT NULL,
                 PRIMARY KEY (collection_id, file_hash)
             );
             INSERT INTO collection_items (collection_id, file_hash, position, added_at)
                 SELECT old.collection_id, images.file_hash, old.position, old.added_at
                 FROM collection_items_old old
                 JOIN images ON images.source_name = old.image_path;
             DROP TABLE collection_items_old;
             COMMIT;",
        )
        .await
        .map_err(|e| e.to_string())?;
    }
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_collections_library ON collections(library_id)",
        (),
    )
    .await
    .map_err(|e| e.to_string())?;
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_collection_items_collection ON collection_items(collection_id)",
        (),
    )
    .await
    .map_err(|e| e.to_string())?;
    Ok(())
}

pub async fn list_collections(
    conn: &libsql::Connection,
    library_id: &str,
) -> Result<Vec<Collection>, String> {
    let mut rows = conn
        .query(
            "SELECT c.id, c.library_id, c.name, c.position, c.created_at,
                    (SELECT COUNT(*) FROM collection_items ci WHERE ci.collection_id = c.id) as item_count
             FROM collections c
             WHERE c.library_id = ?1
             ORDER BY c.position ASC, c.created_at ASC",
            [library_id],
        )
        .await
        .map_err(|e| e.to_string())?;
    let mut result = Vec::new();
    while let Some(row) = rows.next().await.map_err(|e| e.to_string())? {
        result.push(Collection {
            id: row.get::<String>(0).map_err(|e| e.to_string())?,
            library_id: row.get::<String>(1).map_err(|e| e.to_string())?,
            name: row.get::<String>(2).map_err(|e| e.to_string())?,
            position: row.get::<i64>(3).map_err(|e| e.to_string())?,
            created_at: row.get::<u64>(4).map_err(|e| e.to_string())?,
            item_count: row.get::<u64>(5).map_err(|e| e.to_string())?,
        });
    }
    Ok(result)
}

pub async fn create_collection(
    conn: &libsql::Connection,
    library_id: &str,
    name: &str,
) -> Result<Collection, String> {
    let id = uuid::Uuid::new_v4().to_string();
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_millis() as u64;
    let mut rows = conn
        .query(
            "SELECT COALESCE(MAX(position), -1) FROM collections WHERE library_id = ?1",
            [library_id],
        )
        .await
        .map_err(|e| e.to_string())?;
    let max_pos = match rows.next().await.map_err(|e| e.to_string())? {
        Some(row) => row.get::<i64>(0).map_err(|e| e.to_string())?,
        None => -1,
    };
    let position = max_pos + 1;
    conn.execute(
        "INSERT INTO collections (id, library_id, name, position, created_at) VALUES (?1, ?2, ?3, ?4, ?5)",
        libsql::params![id.clone(), library_id, name, position, now],
    )
    .await
    .map_err(|e| e.to_string())?;
    Ok(Collection {
        id,
        library_id: library_id.to_string(),
        name: name.to_string(),
        position,
        created_at: now,
        item_count: 0,
    })
}

pub async fn rename_collection(
    conn: &libsql::Connection,
    collection_id: &str,
    name: &str,
) -> Result<(), String> {
    conn.execute(
        "UPDATE collections SET name = ?1 WHERE id = ?2",
        libsql::params![name, collection_id],
    )
    .await
    .map_err(|e| e.to_string())?;
    Ok(())
}

pub async fn delete_collection(
    conn: &libsql::Connection,
    collection_id: &str,
) -> Result<(), String> {
    conn.execute("BEGIN IMMEDIATE", ())
        .await
        .map_err(|e| e.to_string())?;
    let result = async {
        conn.execute(
            "DELETE FROM collection_items WHERE collection_id = ?1",
            [collection_id],
        )
        .await
        .map_err(|e| e.to_string())?;
        conn.execute("DELETE FROM collections WHERE id = ?1", [collection_id])
            .await
            .map_err(|e| e.to_string())?;
        Ok::<(), String>(())
    }
    .await;
    match result {
        Ok(()) => {
            conn.execute("COMMIT", ())
                .await
                .map_err(|e| e.to_string())?;
            Ok(())
        }
        Err(e) => {
            let _ = conn.execute("ROLLBACK", ()).await;
            Err(e)
        }
    }
}

pub async fn reorder_collection(
    conn: &libsql::Connection,
    collection_id: &str,
    new_position: i64,
) -> Result<(), String> {
    conn.execute(
        "UPDATE collections SET position = ?1 WHERE id = ?2",
        libsql::params![new_position, collection_id],
    )
    .await
    .map_err(|e| e.to_string())?;
    Ok(())
}

pub async fn list_collection_items(
    conn: &libsql::Connection,
    collection_id: &str,
) -> Result<Vec<CollectionItem>, String> {
    let mut rows = conn
        .query(
            "SELECT file_hash, position, added_at FROM collection_items
             WHERE collection_id = ?1
             ORDER BY position ASC, added_at ASC",
            [collection_id],
        )
        .await
        .map_err(|e| e.to_string())?;
    let mut result = Vec::new();
    while let Some(row) = rows.next().await.map_err(|e| e.to_string())? {
        result.push(CollectionItem {
            file_hash: row.get::<String>(0).map_err(|e| e.to_string())?,
            position: row.get::<i64>(1).map_err(|e| e.to_string())?,
            added_at: row.get::<u64>(2).map_err(|e| e.to_string())?,
        });
    }
    Ok(result)
}

pub async fn add_collection_items(
    conn: &libsql::Connection,
    collection_id: &str,
    file_hashes: Vec<String>,
) -> Result<(), String> {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_millis() as u64;
    let mut rows = conn
        .query(
            "SELECT COALESCE(MAX(position), -1) FROM collection_items WHERE collection_id = ?1",
            [collection_id],
        )
        .await
        .map_err(|e| e.to_string())?;
    let mut pos = match rows.next().await.map_err(|e| e.to_string())? {
        Some(row) => row.get::<i64>(0).map_err(|e| e.to_string())?,
        None => -1,
    };
    conn.execute("BEGIN IMMEDIATE", ())
        .await
        .map_err(|e| e.to_string())?;
    let result = async {
        for file_hash in &file_hashes {
            pos += 1;
            conn.execute(
                "INSERT OR IGNORE INTO collection_items (collection_id, file_hash, position, added_at)
                 VALUES (?1, ?2, ?3, ?4)",
                libsql::params![collection_id, file_hash.as_str(), pos, now],
            )
            .await
            .map_err(|e| e.to_string())?;
        }
        Ok::<(), String>(())
    }
    .await;
    match result {
        Ok(()) => {
            conn.execute("COMMIT", ())
                .await
                .map_err(|e| e.to_string())?;
            Ok(())
        }
        Err(e) => {
            let _ = conn.execute("ROLLBACK", ()).await;
            Err(e)
        }
    }
}

pub async fn remove_collection_items(
    conn: &libsql::Connection,
    collection_id: &str,
    file_hashes: Vec<String>,
) -> Result<(), String> {
    conn.execute("BEGIN IMMEDIATE", ())
        .await
        .map_err(|e| e.to_string())?;
    let result = async {
        for file_hash in &file_hashes {
            conn.execute(
                "DELETE FROM collection_items WHERE collection_id = ?1 AND file_hash = ?2",
                libsql::params![collection_id, file_hash.as_str()],
            )
            .await
            .map_err(|e| e.to_string())?;
        }
        Ok::<(), String>(())
    }
    .await;
    match result {
        Ok(()) => {
            conn.execute("COMMIT", ())
                .await
                .map_err(|e| e.to_string())?;
            Ok(())
        }
        Err(e) => {
            let _ = conn.execute("ROLLBACK", ()).await;
            Err(e)
        }
    }
}
