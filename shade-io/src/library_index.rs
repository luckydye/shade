use quick_xml::events::Event;
use quick_xml::Reader;
use serde::{Deserialize, Serialize};
use std::io::Cursor;
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
    pub rating: Option<u8>,
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

pub fn library_index_root_key(root: &str) -> Result<String, String> {
    let trimmed = root.trim();
    if trimmed.is_empty() {
        return Err("library index root cannot be empty".to_string());
    }
    Ok(trimmed.to_string())
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
    conn.execute("PRAGMA journal_mode = WAL", ())
        .await
        .map_err(|error| error.to_string())?;
    conn.execute("PRAGMA busy_timeout = 5000", ())
        .await
        .map_err(|error| error.to_string())?;
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
            rating INTEGER,
            PRIMARY KEY (library_id, path)
        )",
        (),
    )
    .await
    .map_err(|error| error.to_string())?;
    let mut columns = conn
        .query("PRAGMA table_info(library_index_items)", ())
        .await
        .map_err(|error| error.to_string())?;
    let mut has_rating = false;
    while let Some(row) = columns.next().await.map_err(|error| error.to_string())? {
        if row.get::<String>(1).map_err(|error| error.to_string())? == "rating" {
            has_rating = true;
            break;
        }
    }
    if !has_rating {
        conn.execute(
            "ALTER TABLE library_index_items ADD COLUMN rating INTEGER",
            (),
        )
        .await
        .map_err(|error| error.to_string())?;
    }
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

pub fn normalize_rating(value: &str) -> Result<Option<u8>, String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }
    let parsed = trimmed
        .parse::<i16>()
        .map_err(|error| format!("invalid rating `{trimmed}`: {error}"))?;
    if matches!(parsed, -1 | 0) {
        return Ok(None);
    }
    if (1..=5).contains(&parsed) {
        return Ok(Some(parsed as u8));
    }
    Err(format!("rating out of range: {parsed}"))
}

pub fn xmp_name_is_rating(name: &[u8]) -> bool {
    name == b"Rating" || name.ends_with(b":Rating")
}

pub fn parse_xmp_rating(xmp: &[u8]) -> Result<Option<u8>, String> {
    let mut reader = Reader::from_reader(Cursor::new(xmp));
    reader.config_mut().trim_text(true);
    let mut buf = Vec::new();
    let mut in_rating_element = false;
    loop {
        match reader
            .read_event_into(&mut buf)
            .map_err(|error| format!("invalid XMP: {error}"))?
        {
            Event::Start(event) => {
                if xmp_name_is_rating(event.name().as_ref()) {
                    in_rating_element = true;
                }
                for attribute in event.attributes() {
                    let attribute = attribute
                        .map_err(|error| format!("invalid XMP attribute: {error}"))?;
                    if !xmp_name_is_rating(attribute.key.as_ref()) {
                        continue;
                    }
                    let value = attribute
                        .decode_and_unescape_value(reader.decoder())
                        .map_err(|error| format!("invalid XMP rating: {error}"))?;
                    return normalize_rating(value.as_ref());
                }
            }
            Event::Empty(event) => {
                for attribute in event.attributes() {
                    let attribute = attribute
                        .map_err(|error| format!("invalid XMP attribute: {error}"))?;
                    if !xmp_name_is_rating(attribute.key.as_ref()) {
                        continue;
                    }
                    let value = attribute
                        .decode_and_unescape_value(reader.decoder())
                        .map_err(|error| format!("invalid XMP rating: {error}"))?;
                    return normalize_rating(value.as_ref());
                }
            }
            Event::Text(event) => {
                if in_rating_element {
                    let value = event
                        .decode()
                        .map_err(|error| format!("invalid XMP rating: {error}"))?;
                    return normalize_rating(value.as_ref());
                }
            }
            Event::End(event) => {
                if xmp_name_is_rating(event.name().as_ref()) {
                    in_rating_element = false;
                }
            }
            Event::Eof => return Ok(None),
            _ => {}
        }
        buf.clear();
    }
}

pub fn file_bytes_xmp_rating(bytes: &[u8]) -> Result<Option<u8>, String> {
    let start = bytes
        .windows(b"<x:xmpmeta".len())
        .position(|window| window == b"<x:xmpmeta")
        .or_else(|| {
            bytes
                .windows(b"<xmpmeta".len())
                .position(|window| window == b"<xmpmeta")
        });
    let Some(start) = start else {
        return Ok(None);
    };
    let end = bytes[start..]
        .windows(b"</x:xmpmeta>".len())
        .position(|window| window == b"</x:xmpmeta>")
        .map(|index| start + index + b"</x:xmpmeta>".len())
        .or_else(|| {
            bytes[start..]
                .windows(b"</xmpmeta>".len())
                .position(|window| window == b"</xmpmeta>")
                .map(|index| start + index + b"</xmpmeta>".len())
        })
        .ok_or_else(|| "unterminated XMP packet".to_string())?;
    parse_xmp_rating(&bytes[start..end])
}

pub fn image_file_may_embed_xmp(path: &Path) -> bool {
    let Some(extension) = path.extension().and_then(|value| value.to_str()) else {
        return false;
    };
    matches!(
        extension.to_ascii_lowercase().as_str(),
        "jpg" | "jpeg" | "png" | "tif" | "tiff" | "webp" | "avif"
    )
}

