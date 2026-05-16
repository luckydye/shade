use crate::db::library_db_conn;
use std::collections::HashMap;

pub(crate) fn unix_timestamp_millis() -> Result<i64, String> {
    let duration = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| e.to_string())?;
    i64::try_from(duration.as_millis()).map_err(|e| e.to_string())
}
pub(crate) fn validate_media_rating(rating: Option<u8>) -> Result<Option<u8>, String> {
    match rating {
        Some(value) if (1..=5).contains(&value) => Ok(Some(value)),
        Some(value) => Err(format!("rating out of range: {value}")),
        None => Ok(None),
    }
}
pub(crate) fn normalize_media_tags(tags: &[String]) -> Vec<String> {
    let mut normalized = tags
        .iter()
        .map(|tag| tag.trim())
        .filter(|tag| !tag.is_empty())
        .map(str::to_string)
        .collect::<Vec<_>>();
    normalized.sort();
    normalized.dedup();
    normalized
}
pub(crate) async fn load_media_ratings_map(
    fingerprints: &[String],
) -> Result<HashMap<String, u8>, String> {
    if fingerprints.is_empty() {
        return Ok(HashMap::new());
    }
    let requested_hashes = fingerprints
        .iter()
        .cloned()
        .collect::<std::collections::HashSet<_>>();
    let conn = library_db_conn().await;
    let mut rows = conn
        .query("SELECT fingerprint, rating FROM media_ratings", ())
        .await
        .map_err(|error| error.to_string())?;
    let mut ratings = HashMap::new();
    while let Some(row) = rows.next().await.map_err(|error| error.to_string())? {
        let fingerprint = row.get::<String>(0).map_err(|error| error.to_string())?;
        if !requested_hashes.contains(&fingerprint) {
            continue;
        }
        let rating = row
            .get::<i64>(1)
            .map_err(|error| error.to_string())
            .and_then(|value| u8::try_from(value).map_err(|error| error.to_string()))?;
        ratings.insert(fingerprint, rating);
    }
    Ok(ratings)
}
pub(crate) async fn load_media_tags_map(
    fingerprints: &[String],
) -> Result<HashMap<String, Vec<String>>, String> {
    if fingerprints.is_empty() {
        return Ok(HashMap::new());
    }
    let requested_hashes = fingerprints
        .iter()
        .cloned()
        .collect::<std::collections::HashSet<_>>();
    let conn = library_db_conn().await;
    let mut rows = conn
        .query(
            "SELECT fingerprint, tag FROM media_tags ORDER BY tag ASC",
            (),
        )
        .await
        .map_err(|error| error.to_string())?;
    let mut tags = HashMap::<String, Vec<String>>::new();
    while let Some(row) = rows.next().await.map_err(|error| error.to_string())? {
        let fingerprint = row.get::<String>(0).map_err(|error| error.to_string())?;
        if !requested_hashes.contains(&fingerprint) {
            continue;
        }
        let tag = row.get::<String>(1).map_err(|error| error.to_string())?;
        if tag.is_empty() {
            continue;
        }
        tags.entry(fingerprint).or_default().push(tag);
    }
    Ok(tags)
}
pub(crate) async fn persist_media_rating(
    fingerprint: &str,
    rating: Option<u8>,
) -> Result<(), String> {
    let normalized = validate_media_rating(rating)?;
    let conn = library_db_conn().await;
    if let Some(value) = normalized {
        conn.execute(
            "INSERT INTO media_ratings (fingerprint, rating, updated_at)
             VALUES (?1, ?2, ?3)
             ON CONFLICT(fingerprint)
             DO UPDATE SET rating = excluded.rating, updated_at = excluded.updated_at",
            libsql::params![fingerprint, i64::from(value), unix_timestamp_millis()?],
        )
        .await
        .map_err(|error| error.to_string())?;
        return Ok(());
    }
    conn.execute(
        "DELETE FROM media_ratings WHERE fingerprint = ?1",
        [fingerprint],
    )
    .await
    .map_err(|error| error.to_string())?;
    Ok(())
}
// Reads the XMP sidecar rating for a local file path and stores it with INSERT OR IGNORE,
// so it never overwrites a rating the user has set explicitly.
pub(crate) async fn import_xmp_rating(picture_id: &str, fingerprint: &str) {
    if picture_id.contains("://") {
        return; // skip non-local paths (ccapi://, s3://, etc.)
    }
    let path = std::path::Path::new(picture_id);
    let Ok(Some(rating)) = shade_io::rating_for_image_path(path) else {
        return;
    };
    let Ok(now) = unix_timestamp_millis() else {
        return;
    };
    if let Ok(conn) =
        tokio::time::timeout(std::time::Duration::from_secs(2), library_db_conn()).await
    {
        let _ = conn.execute(
            "INSERT OR IGNORE INTO media_ratings (fingerprint, rating, updated_at) VALUES (?1, ?2, ?3)",
            libsql::params![fingerprint, i64::from(rating), now],
        ).await;
    }
}
pub async fn persist_media_tags(
    fingerprint: &str,
    tags: &[String],
) -> Result<(), String> {
    let normalized = normalize_media_tags(tags);
    let conn = library_db_conn().await;
    conn.execute("BEGIN IMMEDIATE", ())
        .await
        .map_err(|error| error.to_string())?;
    let result = async {
        conn.execute(
            "DELETE FROM media_tags WHERE fingerprint = ?1",
            [fingerprint],
        )
        .await
        .map_err(|error| error.to_string())?;
        let updated_at = unix_timestamp_millis()?;
        for tag in normalized {
            conn.execute(
                "INSERT INTO media_tags (fingerprint, tag, updated_at)
                 VALUES (?1, ?2, ?3)",
                libsql::params![fingerprint, tag, updated_at],
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
            Ok(())
        }
        Err(error) => {
            let _ = conn.execute("ROLLBACK", ()).await;
            Err(error)
        }
    }
}
pub async fn persist_media_tags_empty(fingerprint: &str) -> Result<(), String> {
    let conn = library_db_conn().await;
    conn.execute("BEGIN IMMEDIATE", ())
        .await
        .map_err(|error| error.to_string())?;
    let result = async {
        conn.execute(
            "DELETE FROM media_tags WHERE fingerprint = ?1",
            [fingerprint],
        )
        .await
        .map_err(|error| error.to_string())?;
        conn.execute(
            "INSERT INTO media_tags (fingerprint, tag, updated_at)
             VALUES (?1, '', ?2)",
            libsql::params![fingerprint, unix_timestamp_millis()?],
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
pub async fn max_media_tag_updated_at() -> Result<i64, String> {
    let conn = library_db_conn().await;
    let mut rows = conn
        .query("SELECT MAX(updated_at) FROM media_tags", ())
        .await
        .map_err(|error| error.to_string())?;
    let max = match rows.next().await.map_err(|error| error.to_string())? {
        Some(row) => row
            .get::<Option<i64>>(0)
            .map_err(|e| e.to_string())?
            .unwrap_or(0),
        None => 0,
    };
    Ok(max)
}
pub async fn media_tags_exist(fingerprint: &str) -> Result<bool, String> {
    let conn = library_db_conn().await;
    let mut rows = conn
        .query(
            "SELECT 1 FROM media_tags WHERE fingerprint = ?1 LIMIT 1",
            [fingerprint],
        )
        .await
        .map_err(|error| error.to_string())?;
    Ok(rows
        .next()
        .await
        .map_err(|error| error.to_string())?
        .is_some())
}
#[tauri::command]
pub async fn list_media_ratings(
    fingerprints: Vec<String>,
) -> Result<HashMap<String, u8>, String> {
    load_media_ratings_map(&fingerprints).await
}

#[cfg(test)]
mod tests {
    use super::normalize_media_tags;

    #[test]
    fn normalizes_media_tags() {
        assert_eq!(
            normalize_media_tags(&[
                " portrait ".to_string(),
                "".to_string(),
                "portrait".to_string(),
                "client".to_string(),
            ]),
            vec!["client".to_string(), "portrait".to_string()]
        );
    }
}
