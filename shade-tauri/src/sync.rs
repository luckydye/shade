use crate::config::load_app_config;
use crate::media_libraries::{
    list_s3_remote_names, require_local_library_path, resolve_desktop_library_path,
    resolve_s3_library_config, s3_upload_object_key,
};
use crate::paths::library_sync_dir;
use crate::peers::require_p2p;
use shade_io::{is_supported_library_image, scan_directory_images};
use std::path::Path;

#[tauri::command]
pub async fn sync_library<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    library_id: String,
    p2p: tauri::State<'_, crate::P2pState>,
) -> Result<(), String> {
    if library_id.starts_with("s3:") {
        sync_download_s3(&app, &library_id).await
    } else if library_id.starts_with("peer:") {
        sync_download_peer(&app, &library_id, &p2p).await
    } else {
        sync_upload_local(&app, &library_id).await
    }
}
pub(crate) async fn sync_download_s3<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    library_id: &str,
) -> Result<(), String> {
    let sync_dir = library_sync_dir(library_id)?;
    let config = resolve_s3_library_config(library_id)?;
    let objects = shade_io::list_s3_objects(&config).await?;
    let entries: Vec<_> = objects
        .into_iter()
        .filter(|entry| is_supported_library_image(Path::new(&entry.key)))
        .collect();
    let total = entries.len();
    for (i, entry) in entries.iter().enumerate() {
        let file_name = Path::new(&entry.key)
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| entry.key.clone());
        let dest = sync_dir.join(&file_name);
        if dest.exists() {
            continue;
        }
        broadcast_sync_progress(app, library_id, total, i, Some(file_name.clone()));
        let bytes = shade_io::get_s3_object_bytes(&config, &entry.key).await?;
        std::fs::write(&dest, &bytes).map_err(|e| e.to_string())?;
    }
    emit_sync_complete(app, library_id, total);
    Ok(())
}
pub(crate) async fn sync_download_peer<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    library_id: &str,
    p2p: &tauri::State<'_, crate::P2pState>,
) -> Result<(), String> {
    let sync_dir = library_sync_dir(library_id)?;
    let peer_endpoint_id = library_id
        .strip_prefix("peer:")
        .expect("peer: prefix already checked");
    let p2p_handle = require_p2p(p2p).await?;
    let pictures = p2p_handle
        .list_peer_pictures(peer_endpoint_id)
        .await
        .map_err(|e| e.to_string())?;
    let total = pictures.len();
    for (i, picture) in pictures.iter().enumerate() {
        let dest = sync_dir.join(&picture.name);
        if dest.exists() {
            continue;
        }
        broadcast_sync_progress(app, library_id, total, i, Some(picture.name.clone()));
        let bytes = p2p_handle
            .get_peer_image_bytes(peer_endpoint_id, &picture.id)
            .await
            .map_err(|e| e.to_string())?;
        std::fs::write(&dest, &bytes).map_err(|e| e.to_string())?;
    }
    emit_sync_complete(app, library_id, total);
    Ok(())
}
pub(crate) async fn sync_upload_local<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    library_id: &str,
) -> Result<(), String> {
    let library_path =
        require_local_library_path(resolve_desktop_library_path(library_id)?)?;
    let local_files = scan_directory_images(&library_path)?;
    if local_files.is_empty() {
        return Ok(());
    }

    let config = load_app_config()?;
    let target_id = config
        .sync_targets
        .get(library_id)
        .ok_or_else(|| format!("no sync target configured for library: {library_id}"))?;
    let target = resolve_s3_library_config(target_id)?;
    let remote_names = list_s3_remote_names(&target).await?;
    let total = local_files.len();
    let mut completed = 0;

    for local_file in &local_files {
        let local_path = Path::new(&local_file.path);
        let file_name = local_path
            .file_name()
            .and_then(|n| n.to_str())
            .ok_or_else(|| format!("invalid file name: {}", local_file.path))?;
        if remote_names.contains(file_name) {
            completed += 1;
            continue;
        }
        broadcast_sync_progress(
            app,
            library_id,
            total,
            completed,
            Some(file_name.to_owned()),
        );
        let bytes = std::fs::read(local_path).map_err(|e| e.to_string())?;
        let key = s3_upload_object_key(&target, file_name);
        shade_io::put_s3_object_bytes_with_atime(
            &target,
            &key,
            &bytes,
            local_file.modified_at,
        )
        .await?;
        completed += 1;
    }
    emit_sync_complete(app, library_id, total);
    Ok(())
}
pub(crate) fn broadcast_sync_progress<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    library_id: &str,
    total: usize,
    completed: usize,
    current_name: Option<String>,
) {
    crate::channel_server::channel_from_app(app).send_blocking(
        crate::ChannelMessage::LibrarySyncProgress {
            library_id: library_id.to_owned(),
            total: total as u64,
            completed: completed as u64,
            current_name,
        },
    );
}
pub(crate) fn emit_sync_complete<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    library_id: &str,
    total: usize,
) {
    broadcast_sync_progress(app, library_id, total, total, None);
}
