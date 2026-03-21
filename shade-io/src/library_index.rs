use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

const IMAGE_EXTENSIONS: &[&str] = &[
    "jpg", "jpeg", "png", "tiff", "tif", "webp", "avif", "exr", "dng", "cr2", "cr3",
    "arw", "nef", "orf", "raf", "rw2", "3fr",
];

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct IndexedLibraryImage {
    pub path: String,
    pub name: String,
    pub modified_at: Option<u64>,
}

#[derive(Clone, Debug)]
pub struct PersistedLibraryIndex {
    pub indexed_at: u64,
    pub items: Vec<IndexedLibraryImage>,
}

fn library_index_root_path(root_path: &Path) -> Result<String, String> {
    root_path
        .to_str()
        .map(str::to_string)
        .ok_or_else(|| format!("non-utf8 path: {}", root_path.display()))
}

fn library_index_db_parent(db_path: &Path) -> Result<&Path, String> {
    db_path
        .parent()
        .ok_or_else(|| format!("invalid library index db path: {}", db_path.display()))
}

fn system_time_millis(value: std::time::SystemTime) -> Result<u64, String> {
    let duration = value
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|error| error.to_string())?;
    u64::try_from(duration.as_millis()).map_err(|error| error.to_string())
}

pub fn sort_indexed_library_items(items: &mut [IndexedLibraryImage]) {
    items.sort_by(|left, right| {
        right
            .modified_at
            .unwrap_or(0)
            .cmp(&left.modified_at.unwrap_or(0))
            .then_with(|| left.path.cmp(&right.path))
    });
}

async fn open_library_index_db(db_path: &Path) -> Result<libsql::Connection, String> {
    std::fs::create_dir_all(library_index_db_parent(db_path)?)
        .map_err(|error| error.to_string())?;
    let db = libsql::Builder::new_local(db_path)
        .build()
        .await
        .map_err(|error| error.to_string())?;
    let conn = db.connect().map_err(|error| error.to_string())?;
    conn.execute(
        "CREATE TABLE IF NOT EXISTS library_indexes (
            library_id TEXT PRIMARY KEY NOT NULL,
            root_path TEXT NOT NULL,
            indexed_at INTEGER NOT NULL
        )",
        (),
    )
    .await
    .map_err(|error| error.to_string())?;
    conn.execute(
        "CREATE TABLE IF NOT EXISTS library_index_items (
            library_id TEXT NOT NULL,
            path TEXT NOT NULL,
            name TEXT NOT NULL,
            modified_at INTEGER,
            PRIMARY KEY (library_id, path)
        )",
        (),
    )
    .await
    .map_err(|error| error.to_string())?;
    Ok(conn)
}

pub fn picture_display_name(picture_id: &str) -> String {
    if let Some(name) = Path::new(picture_id)
        .file_name()
        .and_then(|name| name.to_str())
    {
        return name.to_owned();
    }
    let short = if picture_id.len() <= 20 {
        picture_id.to_owned()
    } else {
        format!(
            "{}...{}",
            &picture_id[..8],
            &picture_id[picture_id.len() - 8..]
        )
    };
    format!("Photo {short}")
}

pub fn is_supported_library_image(path: &Path) -> bool {
    path.extension()
        .and_then(|ext| ext.to_str())
        .is_some_and(|ext| IMAGE_EXTENSIONS.contains(&ext.to_ascii_lowercase().as_str()))
}

pub fn indexed_library_image_for_path(
    path: &Path,
) -> Result<IndexedLibraryImage, String> {
    let path_string = path
        .to_str()
        .ok_or_else(|| format!("non-utf8 path: {}", path.display()))?
        .to_string();
    let modified_at = path
        .metadata()
        .map_err(|error| error.to_string())?
        .modified()
        .map_err(|error| error.to_string())?;
    Ok(IndexedLibraryImage {
        name: picture_display_name(&path_string),
        path: path_string,
        modified_at: Some(system_time_millis(modified_at)?),
    })
}

pub fn scan_directory_images(root: &Path) -> Result<Vec<IndexedLibraryImage>, String> {
    let mut items = Vec::new();
    let mut dirs = vec![root.to_path_buf()];
    while let Some(current_dir) = dirs.pop() {
        let entries =
            std::fs::read_dir(&current_dir).map_err(|error| error.to_string())?;
        for entry in entries {
            let entry = entry.map_err(|error| error.to_string())?;
            let path = entry.path();
            if path.is_dir() {
                dirs.push(path);
                continue;
            }
            if !path.is_file() || !is_supported_library_image(&path) {
                continue;
            }
            items.push(indexed_library_image_for_path(&path)?);
        }
    }
    sort_indexed_library_items(&mut items);
    Ok(items)
}

