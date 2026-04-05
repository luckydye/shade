use serde::{Deserialize, Serialize};
use std::path::Path;

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
    pub image_path: String,
    pub position: i64,
    pub added_at: u64,
}

pub async fn open_collections_db(db_path: &Path) -> Result<libsql::Connection, String> {
    let parent = db_path
        .parent()
        .ok_or_else(|| format!("invalid collections db path: {}", db_path.display()))?;
    std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let db = libsql::Builder::new_local(db_path)
        .build()
        .await
        .map_err(|e| e.to_string())?;
    let conn = db.connect().map_err(|e| e.to_string())?;
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
            image_path TEXT NOT NULL,
            position INTEGER NOT NULL DEFAULT 0,
            added_at INTEGER NOT NULL,
            PRIMARY KEY (collection_id, image_path)
        )",
        (),
    )
    .await
    .map_err(|e| e.to_string())?;
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
    Ok(conn)
}

pub async fn list_collections(
    db_path: &Path,
    library_id: &str,
) -> Result<Vec<Collection>, String> {
    let conn = open_collections_db(db_path).await?;
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
    db_path: &Path,
    library_id: &str,
    name: &str,
) -> Result<Collection, String> {
    let conn = open_collections_db(db_path).await?;
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
    db_path: &Path,
    collection_id: &str,
    name: &str,
) -> Result<(), String> {
    let conn = open_collections_db(db_path).await?;
    conn.execute(
        "UPDATE collections SET name = ?1 WHERE id = ?2",
        libsql::params![name, collection_id],
    )
    .await
    .map_err(|e| e.to_string())?;
    Ok(())
}

pub async fn delete_collection(db_path: &Path, collection_id: &str) -> Result<(), String> {
    let conn = open_collections_db(db_path).await?;
    conn.execute("BEGIN IMMEDIATE", ()).await.map_err(|e| e.to_string())?;
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
            conn.execute("COMMIT", ()).await.map_err(|e| e.to_string())?;
            Ok(())
        }
        Err(e) => {
            let _ = conn.execute("ROLLBACK", ()).await;
            Err(e)
        }
    }
}

pub async fn reorder_collection(
    db_path: &Path,
    collection_id: &str,
    new_position: i64,
) -> Result<(), String> {
    let conn = open_collections_db(db_path).await?;
    conn.execute(
        "UPDATE collections SET position = ?1 WHERE id = ?2",
        libsql::params![new_position, collection_id],
    )
    .await
    .map_err(|e| e.to_string())?;
    Ok(())
}

pub async fn list_collection_items(
    db_path: &Path,
    collection_id: &str,
) -> Result<Vec<CollectionItem>, String> {
    let conn = open_collections_db(db_path).await?;
    let mut rows = conn
        .query(
            "SELECT image_path, position, added_at FROM collection_items
             WHERE collection_id = ?1
             ORDER BY position ASC, added_at ASC",
            [collection_id],
        )
        .await
        .map_err(|e| e.to_string())?;
    let mut result = Vec::new();
    while let Some(row) = rows.next().await.map_err(|e| e.to_string())? {
        result.push(CollectionItem {
            image_path: row.get::<String>(0).map_err(|e| e.to_string())?,
            position: row.get::<i64>(1).map_err(|e| e.to_string())?,
            added_at: row.get::<u64>(2).map_err(|e| e.to_string())?,
        });
    }
    Ok(result)
}

pub async fn add_collection_items(
    db_path: &Path,
    collection_id: &str,
    image_paths: Vec<String>,
) -> Result<(), String> {
    let conn = open_collections_db(db_path).await?;
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
    conn.execute("BEGIN IMMEDIATE", ()).await.map_err(|e| e.to_string())?;
    let result = async {
        for path in &image_paths {
            pos += 1;
            conn.execute(
                "INSERT OR IGNORE INTO collection_items (collection_id, image_path, position, added_at)
                 VALUES (?1, ?2, ?3, ?4)",
                libsql::params![collection_id, path.as_str(), pos, now],
            )
            .await
            .map_err(|e| e.to_string())?;
        }
        Ok::<(), String>(())
    }
    .await;
    match result {
        Ok(()) => {
            conn.execute("COMMIT", ()).await.map_err(|e| e.to_string())?;
            Ok(())
        }
        Err(e) => {
            let _ = conn.execute("ROLLBACK", ()).await;
            Err(e)
        }
    }
}

pub async fn remove_collection_items(
    db_path: &Path,
    collection_id: &str,
    image_paths: Vec<String>,
) -> Result<(), String> {
    let conn = open_collections_db(db_path).await?;
    conn.execute("BEGIN IMMEDIATE", ()).await.map_err(|e| e.to_string())?;
    let result = async {
        for path in &image_paths {
            conn.execute(
                "DELETE FROM collection_items WHERE collection_id = ?1 AND image_path = ?2",
                libsql::params![collection_id, path.as_str()],
            )
            .await
            .map_err(|e| e.to_string())?;
        }
        Ok::<(), String>(())
    }
    .await;
    match result {
        Ok(()) => {
            conn.execute("COMMIT", ()).await.map_err(|e| e.to_string())?;
            Ok(())
        }
        Err(e) => {
            let _ = conn.execute("ROLLBACK", ()).await;
            Err(e)
        }
    }
}
