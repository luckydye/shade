use crate::camera_discovery::ccapi_host_is_online;
use crate::config::{
    load_app_config, ordered_library_entries, save_app_config, set_library_order,
    sync_persisted_peer_names,
};
use crate::db::{library_db_conn, library_index_db};
#[cfg(target_os = "ios")]
use crate::image_loaders::IosPhotoEntry;
use crate::media_metadata::load_media_tags_map;
use crate::paths::default_pictures_dir;
use crate::peers::{discovered_peers_by_endpoint, peer_library_for_endpoint};
use serde::{Deserialize, Serialize};
use shade_io::{
    delete_persisted_library_index, picture_display_name, scan_directory_images,
};
use std::collections::HashMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use tauri::Manager;

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct MediaLibrary {
    pub id: String,
    pub name: String,
    pub kind: String,
    pub path: Option<String>,
    pub removable: bool,
    pub readonly: bool,
    pub is_online: Option<bool>,
    pub is_refreshing: Option<bool>,
    pub mode: String,
    pub sync_target: Option<String>,
}
#[derive(Serialize, Deserialize, Debug, Clone, Default)]
pub struct LibraryImageMetadata {
    pub has_snapshots: bool,
    pub latest_snapshot_id: Option<String>,
    #[serde(default)]
    pub latest_snapshot_created_at: Option<i64>,
    pub rating: Option<u8>,
    #[serde(default)]
    pub tags: Vec<String>,
}
#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct LibraryImage {
    pub path: String,
    pub name: String,
    pub modified_at: Option<u64>,
    #[serde(default)]
    pub fingerprint: Option<String>,
    #[serde(default)]
    pub metadata: LibraryImageMetadata,
}
#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct LibraryImageListing {
    pub items: Vec<LibraryImage>,
    pub is_complete: bool,
}
pub(crate) fn custom_library_id(path: &Path) -> String {
    shade_io::local_library_id(path)
}
pub(crate) fn s3_library_id(source_id: &str) -> String {
    shade_io::s3_library_id(source_id)
}
pub(crate) fn ccapi_library_id(host: &str) -> String {
    shade_io::camera_library_id(host)
}
pub(crate) fn ccapi_media_path(host: &str, file_path: &str) -> String {
    format!("ccapi://{host}{file_path}")
}
pub(crate) fn ccapi_library_for_host(
    host: &str,
    is_online: bool,
    removable: bool,
) -> MediaLibrary {
    MediaLibrary {
        id: ccapi_library_id(host),
        name: format!("Camera {host}"),
        kind: "camera".into(),
        path: Some(host.to_string()),
        removable,
        readonly: true,
        is_online: Some(is_online),
        is_refreshing: None,
        mode: "browse".into(),
        sync_target: None,
    }
}
pub(crate) fn local_library_is_available(path: &Path) -> bool {
    path.is_dir()
}
pub(crate) fn unavailable_local_library_error(path: &Path) -> String {
    format!("media library is unavailable: {}", path.display())
}
pub(crate) fn require_local_library_path(path: PathBuf) -> Result<PathBuf, String> {
    if local_library_is_available(&path) {
        return Ok(path);
    }
    Err(unavailable_local_library_error(&path))
}
pub(crate) fn library_for_directory(path: PathBuf, is_refreshing: bool) -> MediaLibrary {
    let is_online = local_library_is_available(&path);
    let name = path
        .file_name()
        .and_then(|segment| segment.to_str())
        .map(str::to_string)
        .unwrap_or_else(|| path.display().to_string());
    MediaLibrary {
        id: custom_library_id(&path),
        name,
        kind: "directory".into(),
        path: Some(path.display().to_string()),
        removable: true,
        readonly: false,
        is_online: Some(is_online),
        is_refreshing: Some(is_refreshing && is_online),
        mode: "browse".into(),
        sync_target: None,
    }
}
pub(crate) fn library_for_s3(config: &shade_io::S3LibraryConfig) -> MediaLibrary {
    MediaLibrary {
        id: s3_library_id(&config.id),
        name: shade_io::display_s3_library_name(config),
        kind: "s3".into(),
        path: Some(shade_io::format_s3_library_detail(config)),
        removable: true,
        readonly: false,
        is_online: None,
        is_refreshing: None,
        mode: "browse".into(),
        sync_target: None,
    }
}
pub(crate) fn normalize_upload_file_name(file_name: &str) -> Result<String, String> {
    let trimmed = file_name.trim();
    if trimmed.is_empty() {
        return Err("upload file name cannot be empty".to_string());
    }
    if trimmed == "."
        || trimmed == ".."
        || trimmed.contains('/')
        || trimmed.contains('\\')
    {
        return Err(format!("invalid upload file name: {file_name}"));
    }
    Ok(trimmed.to_string())
}
pub(crate) fn s3_upload_object_key(
    config: &shade_io::S3LibraryConfig,
    file_name: &str,
) -> String {
    match config.prefix.as_deref() {
        Some(prefix) => format!("{prefix}/{file_name}"),
        None => file_name.to_string(),
    }
}
pub(crate) async fn list_desktop_media_libraries<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
) -> Result<Vec<MediaLibrary>, String> {
    let pictures_dir = default_pictures_dir()?;
    let scan_service = &app.state::<crate::LibraryScanService>().0;
    let pictures_online = local_library_is_available(&pictures_dir);
    let mut libraries = vec![MediaLibrary {
        id: "pictures".into(),
        name: "Pictures".into(),
        kind: "directory".into(),
        path: Some(pictures_dir.display().to_string()),
        removable: false,
        readonly: false,
        is_online: Some(pictures_online),
        is_refreshing: Some(pictures_online && scan_service.is_refreshing("pictures")?),
        mode: "browse".into(),
        sync_target: None,
    }];
    let mut config = load_app_config()?;
    let discovered_peers = discovered_peers_by_endpoint(app).await;
    if sync_persisted_peer_names(&mut config, &discovered_peers) {
        save_app_config(&config)?;
    }
    let mut configured_camera_hosts = std::collections::HashSet::new();
    for library in &config.libraries {
        match library {
            shade_io::LibraryConfig::Local(config) => {
                let path = PathBuf::from(&config.path);
                libraries.push(library_for_directory(
                    path.clone(),
                    local_library_is_available(&path)
                        && scan_service.is_refreshing(&custom_library_id(&path))?,
                ));
            }
            shade_io::LibraryConfig::S3(config) => libraries.push(library_for_s3(config)),
            shade_io::LibraryConfig::Camera(config) => {
                configured_camera_hosts.insert(config.host.clone());
                libraries.push(ccapi_library_for_host(
                    &config.host,
                    ccapi_host_is_online(&config.host).await,
                    true,
                ));
            }
            shade_io::LibraryConfig::Peer(config) => {
                let discovered = discovered_peers.get(&config.peer_id);
                libraries.push(peer_library_for_endpoint(
                    &config.peer_id,
                    discovered
                        .map(|peer| peer.name.as_str())
                        .or(config.name.as_deref())
                        .unwrap_or(config.peer_id.as_str()),
                    discovered.is_some(),
                ));
            }
        }
    }
    for host in app
        .state::<crate::CameraDiscoveryService>()
        .0
        .snapshot()
        .await
    {
        if configured_camera_hosts.contains(&host) {
            continue;
        }
        libraries.push(ccapi_library_for_host(&host, true, false));
    }
    let mut result = ordered_library_entries(libraries, &config.library_order);
    for lib in &mut result {
        if let Some(mode) = config.library_modes.get(&lib.id) {
            lib.mode = match mode {
                shade_io::LibraryMode::Browse => "browse".into(),
                shade_io::LibraryMode::Sync => "sync".into(),
            };
        }
        if let Some(target) = config.sync_targets.get(&lib.id) {
            lib.sync_target = Some(target.clone());
        }
    }
    Ok(result)
}
#[tauri::command]
pub async fn set_media_library_order(library_order: Vec<String>) -> Result<(), String> {
    set_library_order(library_order)
}
#[tauri::command]
pub async fn set_library_mode(
    library_id: String,
    mode: String,
    sync_target: Option<String>,
) -> Result<(), String> {
    let library_mode = match mode.as_str() {
        "browse" => shade_io::LibraryMode::Browse,
        "sync" => shade_io::LibraryMode::Sync,
        other => return Err(format!("invalid library mode: {other}")),
    };
    let mut config = load_app_config()?;
    config
        .library_modes
        .insert(library_id.clone(), library_mode);
    match sync_target {
        Some(target) => {
            config.sync_targets.insert(library_id, target);
        }
        None => {
            config.sync_targets.remove(&library_id);
        }
    }
    save_app_config(&config)
}
pub(crate) async fn list_s3_remote_names(
    config: &shade_io::S3LibraryConfig,
) -> Result<std::collections::HashSet<String>, String> {
    let objects = shade_io::list_s3_objects(config).await?;
    Ok(objects
        .into_iter()
        .filter_map(|entry| {
            Path::new(&entry.key)
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
        })
        .collect())
}
pub(crate) fn resolve_desktop_library_path(library_id: &str) -> Result<PathBuf, String> {
    if library_id == "pictures" {
        return default_pictures_dir();
    }
    for library in load_app_config()?.libraries {
        if let shade_io::LibraryConfig::Local(config) = library {
            let path = PathBuf::from(&config.path);
            if custom_library_id(&path) == library_id {
                return Ok(path);
            }
        }
    }
    Err(format!("unknown media library: {library_id}"))
}
pub(crate) fn desktop_local_library_roots() -> Result<Vec<(String, PathBuf)>, String> {
    let mut roots = vec![("pictures".to_string(), default_pictures_dir()?)];
    for library in load_app_config()?.libraries {
        if let shade_io::LibraryConfig::Local(config) = library {
            let path = PathBuf::from(config.path);
            roots.push((custom_library_id(&path), path));
        }
    }
    Ok(roots)
}
pub(crate) fn local_upload_target_path(
    library_root: &Path,
    file_name: &str,
) -> Result<PathBuf, String> {
    let normalized = normalize_upload_file_name(file_name)?;
    let target_path = library_root.join(&normalized);
    if target_path.exists() {
        return Err(format!(
            "upload destination already exists: {}",
            target_path.display()
        ));
    }
    Ok(target_path)
}
pub(crate) fn timestamp_suffix_file_name(file_name: &str) -> Result<String, String> {
    let path = Path::new(file_name);
    let stem = path
        .file_stem()
        .and_then(|segment| segment.to_str())
        .ok_or_else(|| format!("invalid upload file name: {file_name}"))?;
    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|error| error.to_string())?
        .as_millis();
    let suffixed = match path.extension().and_then(|segment| segment.to_str()) {
        Some(extension) => format!("{stem}-{timestamp}.{extension}"),
        None => format!("{stem}-{timestamp}"),
    };
    normalize_upload_file_name(&suffixed)
}
pub(crate) fn local_upload_target_path_with_conflict_policy(
    library_root: &Path,
    file_name: &str,
    append_timestamp_on_conflict: bool,
) -> Result<PathBuf, String> {
    match local_upload_target_path(library_root, file_name) {
        Ok(path) => Ok(path),
        Err(error)
            if append_timestamp_on_conflict
                && error.starts_with("upload destination already exists: ") =>
        {
            local_upload_target_path(
                library_root,
                &timestamp_suffix_file_name(file_name)?,
            )
        }
        Err(error) => Err(error),
    }
}
pub(crate) fn resolve_local_library_item(
    path: &str,
) -> Result<(String, PathBuf), String> {
    let item_path = PathBuf::from(path);
    if !item_path.is_file() {
        return Err(format!("media item path is not a file: {path}"));
    }
    let canonical_item_path =
        std::fs::canonicalize(&item_path).map_err(|e| e.to_string())?;
    for (library_id, root) in desktop_local_library_roots()? {
        if !local_library_is_available(&root) {
            continue;
        }
        let canonical_root = std::fs::canonicalize(&root).map_err(|e| e.to_string())?;
        if canonical_item_path.starts_with(&canonical_root) {
            return Ok((library_id, canonical_item_path));
        }
    }
    Err(format!("media item is not part of a local library: {path}"))
}
pub(crate) async fn refresh_desktop_local_library<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    library_id: &str,
    library_root: PathBuf,
) -> Result<(), String> {
    app.state::<crate::LibraryScanService>()
        .0
        .refresh_library(library_id, library_root)
        .await
}
pub(crate) fn resolve_ccapi_library_host(library_id: &str) -> Result<String, String> {
    let host = library_id
        .strip_prefix("ccapi:")
        .ok_or_else(|| format!("unknown camera library: {library_id}"))?;
    if host.is_empty() {
        return Err(format!("unknown camera library: {library_id}"));
    }
    Ok(host.to_string())
}
pub(crate) fn collect_images_in_directory(
    dir: &Path,
) -> Result<Vec<LibraryImage>, String> {
    Ok(scan_directory_images(dir)?
        .into_iter()
        .map(|item| LibraryImage {
            name: item.name,
            path: item.path,
            modified_at: item.modified_at,
            fingerprint: None,
            metadata: LibraryImageMetadata {
                has_snapshots: false,
                latest_snapshot_id: None,
                latest_snapshot_created_at: None,
                rating: item.rating,
                tags: Vec::new(),
            },
        })
        .collect())
}
pub(crate) fn ccapi_rating(value: &str) -> Result<Option<u8>, String> {
    shade_io::library_index::normalize_rating(value)
}
pub(crate) async fn list_ccapi_library_images(
    host: &str,
) -> Result<LibraryImageListing, String> {
    let api = shade_io::ccapi::CCAPI::new(host);
    let storage = api.storage().await.map_err(|e| e.to_string())?;
    let mut items = Vec::new();
    for storage in storage.storagelist {
        for file_path in api.files(&storage).await.map_err(|e| e.to_string())? {
            let info = match tokio::time::timeout(
                std::time::Duration::from_secs(2),
                api.info(&file_path),
            )
            .await
            {
                Ok(result) => Some(result.map_err(|error| error.to_string())?),
                Err(_) => {
                    return Err(format!(
                        "timed out loading CCAPI metadata for {file_path}"
                    ))
                }
            };
            let modified_at = info
                .as_ref()
                .map(|value| chrono_like_timestamp_millis(&value.lastmodifieddate))
                .transpose()?
                .flatten();
            let rating = info
                .as_ref()
                .map(|value| ccapi_rating(&value.rating))
                .transpose()?
                .flatten();
            items.push(LibraryImage {
                name: picture_display_name(&file_path),
                path: ccapi_media_path(host, &file_path),
                modified_at,
                fingerprint: None,
                metadata: LibraryImageMetadata {
                    has_snapshots: false,
                    latest_snapshot_id: None,
                    latest_snapshot_created_at: None,
                    rating,
                    tags: Vec::new(),
                },
            });
        }
    }
    items.sort_by(|left, right| right.modified_at.cmp(&left.modified_at));
    Ok(LibraryImageListing {
        items,
        is_complete: true,
    })
}
pub(crate) fn resolve_s3_library_config(
    library_id: &str,
) -> Result<shade_io::S3LibraryConfig, String> {
    let source_id = shade_io::resolve_s3_source_id_from_library_id(library_id)?;
    for library in load_app_config()?.libraries {
        if let shade_io::LibraryConfig::S3(config) = library {
            if config.id == source_id {
                return Ok(config);
            }
        }
    }
    Err(format!("unknown S3 media library: {library_id}"))
}
pub(crate) fn move_library_identity(
    config: &mut shade_io::AppConfig,
    old_id: &str,
    new_id: &str,
) {
    if old_id == new_id {
        return;
    }
    for library_id in &mut config.library_order {
        if library_id == old_id {
            *library_id = new_id.to_string();
        }
    }
    if let Some(mode) = config.library_modes.remove(old_id) {
        config.library_modes.insert(new_id.to_string(), mode);
    }
    if let Some(target) = config.sync_targets.remove(old_id) {
        config.sync_targets.insert(new_id.to_string(), target);
    }
    for target in config.sync_targets.values_mut() {
        if target == old_id {
            *target = new_id.to_string();
        }
    }
}
pub(crate) fn resolve_s3_library_for_media_path(
    picture_id: &str,
) -> Result<(shade_io::S3LibraryConfig, String), String> {
    let (source_id, key) = shade_io::parse_s3_media_path(picture_id)?;
    Ok((
        resolve_s3_library_config(&s3_library_id(source_id))?,
        key.to_string(),
    ))
}
pub(crate) async fn list_s3_library_images<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    config: &shade_io::S3LibraryConfig,
) -> Result<LibraryImageListing, String> {
    let snapshot = app
        .state::<crate::S3LibraryScanService>()
        .0
        .snapshot_for_library(app.clone(), config)
        .await?;
    Ok(LibraryImageListing {
        items: snapshot
            .items
            .into_iter()
            .map(local_library_image)
            .collect(),
        is_complete: snapshot.is_complete,
    })
}
pub(crate) fn chrono_like_timestamp_millis(value: &str) -> Result<Option<u64>, String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }
    let normalized = trimmed.replace(' ', "T");
    let parsed = chrono::DateTime::parse_from_rfc2822(trimmed)
        .or_else(|_| chrono::DateTime::parse_from_rfc3339(trimmed))
        .or_else(|_| chrono::DateTime::parse_from_rfc3339(&format!("{normalized}Z")))
        .or_else(|_| chrono::DateTime::parse_from_rfc3339(&normalized))
        .map_err(|e| format!("invalid CCAPI timestamp `{trimmed}`: {e}"))?;
    u64::try_from(parsed.timestamp_millis())
        .map(Some)
        .map_err(|e| e.to_string())
}
pub(crate) fn local_library_image(item: shade_io::IndexedLibraryImage) -> LibraryImage {
    LibraryImage {
        name: item.name,
        path: item.path,
        modified_at: item.modified_at,
        fingerprint: None,
        metadata: LibraryImageMetadata {
            has_snapshots: false,
            latest_snapshot_id: None,
            latest_snapshot_created_at: None,
            rating: item.rating,
            tags: Vec::new(),
        },
    }
}
#[tauri::command]
pub async fn list_media_libraries<R: tauri::Runtime>(
    _app: tauri::AppHandle<R>,
) -> Result<Vec<MediaLibrary>, String> {
    #[cfg(target_os = "android")]
    {
        let mut libraries = vec![MediaLibrary {
            id: "photos".into(),
            name: "Photos".into(),
            kind: "directory".into(),
            path: None,
            removable: false,
            readonly: true,
            is_online: None,
            is_refreshing: None,
            mode: "browse".into(),
            sync_target: None,
        }];
        let mut config = load_app_config()?;
        let discovered_peers = discovered_peers_by_endpoint(&_app).await;
        if sync_persisted_peer_names(&mut config, &discovered_peers) {
            save_app_config(&config)?;
        }
        for library in &config.libraries {
            if let shade_io::LibraryConfig::Peer(config) = library {
                let discovered = discovered_peers.get(&config.peer_id);
                libraries.push(peer_library_for_endpoint(
                    &config.peer_id,
                    discovered
                        .map(|peer| peer.name.as_str())
                        .or(config.name.as_deref())
                        .unwrap_or(config.peer_id.as_str()),
                    discovered.is_some(),
                ));
            }
        }
        return Ok(ordered_library_entries(libraries, &config.library_order));
    }

    #[cfg(target_os = "ios")]
    {
        let mut libraries = vec![MediaLibrary {
            id: "photos".into(),
            name: "Photos".into(),
            kind: "directory".into(),
            path: None,
            removable: false,
            readonly: true,
            is_online: None,
            is_refreshing: None,
            mode: "browse".into(),
            sync_target: None,
        }];
        let mut config = load_app_config()?;
        let discovered_peers = discovered_peers_by_endpoint(&_app).await;
        if sync_persisted_peer_names(&mut config, &discovered_peers) {
            save_app_config(&config)?;
        }
        for library in &config.libraries {
            if let shade_io::LibraryConfig::Peer(config) = library {
                let discovered = discovered_peers.get(&config.peer_id);
                libraries.push(peer_library_for_endpoint(
                    &config.peer_id,
                    discovered
                        .map(|peer| peer.name.as_str())
                        .or(config.name.as_deref())
                        .unwrap_or(config.peer_id.as_str()),
                    discovered.is_some(),
                ));
            }
        }
        return Ok(ordered_library_entries(libraries, &config.library_order));
    }

    #[cfg(not(any(target_os = "ios", target_os = "android")))]
    {
        list_desktop_media_libraries(&_app).await
    }
}
pub(crate) async fn enrich_listing_metadata(
    listing: &mut LibraryImageListing,
) -> Result<(), String> {
    let mut snapshot_ids: HashMap<String, String> = HashMap::new();
    let mut snapshot_created_ats: HashMap<String, i64> = HashMap::new();
    let mut fingerprints_by_source: HashMap<String, String> = HashMap::new();
    {
        let conn = library_db_conn().await;
        let mut rows = conn
            .query(
                "SELECT i.source_name, i.fingerprint, ev.id, ev.created_at
                 FROM images i
                 JOIN edit_versions ev ON ev.fingerprint = i.fingerprint
                 WHERE i.source_name IS NOT NULL
                 AND ev.created_at = (
                     SELECT MAX(ev2.created_at)
                     FROM edit_versions ev2
                     JOIN images i2 ON i2.fingerprint = ev2.fingerprint
                     WHERE i2.source_name = i.source_name
                 )",
                (),
            )
            .await
            .map_err(|e| e.to_string())?;
        while let Some(row) = rows.next().await.map_err(|e| e.to_string())? {
            let source_name = row.get::<String>(0).map_err(|e| e.to_string())?;
            let fingerprint = row.get::<String>(1).map_err(|e| e.to_string())?;
            let id = row.get::<String>(2).map_err(|e| e.to_string())?;
            let created_at = row.get::<i64>(3).map_err(|e| e.to_string())?;
            fingerprints_by_source.insert(source_name.clone(), fingerprint);
            snapshot_ids.insert(source_name.clone(), id);
            snapshot_created_ats.insert(source_name, created_at);
        }
        if listing
            .items
            .iter()
            .any(|item| !fingerprints_by_source.contains_key(&item.path))
        {
            let mut hash_rows = conn
                .query(
                    "SELECT source_name, fingerprint
                     FROM images
                     WHERE source_name IS NOT NULL",
                    (),
                )
                .await
                .map_err(|e| e.to_string())?;
            while let Some(row) = hash_rows.next().await.map_err(|e| e.to_string())? {
                let source_name = row.get::<String>(0).map_err(|e| e.to_string())?;
                let fingerprint = row.get::<String>(1).map_err(|e| e.to_string())?;
                fingerprints_by_source
                    .entry(source_name)
                    .or_insert(fingerprint);
            }
        }
    }
    let tags = load_media_tags_map(
        &listing
            .items
            .iter()
            .filter_map(|item| fingerprints_by_source.get(&item.path).cloned())
            .collect::<Vec<_>>(),
    )
    .await?;
    for item in &mut listing.items {
        item.fingerprint = fingerprints_by_source.get(&item.path).cloned();
        item.metadata.latest_snapshot_id = snapshot_ids.get(&item.path).cloned();
        item.metadata.latest_snapshot_created_at =
            snapshot_created_ats.get(&item.path).copied();
        item.metadata.has_snapshots = item.metadata.latest_snapshot_id.is_some();
        item.metadata.tags = item
            .fingerprint
            .as_ref()
            .and_then(|fingerprint| tags.get(fingerprint))
            .cloned()
            .unwrap_or_default();
    }
    Ok(())
}
pub(crate) async fn build_library_listing<R: tauri::Runtime>(
    _app: &tauri::AppHandle<R>,
    library_id: String,
) -> Result<LibraryImageListing, String> {
    #[cfg(target_os = "android")]
    {
        if library_id != "photos" {
            return Err(format!("unknown media library: {library_id}"));
        }
        return _app
            .state::<crate::photos::PhotosHandle<R>>()
            .list_photos()
            .await
            .map(|photos| LibraryImageListing {
                items: photos
                    .into_iter()
                    .map(|photo| LibraryImage {
                        name: picture_display_name(&photo.uri),
                        path: photo.uri,
                        modified_at: photo.modified_at,
                        fingerprint: None,
                        metadata: Default::default(),
                    })
                    .collect(),
                is_complete: true,
            });
    }

    #[cfg(target_os = "ios")]
    {
        if library_id != "photos" {
            return Err(format!("unknown media library: {library_id}"));
        }
        return tokio::task::spawn_blocking(|| {
            let ptr = unsafe { ios_list_photos() };
            if ptr.is_null() {
                return Ok(LibraryImageListing {
                    items: vec![],
                    is_complete: true,
                });
            }
            let json = unsafe {
                let s = std::ffi::CStr::from_ptr(ptr).to_string_lossy().into_owned();
                ios_free_string(ptr);
                s
            };
            serde_json::from_str::<Vec<IosPhotoEntry>>(&json)
                .map(|photos| LibraryImageListing {
                    items: photos
                        .into_iter()
                        .map(|photo| LibraryImage {
                            name: picture_display_name(&photo.id),
                            path: photo.id,
                            modified_at: photo.modified_at,
                            fingerprint: None,
                            metadata: Default::default(),
                        })
                        .collect(),
                    is_complete: true,
                })
                .map_err(|e| e.to_string())
        })
        .await
        .map_err(|e| e.to_string())?;
    }

    #[cfg(not(any(target_os = "ios", target_os = "android")))]
    {
        if library_id.starts_with("ccapi:") {
            return list_ccapi_library_images(&resolve_ccapi_library_host(&library_id)?)
                .await;
        }
        if library_id.starts_with("s3:") {
            return list_s3_library_images(
                _app,
                &resolve_s3_library_config(&library_id)?,
            )
            .await;
        }
        let library_path =
            require_local_library_path(resolve_desktop_library_path(&library_id)?)?;
        let snapshot = _app
            .state::<crate::LibraryScanService>()
            .0
            .snapshot_for_library(&library_id, library_path)
            .await?;
        Ok(LibraryImageListing {
            items: snapshot
                .items
                .into_iter()
                .map(local_library_image)
                .collect(),
            is_complete: snapshot.is_complete,
        })
    }
}
#[tauri::command]
pub async fn refresh_library_index<R: tauri::Runtime>(
    _app: tauri::AppHandle<R>,
    library_id: String,
) -> Result<(), String> {
    #[cfg(any(target_os = "ios", target_os = "android"))]
    {
        let _ = _app;
        return Err(format!(
            "library indexing is not supported on this platform: {library_id}"
        ));
    }

    #[cfg(not(any(target_os = "ios", target_os = "android")))]
    {
        if library_id.starts_with("ccapi:") {
            return Err(format!(
                "library indexing is not supported for camera libraries: {library_id}"
            ));
        }
        if library_id.starts_with("s3:") {
            _app.state::<crate::S3LibraryScanService>()
                .0
                .refresh_library(_app.clone(), &resolve_s3_library_config(&library_id)?)
                .await?;
            crate::tagging_worker::enqueue_existing_thumbnails_for_tagging(&_app).await?;
            return Ok(());
        }
        let library_path =
            require_local_library_path(resolve_desktop_library_path(&library_id)?)?;
        _app.state::<crate::LibraryScanService>()
            .0
            .refresh_library(&library_id, library_path)
            .await?;
        crate::tagging_worker::enqueue_existing_thumbnails_for_tagging(&_app).await?;
        Ok(())
    }
}
#[tauri::command]
pub async fn add_media_library<R: tauri::Runtime>(
    _app: tauri::AppHandle<R>,
    path: String,
) -> Result<MediaLibrary, String> {
    let canonical = std::fs::canonicalize(Path::new(&path)).map_err(|e| e.to_string())?;
    if !canonical.is_dir() {
        return Err(format!("not a directory: {}", canonical.display()));
    }
    let mut config = load_app_config()?;
    let canonical_string = canonical
        .to_str()
        .ok_or_else(|| format!("non-utf8 path: {}", canonical.display()))?
        .to_string();
    shade_io::upsert_library_config(
        &mut config.libraries,
        shade_io::LibraryConfig::Local(shade_io::LocalLibraryConfig {
            path: canonical_string,
        }),
    );
    let library = library_for_directory(canonical.clone(), true);
    shade_io::append_library_order_id(&mut config.library_order, library.id.clone());
    save_app_config(&config)?;
    #[cfg(not(any(target_os = "ios", target_os = "android")))]
    {
        _app.state::<crate::LibraryScanService>()
            .0
            .refresh_library(&library.id, canonical)
            .await?;
    }
    Ok(library)
}
#[tauri::command]
pub async fn add_s3_media_library<R: tauri::Runtime>(
    _app: tauri::AppHandle<R>,
    params: shade_io::AddS3LibraryParams,
) -> Result<MediaLibrary, String> {
    let library = shade_io::normalize_s3_library_input(params)?;
    let mut config = load_app_config()?;
    let persisted_library = library_for_s3(&library);
    shade_io::upsert_library_config(
        &mut config.libraries,
        shade_io::LibraryConfig::S3(library.clone()),
    );
    shade_io::append_library_order_id(
        &mut config.library_order,
        persisted_library.id.clone(),
    );
    save_app_config(&config)?;
    #[cfg(not(any(target_os = "ios", target_os = "android")))]
    {
        _app.state::<crate::S3LibraryScanService>()
            .0
            .refresh_library(_app.clone(), &library)
            .await?;
    }
    Ok(persisted_library)
}
#[tauri::command]
pub async fn get_s3_media_library(
    library_id: String,
) -> Result<shade_io::AddS3LibraryParams, String> {
    let library = resolve_s3_library_config(&library_id)?;
    Ok(shade_io::AddS3LibraryParams {
        name: library.name,
        endpoint: library.endpoint,
        bucket: library.bucket,
        region: library.region,
        access_key_id: library.access_key_id,
        secret_access_key: library.secret_access_key,
        prefix: library.prefix,
    })
}
#[tauri::command]
pub async fn update_s3_media_library<R: tauri::Runtime>(
    _app: tauri::AppHandle<R>,
    library_id: String,
    params: shade_io::AddS3LibraryParams,
) -> Result<MediaLibrary, String> {
    resolve_s3_library_config(&library_id)?;
    let updated = shade_io::normalize_s3_library_input(params)?;
    let updated_library_id = s3_library_id(&updated.id);
    let mut config = load_app_config()?;

    if updated_library_id != library_id
        && config
            .libraries
            .iter()
            .any(|library| shade_io::library_config_id(library) == updated_library_id)
    {
        return Err(format!(
            "another media library already uses this S3 source: {updated_library_id}"
        ));
    }

    config
        .libraries
        .retain(|library| shade_io::library_config_id(library) != library_id);
    config
        .libraries
        .push(shade_io::LibraryConfig::S3(updated.clone()));
    move_library_identity(&mut config, &library_id, &updated_library_id);
    shade_io::normalize_library_order(&mut config.library_order, &config.libraries);
    save_app_config(&config)?;

    #[cfg(not(any(target_os = "ios", target_os = "android")))]
    {
        if updated_library_id != library_id {
            delete_persisted_library_index(library_index_db(), &library_id).await?;
            _app.state::<crate::S3LibraryScanService>()
                .0
                .remove_library(&library_id)?;
        }
        _app.state::<crate::S3LibraryScanService>()
            .0
            .refresh_library(_app.clone(), &updated)
            .await?;
    }
    Ok(library_for_s3(&updated))
}
#[tauri::command]
pub async fn upload_media_library_file<R: tauri::Runtime>(
    _app: tauri::AppHandle<R>,
    library_id: String,
    file_name: String,
    bytes: Vec<u8>,
    modified_at: Option<u64>,
    append_timestamp_on_conflict: bool,
) -> Result<(), String> {
    if bytes.is_empty() {
        return Err(format!("upload file is empty: {file_name}"));
    }
    let file_name = normalize_upload_file_name(&file_name)?;
    if !shade_io::is_supported_library_image(Path::new(&file_name)) {
        return Err(format!("unsupported image upload: {file_name}"));
    }
    #[cfg(any(target_os = "ios", target_os = "android"))]
    {
        let _ = _app;
        return Err(format!(
            "image uploads are not supported for media library: {library_id}"
        ));
    }

    #[cfg(not(any(target_os = "ios", target_os = "android")))]
    if library_id.starts_with("s3:") {
        let config = resolve_s3_library_config(&library_id)?;
        return shade_io::put_s3_object_bytes_with_atime(
            &config,
            &s3_upload_object_key(&config, &file_name),
            &bytes,
            modified_at,
        )
        .await;
    }

    #[cfg(not(any(target_os = "ios", target_os = "android")))]
    {
        let library_root =
            require_local_library_path(resolve_desktop_library_path(&library_id)?)?;
        let target_path = local_upload_target_path_with_conflict_policy(
            &library_root,
            &file_name,
            append_timestamp_on_conflict,
        )?;
        let mut file = std::fs::File::options()
            .create_new(true)
            .write(true)
            .open(&target_path)
            .map_err(|error| error.to_string())?;
        if let Err(error) = file.write_all(&bytes) {
            let _ = std::fs::remove_file(&target_path);
            return Err(error.to_string());
        }
        refresh_desktop_local_library(&_app, &library_id, library_root).await
    }
}
#[tauri::command]
pub async fn upload_media_library_url<R: tauri::Runtime>(
    _app: tauri::AppHandle<R>,
    library_id: String,
    url: String,
    file_name: String,
) -> Result<(), String> {
    let (bytes, _content_type) = shade_io::fetch_url_bytes(&url).await?;
    if bytes.is_empty() {
        return Err(format!("fetched image is empty: {url}"));
    }
    let file_name = normalize_upload_file_name(&file_name)?;
    if !shade_io::is_supported_library_image(Path::new(&file_name)) {
        return Err(format!("unsupported image upload: {file_name}"));
    }

    #[cfg(any(target_os = "ios", target_os = "android"))]
    {
        let _ = _app;
        return Err(format!(
            "image uploads are not supported for media library: {library_id}"
        ));
    }

    #[cfg(not(any(target_os = "ios", target_os = "android")))]
    if library_id.starts_with("s3:") {
        let config = resolve_s3_library_config(&library_id)?;
        return shade_io::put_s3_object_bytes(
            &config,
            &s3_upload_object_key(&config, &file_name),
            &bytes,
        )
        .await;
    }

    #[cfg(not(any(target_os = "ios", target_os = "android")))]
    {
        let library_root =
            require_local_library_path(resolve_desktop_library_path(&library_id)?)?;
        let target_path = local_upload_target_path_with_conflict_policy(
            &library_root,
            &file_name,
            true,
        )?;
        let mut file = std::fs::File::options()
            .create_new(true)
            .write(true)
            .open(&target_path)
            .map_err(|error| error.to_string())?;
        if let Err(error) = file.write_all(&bytes) {
            let _ = std::fs::remove_file(&target_path);
            return Err(error.to_string());
        }
        refresh_desktop_local_library(&_app, &library_id, library_root).await
    }
}
#[tauri::command]
pub async fn upload_media_library_path<R: tauri::Runtime>(
    _app: tauri::AppHandle<R>,
    library_id: String,
    path: String,
) -> Result<(), String> {
    let file_path = PathBuf::from(&path);
    if !file_path.is_file() {
        return Err(format!("upload path is not a file: {path}"));
    }
    if !shade_io::is_supported_library_image(&file_path) {
        return Err(format!("unsupported image upload: {path}"));
    }
    let file_name = file_path
        .file_name()
        .and_then(|segment| segment.to_str())
        .ok_or_else(|| format!("invalid upload path: {path}"))?;
    let bytes = std::fs::read(&file_path).map_err(|error| error.to_string())?;
    if bytes.is_empty() {
        return Err(format!("upload file is empty: {path}"));
    }
    #[cfg(any(target_os = "ios", target_os = "android"))]
    {
        let _ = _app;
        return Err(format!(
            "image uploads are not supported for media library: {library_id}"
        ));
    }

    #[cfg(not(any(target_os = "ios", target_os = "android")))]
    if library_id.starts_with("s3:") {
        let config = resolve_s3_library_config(&library_id)?;
        return shade_io::put_s3_object_bytes(
            &config,
            &s3_upload_object_key(&config, &normalize_upload_file_name(file_name)?),
            &bytes,
        )
        .await;
    }

    #[cfg(not(any(target_os = "ios", target_os = "android")))]
    {
        let library_root =
            require_local_library_path(resolve_desktop_library_path(&library_id)?)?;
        let target_path = local_upload_target_path(&library_root, file_name)?;
        std::fs::copy(&file_path, &target_path).map_err(|error| error.to_string())?;
        refresh_desktop_local_library(&_app, &library_id, library_root).await
    }
}
#[tauri::command]
pub async fn delete_media_library_item<R: tauri::Runtime>(
    _app: tauri::AppHandle<R>,
    path: String,
) -> Result<(), String> {
    if path.starts_with("s3://") {
        let (source_id, key) = shade_io::parse_s3_media_path(&path)?;
        let library_id = s3_library_id(source_id);
        let config = resolve_s3_library_config(&library_id)?;
        shade_io::delete_s3_object(&config, &key).await?;
        _app.state::<crate::S3LibraryScanService>()
            .0
            .remove_item(&library_id, &path)
            .await?;
        crate::channel_server::channel_from_app(&_app)
            .send(crate::ChannelMessage::LibraryScanComplete { library_id })
            .await;
        return Ok(());
    }
    #[cfg(any(target_os = "ios", target_os = "android"))]
    {
        let _ = _app;
        return Err(format!(
            "media item deletion is not supported for path: {path}"
        ));
    }

    #[cfg(not(any(target_os = "ios", target_os = "android")))]
    {
        let (library_id, canonical_item_path) = resolve_local_library_item(&path)?;
        let library_root =
            require_local_library_path(resolve_desktop_library_path(&library_id)?)?;
        std::fs::remove_file(&canonical_item_path).map_err(|error| error.to_string())?;
        refresh_desktop_local_library(&_app, &library_id, library_root).await
    }
}
#[tauri::command]
pub async fn remove_media_library<R: tauri::Runtime>(
    _app: tauri::AppHandle<R>,
    id: String,
) -> Result<(), String> {
    if id == "pictures" || id == "photos" {
        return Err(format!("media library is not removable: {id}"));
    }
    let mut config = load_app_config()?;
    let removed = config
        .libraries
        .iter()
        .find(|library| shade_io::library_config_id(library) == id)
        .cloned();
    let Some(removed) = removed else {
        return Err(format!("unknown media library: {id}"));
    };
    config
        .libraries
        .retain(|library| shade_io::library_config_id(library) != id);
    shade_io::remove_library_order_id(&mut config.library_order, &id);
    save_app_config(&config)?;
    #[cfg(not(any(target_os = "ios", target_os = "android")))]
    {
        if matches!(
            removed,
            shade_io::LibraryConfig::Local(_) | shade_io::LibraryConfig::S3(_)
        ) {
            delete_persisted_library_index(library_index_db(), &id).await?;
        }
        if matches!(removed, shade_io::LibraryConfig::Local(_)) {
            _app.state::<crate::LibraryScanService>()
                .0
                .remove_library(&id)?;
        }
        if matches!(removed, shade_io::LibraryConfig::S3(_)) {
            _app.state::<crate::S3LibraryScanService>()
                .0
                .remove_library(&id)?;
        }
    }
    Ok(())
}