pub async fn load_persisted_library_index(
    db_path: &Path,
    library_id: &str,
    root_path: &Path,
) -> Result<Option<PersistedLibraryIndex>, String> {
    let conn = open_library_index_db(db_path).await?;
    let root_path = library_index_root_path(root_path)?;
    let mut metadata_rows = conn
        .query(
            "SELECT indexed_at
             FROM library_indexes
             WHERE library_id = ?1 AND root_path = ?2",
            libsql::params![library_id, root_path],
        )
        .await
        .map_err(|error| error.to_string())?;
    let Some(metadata_row) = metadata_rows
        .next()
        .await
        .map_err(|error| error.to_string())?
    else {
        return Ok(None);
    };
    let indexed_at = u64::try_from(
        metadata_row
            .get::<i64>(0)
            .map_err(|error| error.to_string())?,
    )
    .map_err(|error| error.to_string())?;
    let mut item_rows = conn
        .query(
            "SELECT path, name, modified_at
             FROM library_index_items
             WHERE library_id = ?1",
            [library_id],
        )
        .await
        .map_err(|error| error.to_string())?;
    let mut items = Vec::new();
    while let Some(row) = item_rows.next().await.map_err(|error| error.to_string())? {
        let modified_at = row
            .get::<Option<i64>>(2)
            .map_err(|error| error.to_string())?
            .map(u64::try_from)
            .transpose()
            .map_err(|error| error.to_string())?;
        items.push(IndexedLibraryImage {
            path: row.get::<String>(0).map_err(|error| error.to_string())?,
            name: row.get::<String>(1).map_err(|error| error.to_string())?,
            modified_at,
        });
    }
    sort_indexed_library_items(&mut items);
    Ok(Some(PersistedLibraryIndex { indexed_at, items }))
}

pub async fn has_persisted_library_index(
    db_path: &Path,
    library_id: &str,
    root_path: &Path,
) -> Result<bool, String> {
    let conn = open_library_index_db(db_path).await?;
    let root_path = library_index_root_path(root_path)?;
    let mut rows = conn
        .query(
            "SELECT 1
             FROM library_indexes
             WHERE library_id = ?1 AND root_path = ?2
             LIMIT 1",
            libsql::params![library_id, root_path],
        )
        .await
        .map_err(|error| error.to_string())?;
    Ok(rows
        .next()
        .await
        .map_err(|error| error.to_string())?
        .is_some())
}

pub async fn replace_persisted_library_index(
    db_path: &Path,
    library_id: &str,
    root_path: &Path,
    items: &[IndexedLibraryImage],
) -> Result<u64, String> {
    let conn = open_library_index_db(db_path).await?;
    let indexed_at_u64 = system_time_millis(std::time::SystemTime::now())?;
    let indexed_at = i64::try_from(indexed_at_u64).map_err(|error| error.to_string())?;
    let root_path = library_index_root_path(root_path)?;
    conn.execute("BEGIN IMMEDIATE", ())
        .await
        .map_err(|error| error.to_string())?;
    let result = async {
        conn.execute(
            "INSERT INTO library_indexes (library_id, root_path, indexed_at)
             VALUES (?1, ?2, ?3)
             ON CONFLICT(library_id)
             DO UPDATE SET root_path = excluded.root_path, indexed_at = excluded.indexed_at",
            libsql::params![library_id, root_path, indexed_at],
        )
        .await
        .map_err(|error| error.to_string())?;
        conn.execute(
            "DELETE FROM library_index_items WHERE library_id = ?1",
            [library_id],
        )
        .await
        .map_err(|error| error.to_string())?;
        for item in items {
            let modified_at = item
                .modified_at
                .map(i64::try_from)
                .transpose()
                .map_err(|error| error.to_string())?;
            conn.execute(
                "INSERT INTO library_index_items (library_id, path, name, modified_at)
                 VALUES (?1, ?2, ?3, ?4)",
                libsql::params![library_id, item.path.as_str(), item.name.as_str(), modified_at],
            )
            .await
            .map_err(|error| error.to_string())?;
        }
        Ok::<(), String>(())
    }
    .await;
    match result {
        Ok(()) => {
            conn.execute("COMMIT", ())
                .await
                .map_err(|error| error.to_string())?;
            Ok(indexed_at_u64)
        }
        Err(error) => {
            let _ = conn.execute("ROLLBACK", ()).await;
            Err(error)
        }
    }
}

pub async fn delete_persisted_library_index(
    db_path: &Path,
    library_id: &str,
) -> Result<(), String> {
    let conn = open_library_index_db(db_path).await?;
    conn.execute("BEGIN IMMEDIATE", ())
        .await
        .map_err(|error| error.to_string())?;
    let result = async {
        conn.execute(
            "DELETE FROM library_index_items WHERE library_id = ?1",
            [library_id],
        )
        .await
        .map_err(|error| error.to_string())?;
        conn.execute(
            "DELETE FROM library_indexes WHERE library_id = ?1",
            [library_id],
        )
        .await
        .map_err(|error| error.to_string())?;
        Ok::<(), String>(())
    }
    .await;
    match result {
        Ok(()) => {
            conn.execute("COMMIT", ())
                .await
                .map_err(|error| error.to_string())?;
            Ok(())
        }
        Err(error) => {
            let _ = conn.execute("ROLLBACK", ()).await;
            Err(error)
        }
    }
}

pub fn library_index_db_path(config_dir: &Path) -> PathBuf {
    config_dir.join("library-index.db")
}

#[cfg(test)]
mod tests {
    use super::{sort_indexed_library_items, IndexedLibraryImage};

    #[test]
    fn sorts_newest_images_first() {
        let mut items = vec![
            IndexedLibraryImage {
                path: "/tmp/older.jpg".into(),
                name: "older.jpg".into(),
                modified_at: Some(10),
            },
            IndexedLibraryImage {
                path: "/tmp/newer.jpg".into(),
                name: "newer.jpg".into(),
                modified_at: Some(20),
            },
            IndexedLibraryImage {
                path: "/tmp/unknown.jpg".into(),
                name: "unknown.jpg".into(),
                modified_at: None,
            },
        ];
        sort_indexed_library_items(&mut items);
        assert_eq!(items[0].path, "/tmp/newer.jpg");
        assert_eq!(items[1].path, "/tmp/older.jpg");
        assert_eq!(items[2].path, "/tmp/unknown.jpg");
    }
}
