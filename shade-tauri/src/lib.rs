mod channel_protocol;
mod channel_server;
mod commands;
mod photos;
mod preview_channel;
mod preview_scheduler;
mod remote_control;
mod tagging_worker;

pub use channel_protocol::ChannelMessage;
pub use channel_server::{CoordinationChannel, CoordinationChannelService};
pub use preview_channel::{PreviewChannel, PreviewChannelService};

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
    pub decode_semaphore: std::sync::Arc<tokio::sync::Semaphore>,
}
pub struct LibraryScanService(pub std::sync::Arc<shade_io::LibraryScanService>);
pub struct S3LibraryScanService(pub std::sync::Arc<commands::S3LibraryScanState>);
pub struct CameraDiscoveryService(pub std::sync::Arc<shade_io::CameraDiscoveryService>);
pub struct CameraThumbnailService(pub std::sync::Arc<shade_io::CameraThumbnailService>);
pub struct ThumbnailCacheDb(pub std::sync::Arc<shade_io::ThumbnailCacheDb>);

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(photos::init())
        .plugin(tauri_plugin_dialog::init())
        .register_asynchronous_uri_scheme_protocol(
            "shade",
            |ctx, request, responder| {
                let app = ctx.app_handle().clone();
                tauri::async_runtime::spawn(async move {
                    let response = commands::serve_shade_uri(&app, request).await;
                    responder.respond(response);
                });
            },
        )
        .manage(CoordinationChannelService(CoordinationChannel::new()))
        .manage(PreviewChannelService(PreviewChannel::new()))
        .manage(P2pState(tokio::sync::RwLock::new(None)))
        .manage(remote_control::RemoteControlState::default())
        .manage(std::sync::Mutex::new(commands::EditorState::default()))
        .manage(RenderService(commands::spawn_render_worker()))
        .manage(ThumbnailService {
            raw_queue: shade_io::spawn_thumbnail_workers(1),
            render_sender: commands::spawn_thumbnail_render_worker(),
            decode_semaphore: std::sync::Arc::new(tokio::sync::Semaphore::new(2)),
        })
        .manage(CameraDiscoveryService(
            shade_io::CameraDiscoveryService::new(),
        ))
        .manage(CameraThumbnailService(
            shade_io::CameraThumbnailService::new(),
        ))
        .setup(|app| {
            commands::init_app_paths(&app.handle().clone())?;
            tauri::async_runtime::block_on(remote_control::start(
                app.handle().clone(),
                app.state::<remote_control::RemoteControlState>().0.clone(),
            ))?;
            tauri::async_runtime::block_on(commands::setup_library_db())
                .map_err(|e| e.to_string())?;
            let library_index_db =
                tauri::async_runtime::block_on(commands::setup_library_index_db())
                    .map_err(|e| e.to_string())?;
            let handle_progress = app.handle().clone();
            let handle_complete = app.handle().clone();
            app.manage(LibraryScanService(shade_io::LibraryScanService::new(
                library_index_db.clone(),
                move |library_id: &str| {
                    channel_server::channel_from_app(&handle_progress).send_blocking(
                        ChannelMessage::LibraryScanProgress {
                            library_id: library_id.to_owned(),
                            scanned: 0,
                            total: 0,
                        },
                    );
                },
                move |library_id: &str| {
                    channel_server::channel_from_app(&handle_complete).send_blocking(
                        ChannelMessage::LibraryScanComplete {
                            library_id: library_id.to_owned(),
                        },
                    );
                },
            )));
            app.manage(S3LibraryScanService(commands::S3LibraryScanState::new(
                library_index_db,
            )));
            let thumbnail_cache = std::sync::Arc::new(
                tauri::async_runtime::block_on(commands::open_thumbnail_cache_db())
                    .map_err(|e| e.to_string())?,
            );
            app.manage(ThumbnailCacheDb(thumbnail_cache.clone()));
            #[cfg(not(any(target_os = "ios", target_os = "android")))]
            app.manage(tagging_worker::spawn_thumbnail_tagging_worker()?);
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
            commands::dispatch_mutation,
            commands::dispatch_read,
            commands::get_layer_stack,
            commands::list_library_images,
            commands::add_media_library,
            commands::add_s3_media_library,
            commands::update_s3_media_library,
            commands::batch_apply_preset_snapshot,
            commands::batch_clear_edits,
            commands::batch_export_images,
            commands::get_peer_image_bytes,
            commands::open_peer_image,
            commands::get_mask_thumbnail,
            commands::create_collection,
            remote_control::submit_remote_control_response,
            remote_control::get_remote_control_server_info,
            channel_server::register_coordination_channel,
            preview_channel::register_preview_channel,
            preview_scheduler::update_preview_viewports,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Tauri application");
}
