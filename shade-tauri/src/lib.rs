mod commands;
mod photos;
mod tagging_worker;
mod thumbnail_cache;

use tauri::Manager;

pub struct P2pState(
    pub tokio::sync::RwLock<Option<std::sync::Arc<shade_p2p::LocalPeerDiscovery>>>,
);
pub struct AwarenessStateHandle(
    pub std::sync::Arc<tokio::sync::Mutex<shade_p2p::AwarenessState>>,
);
pub struct PeerPairingState(pub std::sync::Arc<tokio::sync::Mutex<()>>);
pub struct RenderService(pub crossbeam_channel::Sender<commands::RenderJob>);
pub struct ThumbnailService {
    pub raw_queue:
        std::sync::Arc<shade_io::ThumbnailQueue<shade_io::ThumbnailResponseSender>>,
    pub render_sender: crossbeam_channel::Sender<commands::ThumbnailRenderJob>,
}
pub struct LibraryScanService(pub std::sync::Arc<shade_io::LibraryScanService>);
pub struct S3LibraryScanService(pub std::sync::Arc<commands::S3LibraryScanState>);
pub struct CameraDiscoveryService(pub std::sync::Arc<shade_io::CameraDiscoveryService>);
pub struct CameraThumbnailService(pub std::sync::Arc<shade_io::CameraThumbnailService>);
pub struct ThumbnailCacheDb(pub std::sync::Arc<thumbnail_cache::ThumbnailCacheDb>);

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(photos::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(P2pState(tokio::sync::RwLock::new(None)))
        .manage(std::sync::Mutex::new(commands::EditorState::default()))
        .manage(RenderService(commands::spawn_render_worker()))
        .manage(ThumbnailService {
            raw_queue: shade_io::spawn_thumbnail_workers(),
            render_sender: commands::spawn_thumbnail_render_worker(),
        })
        .manage(LibraryScanService(shade_io::LibraryScanService::new()))
        .manage(S3LibraryScanService(commands::S3LibraryScanState::new()))
        .manage(CameraDiscoveryService(
            shade_io::CameraDiscoveryService::new(),
        ))
        .manage(CameraThumbnailService(
            shade_io::CameraThumbnailService::new(),
        ))
        .setup(|app| {
            commands::init_app_paths(&app.handle().clone())?;
            let thumbnail_cache = std::sync::Arc::new(
                tauri::async_runtime::block_on(commands::open_thumbnail_cache_db())
                    .map_err(|e| e.to_string())?,
            );
            app.manage(ThumbnailCacheDb(thumbnail_cache.clone()));
            #[cfg(not(any(target_os = "ios", target_os = "android")))]
            app.manage(tagging_worker::spawn_thumbnail_tagging_worker(
                thumbnail_cache.clone(),
            )?);
            let pairing_lock = std::sync::Arc::new(tokio::sync::Mutex::new(()));
            app.manage(PeerPairingState(pairing_lock.clone()));
            let handle = app.handle().clone();
            let secret_key = commands::load_p2p_secret_key()?;
            let awareness = std::sync::Arc::new(tokio::sync::Mutex::new(
                shade_p2p::AwarenessState::default(),
            ));
            app.manage(AwarenessStateHandle(awareness.clone()));
            let p2p = std::sync::Arc::new(
                tauri::async_runtime::block_on(shade_p2p::LocalPeerDiscovery::bind(
                    secret_key,
                    std::sync::Arc::new(commands::AppPeerProvider::new(
                        handle,
                        awareness,
                        pairing_lock,
                    )),
                ))
                .map_err(|error| error.to_string())?,
            );
            commands::save_p2p_secret_key(p2p.secret_key_bytes())?;
            tauri::async_runtime::block_on(async {
                *app.state::<P2pState>().0.write().await = Some(p2p);
            });
            commands::spawn_camera_discovery(app.handle().clone());
            commands::prime_missing_library_indexes(&app.handle().clone())?;
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
            commands::rename_layer,
            commands::get_layer_stack,
            commands::list_pictures,
            commands::list_media_libraries,
            commands::list_library_images,
            commands::list_media_ratings,
            commands::set_media_library_order,
            commands::refresh_library_index,
            commands::add_media_library,
            commands::add_s3_media_library,
            commands::upload_media_library_file,
            commands::upload_media_library_path,
            commands::delete_media_library_item,
            commands::remove_media_library,
            commands::list_presets,
            commands::save_preset,
            commands::rename_preset,
            commands::load_preset,
            commands::save_snapshot,
            commands::list_snapshots,
            commands::load_snapshot,
            commands::set_media_rating,
            commands::set_media_tags,
            commands::get_thumbnail,
            commands::get_local_peer_discovery_snapshot,
            commands::pair_peer_device,
            commands::list_peer_pictures,
            commands::get_peer_thumbnail,
            commands::get_peer_image_bytes,
            commands::open_peer_image,
            commands::set_local_awareness,
            commands::get_peer_awareness,
            commands::sync_peer_snapshots,
            commands::apply_peer_metadata,
            commands::apply_gradient_mask,
            commands::remove_mask,
            commands::create_brush_mask,
            commands::stamp_brush_mask,
            commands::get_mask_thumbnail,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Tauri application");
}