pub fn rating_for_image_path(path: &Path) -> Result<Option<u8>, String> {
    let sidecar_path = path.with_extension("xmp");
    if sidecar_path.is_file() {
        return parse_xmp_rating(&std::fs::read(&sidecar_path).map_err(|error| {
            format!(
                "failed to read XMP sidecar {}: {error}",
                sidecar_path.display()
            )
        })?);
    }
    if !image_file_may_embed_xmp(path) {
        return Ok(None);
    }
    file_bytes_xmp_rating(
        &std::fs::read(path).map_err(|error| {
            format!("failed to read image {}: {error}", path.display())
        })?,
    )
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
        rating: rating_for_image_path(path)?,
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
    load_persisted_library_index_by_root(
        db_path,
        library_id,
        &library_index_root_path(root_path)?,
    )
    .await
}

pub async fn load_persisted_library_index_by_root(
    db_path: &Path,
    library_id: &str,
    root: &str,
) -> Result<Option<PersistedLibraryIndex>, String> {
    let conn = open_library_index_db(db_path).await?;
    let root = library_index_root_key(root)?;
    let mut metadata_rows = conn
        .query(
            "SELECT indexed_at
             FROM library_indexes
             WHERE library_id = ?1 AND root_path = ?2",
            libsql::params![library_id, root],
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
            "SELECT path, name, modified_at, rating
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
        let rating = row
            .get::<Option<i64>>(3)
            .map_err(|error| error.to_string())?
            .map(u8::try_from)
            .transpose()
            .map_err(|error| error.to_string())?;
        items.push(IndexedLibraryImage {
            path: row.get::<String>(0).map_err(|error| error.to_string())?,
            name: row.get::<String>(1).map_err(|error| error.to_string())?,
            modified_at,
            rating,
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
    has_persisted_library_index_by_root(
        db_path,
        library_id,
        &library_index_root_path(root_path)?,
    )
    .await
}

pub async fn has_persisted_library_index_by_root(
    db_path: &Path,
    library_id: &str,
    root: &str,
) -> Result<bool, String> {
    let conn = open_library_index_db(db_path).await?;
    let root = library_index_root_key(root)?;
    let mut rows = conn
        .query(
            "SELECT 1
             FROM library_indexes
             WHERE library_id = ?1 AND root_path = ?2
             LIMIT 1",
            libsql::params![library_id, root],
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
    replace_persisted_library_index_by_root(
        db_path,
        library_id,
        &library_index_root_path(root_path)?,
        items,
    )
    .await
}

pub async fn replace_persisted_library_index_by_root(
    db_path: &Path,
    library_id: &str,
    root: &str,
    items: &[IndexedLibraryImage],
) -> Result<u64, String> {
    let conn = open_library_index_db(db_path).await?;
    let indexed_at_u64 = system_time_millis(std::time::SystemTime::now())?;
    let indexed_at = i64::try_from(indexed_at_u64).map_err(|error| error.to_string())?;
    let root = library_index_root_key(root)?;
    conn.execute("BEGIN IMMEDIATE", ())
        .await
        .map_err(|error| error.to_string())?;
    let result = async {
        conn.execute(
            "INSERT INTO library_indexes (library_id, root_path, indexed_at)
             VALUES (?1, ?2, ?3)
             ON CONFLICT(library_id)
             DO UPDATE SET root_path = excluded.root_path, indexed_at = excluded.indexed_at",
            libsql::params![library_id, root, indexed_at],
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
            let rating = item.rating.map(i64::from);
            conn.execute(
                "INSERT INTO library_index_items (library_id, path, name, modified_at, rating)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                libsql::params![
                    library_id,
                    item.path.as_str(),
                    item.name.as_str(),
                    modified_at,
                    rating
                ],
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
    use super::{
        normalize_rating, parse_xmp_rating, sort_indexed_library_items,
        IndexedLibraryImage,
    };

    #[test]
    fn sorts_newest_images_first() {
        let mut items = vec![
            IndexedLibraryImage {
                path: "/tmp/older.jpg".into(),
                name: "older.jpg".into(),
                modified_at: Some(10),
                rating: None,
            },
            IndexedLibraryImage {
                path: "/tmp/newer.jpg".into(),
                name: "newer.jpg".into(),
                modified_at: Some(20),
                rating: Some(5),
            },
            IndexedLibraryImage {
                path: "/tmp/unknown.jpg".into(),
                name: "unknown.jpg".into(),
                modified_at: None,
                rating: None,
            },
        ];
        sort_indexed_library_items(&mut items);
        assert_eq!(items[0].path, "/tmp/newer.jpg");
        assert_eq!(items[1].path, "/tmp/older.jpg");
        assert_eq!(items[2].path, "/tmp/unknown.jpg");
    }

    #[test]
    fn parses_rating_values() {
        assert_eq!(normalize_rating("5").unwrap(), Some(5));
        assert_eq!(normalize_rating("0").unwrap(), None);
        assert_eq!(normalize_rating("-1").unwrap(), None);
    }

    #[test]
    fn reads_rating_from_xmp_attribute() {
        let rating = parse_xmp_rating(
            br#"<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:xmp="http://ns.adobe.com/xap/1.0/" xmp:Rating="4" /></rdf:RDF></x:xmpmeta>"#,
        )
        .unwrap();
        assert_eq!(rating, Some(4));
    }

    #[test]
    fn reads_rating_from_xmp_element() {
        let rating = parse_xmp_rating(
            br#"<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:xmp="http://ns.adobe.com/xap/1.0/"><xmp:Rating>3</xmp:Rating></rdf:Description></rdf:RDF></x:xmpmeta>"#,
        )
        .unwrap();
        assert_eq!(rating, Some(3));
    }
}
