use serde::{Deserialize, Serialize};
use shade_lib::LayerStack;
use std::sync::Arc;
use crate::db::library_db_conn;
use crate::editor_state::{build_persisted_layer_stack, texture_id_for_fingerprint};
use crate::image_loaders::{decode_image_bytes_with_info, load_camera_image_from_tauri, load_photo_image_from_tauri, load_s3_image_from_tauri, open_local_image_sync};
use crate::render::{RenderJob, export_render_request};
use crate::snapshots::{load_latest_edit_version, load_latest_edit_version_by_source};


#[tauri::command]
pub async fn batch_clear_edits(
    paths: Vec<String>,
) -> Result<u32, String> {
    let conn = library_db_conn().await;
    let mut count = 0u32;
    for path in paths {
        let mut rows = conn
            .query(
                "SELECT fingerprint FROM images WHERE source_name = ?1",
                [path],
            )
            .await
            .map_err(|e| e.to_string())?;
        while let Some(row) = rows.next().await.map_err(|e| e.to_string())? {
            let fingerprint: String = row.get(0).map_err(|e| e.to_string())?;
            conn.execute(
                "DELETE FROM edit_versions WHERE fingerprint = ?1",
                [fingerprint],
            )
            .await
            .map_err(|e| e.to_string())?;
            count += 1;
        }
    }
    Ok(count)
}
#[derive(Serialize, Deserialize)]
pub struct BatchExportItem {
    pub path: String,
    pub fingerprint: Option<String>,
    pub name: String,
}
pub(crate) async fn open_image_for_batch<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    path: &str,
) -> Result<shade_io::OpenedImage, String> {
    let is_local = !path.starts_with("ccapi://") && !path.starts_with("s3://");
    if is_local {
        let photo_bytes = load_photo_image_from_tauri(app, path).await?;
        if let Some(bytes) = photo_bytes {
            let path_clone = path.to_string();
            tokio::task::spawn_blocking(move || -> Result<shade_io::OpenedImage, String> {
                let fingerprint = shade_io::fingerprint_from_bytes(&bytes).to_hex();
                let (image, info) = decode_image_bytes_with_info(&bytes, Some(&path_clone))?;
                Ok(shade_io::OpenedImage {
                    fingerprint,
                    source_name: Some(path_clone),
                    image,
                    info,
                })
            })
            .await
            .map_err(|e| e.to_string())?
        } else {
            let path = path.to_string();
            tokio::task::spawn_blocking(move || open_local_image_sync(&path))
                .await
                .map_err(|e| e.to_string())?
        }
    } else {
        let photo_app = app.clone();
        shade_io::open_image(
            path,
            |host, file_path| async move {
                load_camera_image_from_tauri(&host, &file_path).await
            },
            |s3_path| async move { load_s3_image_from_tauri(&s3_path).await },
            move |photo_id| {
                let app = photo_app.clone();
                async move { load_photo_image_from_tauri(&app, &photo_id).await }
            },
        )
        .await
    }
}
pub(crate) fn resolve_unique_export_path(base_path: &std::path::Path) -> std::path::PathBuf {
    if !base_path.exists() {
        return base_path.to_path_buf();
    }
    let stem = base_path.file_stem().unwrap_or_default().to_string_lossy();
    let ext = base_path.extension().unwrap_or_default().to_string_lossy();
    let parent = base_path.parent().unwrap_or(std::path::Path::new(""));
    let mut i = 1;
    loop {
        let name = if ext.is_empty() {
            format!("{}_{}", stem, i)
        } else {
            format!("{}_{}.{}", stem, i, ext)
        };
        let candidate = parent.join(&name);
        if !candidate.exists() {
            return candidate;
        }
        i += 1;
    }
}
#[tauri::command]
pub async fn batch_export_images<R: tauri::Runtime>(
    items: Vec<BatchExportItem>,
    target_dir: String,
    app: tauri::AppHandle<R>,
    render_service: tauri::State<'_, crate::RenderService>,
) -> Result<u32, String> {
    let target_path = std::path::PathBuf::from(&target_dir);
    if !target_path.is_dir() {
        return Err("target directory does not exist".into());
    }

    let total = items.len();
    let mut count = 0u32;
    for (i, item) in items.into_iter().enumerate() {
        crate::channel_server::channel_from_app(&app)
            .send(crate::ChannelMessage::BatchExportProgress {
                current: i as u32,
                total: total as u32,
                name: item.name.clone(),
                error: None,
            })
            .await;

        let opened = open_image_for_batch(&app, &item.path).await?;
        let fingerprint = item.fingerprint.unwrap_or_else(|| opened.fingerprint.clone());

        let persisted = match load_latest_edit_version(&fingerprint).await? {
            Some(p) => Some(p),
            None => {
                if let Some(source_name) = opened.source_name.as_deref() {
                    load_latest_edit_version_by_source(source_name).await?
                } else {
                    None
                }
            }
        };

        let texture_id = texture_id_for_fingerprint(&fingerprint)?;
        let canvas_width = opened.image.width;
        let canvas_height = opened.image.height;
        let stack = match persisted {
            Some(p) => build_persisted_layer_stack(texture_id, canvas_width, canvas_height, &p)?,
            None => {
                let mut stack = LayerStack::new();
                stack.add_image_layer(texture_id, canvas_width, canvas_height);
                stack
            }
        };

        let request = export_render_request(&stack, canvas_width, canvas_height)?;
        let export_width = request.target_width;
        let export_height = request.target_height;
        let sources = Arc::new(std::collections::HashMap::from([(texture_id, opened.image)]));
        let (response_tx, response_rx) = tokio::sync::oneshot::channel();
        render_service
            .0
            .send(RenderJob::Export {
                stack,
                sources,
                canvas_width,
                canvas_height,
                request,
                response: response_tx,
            })
            .map_err(|e| e.to_string())?;
        let pixels = response_rx.await.map_err(|e| e.to_string())??;

        let file_stem = std::path::Path::new(&item.name)
            .file_stem()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_else(|| item.name.clone());
        let export_path = target_path.join(format!("{}.jpg", file_stem));
        let final_path = resolve_unique_export_path(&export_path);

        tokio::task::spawn_blocking(move || {
            shade_io::save_image(&final_path, &pixels, export_width, export_height)
                .map_err(|e| e.to_string())
        })
        .await
        .map_err(|e| e.to_string())??;

        count += 1;
    }

    crate::channel_server::channel_from_app(&app)
        .send(crate::ChannelMessage::BatchExportProgress {
            current: total as u32,
            total: total as u32,
            name: String::new(),
            error: None,
        })
        .await;

    Ok(count)
}
