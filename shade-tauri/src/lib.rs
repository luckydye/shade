mod commands;
mod photos;

use tauri::Manager;

pub struct P2pState(
    pub tokio::sync::RwLock<Option<std::sync::Arc<shade_p2p::LocalPeerDiscovery>>>,
);
pub struct RenderService(pub crossbeam_channel::Sender<commands::RenderJob>);
pub struct ThumbnailService(pub std::sync::Arc<commands::ThumbnailQueue>);
pub struct LibraryScanService(pub std::sync::Arc<commands::LibraryScanService>);
pub struct CameraDiscoveryService(pub std::sync::Arc<commands::CameraDiscoveryService>);
pub struct CameraThumbnailService(pub std::sync::Arc<commands::CameraThumbnailService>);

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(photos::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(P2pState(tokio::sync::RwLock::new(None)))
        .manage(std::sync::Mutex::new(commands::EditorState::default()))
        .manage(RenderService(commands::spawn_render_worker()))
        .manage(ThumbnailService(commands::spawn_thumbnail_workers()))
        .manage(LibraryScanService(commands::LibraryScanService::new()))
        .manage(CameraDiscoveryService(
            commands::CameraDiscoveryService::new(),
        ))
        .manage(CameraThumbnailService(
            commands::CameraThumbnailService::new(),
        ))
        .setup(|app| {
            commands::init_app_paths(&app.handle().clone())?;
            let handle = app.handle().clone();
            let secret_key = commands::load_p2p_secret_key()?;
            let p2p = std::sync::Arc::new(
                tauri::async_runtime::block_on(shade_p2p::LocalPeerDiscovery::bind(
                    secret_key,
                    std::sync::Arc::new(commands::AppMediaProvider::new(handle)),
                ))
                .map_err(|error| error.to_string())?,
            );
            commands::save_p2p_secret_key(p2p.secret_key_bytes())?;
            tauri::async_runtime::block_on(async {
                *app.state::<P2pState>().0.write().await = Some(p2p);
            });
            commands::spawn_camera_discovery(app.handle().clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::open_image,
            commands::open_image_encoded_bytes,
            commands::open_image_bytes,
            commands::export_image,
            commands::render_preview,
            commands::render_preview_float16,
            commands::apply_edit,
            commands::add_layer,
            commands::delete_layer,
            commands::move_layer,
            commands::set_layer_visible,
            commands::set_layer_opacity,
            commands::get_layer_stack,
            commands::list_pictures,
            commands::list_media_libraries,
            commands::list_library_images,
            commands::add_media_library,
            commands::remove_media_library,
            commands::list_presets,
            commands::save_preset,
            commands::load_preset,
            commands::save_snapshot,
            commands::list_snapshots,
            commands::load_snapshot,
            commands::get_thumbnail,
            commands::get_local_peer_discovery_snapshot,
            commands::list_peer_pictures,
            commands::get_peer_thumbnail,
            commands::get_peer_image_bytes,
            commands::open_peer_image,
            commands::apply_gradient_mask,
            commands::remove_mask,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Tauri application");
}
