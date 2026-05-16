use crate::db::SUPERSEDED_IMAGE_LOAD_ERROR;
use crate::editor_state::{
    broadcast_layer_stack, lock_editor_state, restore_persisted_layers,
    snapshot_render_state, EditorState, LayerInfoResponse,
};
use crate::image_loaders::{
    decode_image_bytes_with_info, load_camera_image_from_tauri,
    load_photo_image_from_tauri, load_s3_image_from_tauri, open_local_image_sync,
};
use crate::peers::sync_snapshots_from_all_peers_for_fingerprint;
use crate::render::{export_render_request, RenderJob};
use crate::snapshots::{
    load_latest_edit_version, load_latest_edit_version_by_source, register_image_source,
};
use std::path::PathBuf;
use std::sync::Mutex;

#[tauri::command]
#[allow(unused_variables)]
pub async fn open_image<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    path: String,
    p2p: tauri::State<'_, crate::P2pState>,
    state: tauri::State<'_, Mutex<EditorState>>,
) -> Result<LayerInfoResponse, String> {
    let open_request_id = {
        let mut st = lock_editor_state(&state)?;
        st.begin_open_request()
    };
    let photo_app = app.clone();
    let s3_app = app.clone();
    let is_local = !path.starts_with("ccapi://") && !path.starts_with("s3://");
    let opened = if is_local {
        let photo_bytes = {
            let app = photo_app.clone();
            load_photo_image_from_tauri(&app, &path).await?
        };
        if let Some(bytes) = photo_bytes {
            let path_clone = path.clone();
            tokio::task::spawn_blocking(
                move || -> Result<shade_io::OpenedImage, String> {
                    let fingerprint = shade_io::fingerprint_from_bytes(&bytes).to_hex();
                    let (image, info) =
                        decode_image_bytes_with_info(&bytes, Some(&path_clone))?;
                    Ok(shade_io::OpenedImage {
                        fingerprint,
                        source_name: Some(path_clone),
                        image,
                        info,
                    })
                },
            )
            .await
            .map_err(|e| e.to_string())??
        } else {
            let path = path.clone();
            tokio::task::spawn_blocking(move || open_local_image_sync(&path))
                .await
                .map_err(|e| e.to_string())??
        }
    } else {
        shade_io::open_image(
            &path,
            |host, file_path| async move {
                load_camera_image_from_tauri(&host, &file_path).await
            },
            |s3_path| {
                let app = s3_app.clone();
                async move {
                    let bytes = load_s3_image_from_tauri(&s3_path).await?;
                    crate::channel_server::channel_from_app(&app).send_blocking(
                        crate::ChannelMessage::ImageOpenPhase {
                            phase: "processing".to_string(),
                        },
                    );
                    Ok(bytes)
                }
            },
            move |picture_id| {
                let app = photo_app.clone();
                async move { load_photo_image_from_tauri(&app, &picture_id).await }
            },
        )
        .await?
    };
    let fingerprint = opened.fingerprint;
    if let Some(source_name) = opened.source_name.as_deref() {
        register_image_source(&fingerprint, Some(source_name)).await?;
    }
    if let Some(peer) = p2p.0.read().await.clone() {
        let _ = sync_snapshots_from_all_peers_for_fingerprint(&peer, &fingerprint).await;
    }
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
    let response = {
        let mut st = lock_editor_state(&state)?;
        if !st.is_current_open_request(open_request_id) {
            return Err(SUPERSEDED_IMAGE_LOAD_ERROR.into());
        }
        let mut response = st.replace_with_linear_image(
            opened.image.pixels.to_vec(),
            opened.image.width,
            opened.image.height,
            opened.info.bit_depth,
        );
        restore_persisted_layers(
            &mut st,
            fingerprint.clone(),
            opened.source_name,
            persisted,
        )?;
        response.fingerprint = Some(fingerprint);
        response
    };
    broadcast_layer_stack(&app, &state).await;
    Ok(response)
}
#[tauri::command]
pub async fn open_image_encoded_bytes<R: tauri::Runtime>(
    bytes: Vec<u8>,
    file_name: Option<String>,
    p2p: tauri::State<'_, crate::P2pState>,
    state: tauri::State<'_, Mutex<EditorState>>,
    app: tauri::AppHandle<R>,
) -> Result<LayerInfoResponse, String> {
    let open_request_id = {
        let mut st = lock_editor_state(&state)?;
        st.begin_open_request()
    };
    let fingerprint = shade_io::fingerprint_from_bytes(&bytes).to_hex();
    if let Some(file_name) = file_name.as_deref() {
        register_image_source(&fingerprint, Some(file_name)).await?;
    }
    if let Some(peer) = p2p.0.read().await.clone() {
        let _ = sync_snapshots_from_all_peers_for_fingerprint(&peer, &fingerprint).await;
    }
    let persisted = load_latest_edit_version(&fingerprint).await?;
    let bytes_clone = bytes.clone();
    let file_name_clone = file_name.clone();
    let (image, info) = tokio::task::spawn_blocking(move || {
        decode_image_bytes_with_info(&bytes_clone, file_name_clone.as_deref())
    })
    .await
    .map_err(|e| e.to_string())??;
    let response = {
        let mut st = lock_editor_state(&state)?;
        if !st.is_current_open_request(open_request_id) {
            return Err(SUPERSEDED_IMAGE_LOAD_ERROR.into());
        }
        let mut response = st.replace_with_linear_image(
            image.pixels.to_vec(),
            image.width,
            image.height,
            info.bit_depth,
        );
        restore_persisted_layers(&mut st, fingerprint.clone(), file_name, persisted)?;
        response.fingerprint = Some(fingerprint);
        response
    };
    broadcast_layer_stack(&app, &state).await;
    Ok(response)
}
/// Accept raw RGBA8 bytes decoded in the webview (file picker / drag-drop).
/// This avoids needing a file path — the JS side decodes the image via
/// `createImageBitmap` and passes the pixel buffer directly.
/// NOTE: pixels here are already decoded by the browser, which applies color management
/// and outputs sRGB-encoded values.
#[tauri::command]
pub async fn open_image_bytes<R: tauri::Runtime>(
    pixels: Vec<u8>,
    width: u32,
    height: u32,
    p2p: tauri::State<'_, crate::P2pState>,
    state: tauri::State<'_, Mutex<EditorState>>,
    app: tauri::AppHandle<R>,
) -> Result<LayerInfoResponse, String> {
    let open_request_id = {
        let mut st = lock_editor_state(&state)?;
        st.begin_open_request()
    };
    if pixels.len() != (width * height * 4) as usize {
        return Err(format!(
            "pixel buffer size mismatch: expected {}, got {}",
            width * height * 4,
            pixels.len()
        ));
    }
    let fingerprint = shade_io::fingerprint_from_bytes(&pixels).to_hex();
    if let Some(peer) = p2p.0.read().await.clone() {
        let _ = sync_snapshots_from_all_peers_for_fingerprint(&peer, &fingerprint).await;
    }
    let persisted = load_latest_edit_version(&fingerprint).await?;
    let response = {
        let mut st = lock_editor_state(&state)?;
        if !st.is_current_open_request(open_request_id) {
            return Err(SUPERSEDED_IMAGE_LOAD_ERROR.into());
        }
        let mut response = st.replace_with_image(
            pixels
                .into_iter()
                .map(|channel| channel as f32 / 255.0)
                .collect(),
            width,
            height,
            "8-bit".into(),
            shade_lib::ColorSpace::Srgb,
        );
        restore_persisted_layers(&mut st, fingerprint.clone(), None, persisted)?;
        response.fingerprint = Some(fingerprint);
        response
    };
    broadcast_layer_stack(&app, &state).await;
    Ok(response)
}
#[tauri::command]
pub async fn export_image(
    path: String,
    render_service: tauri::State<'_, crate::RenderService>,
    state: tauri::State<'_, Mutex<EditorState>>,
) -> Result<(), String> {
    let export_path = PathBuf::from(&path);
    let ext = export_path
        .extension()
        .and_then(|segment| segment.to_str())
        .map(|segment| segment.to_lowercase())
        .ok_or_else(|| "export path must end in .png, .jpg, or .jpeg".to_string())?;
    if ext != "png" && ext != "jpg" && ext != "jpeg" {
        return Err("export format must be png, jpg, or jpeg".into());
    }
    let (stack, sources, canvas_width, canvas_height) = snapshot_render_state(&state)?;
    let request = export_render_request(&stack, canvas_width, canvas_height)?;
    let export_width = request.target_width;
    let export_height = request.target_height;
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
    tokio::task::spawn_blocking(move || -> Result<(), String> {
        shade_io::save_image(&export_path, &pixels, export_width, export_height)
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())??;
    Ok(())
}
