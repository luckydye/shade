mod commands;
mod photos;

use tauri::Manager;

pub struct P2pState(pub shade_p2p::LocalPeerDiscovery);
pub struct RenderService(pub crossbeam_channel::Sender<commands::RenderJob>);
pub struct ThumbnailService(pub std::sync::Arc<commands::ThumbnailQueue>);

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(photos::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(std::sync::Mutex::new(commands::EditorState::default()))
        .manage(RenderService(commands::spawn_render_worker()))
        .manage(ThumbnailService(commands::spawn_thumbnail_workers()))
        .setup(|app| {
            let handle = app.handle().clone();
            let p2p = tauri::async_runtime::block_on(shade_p2p::LocalPeerDiscovery::bind(
                std::sync::Arc::new(commands::AppMediaProvider::new(handle.clone())),
            ))
            .expect("failed to initialize local peer discovery");
            app.manage(P2pState(p2p));
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
            commands::get_thumbnail,
            commands::get_local_peer_discovery_snapshot,
            commands::list_peer_pictures,
            commands::get_peer_thumbnail,
            commands::get_peer_image_bytes,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Tauri application");
}
