use tauri::Manager;

mod commands;

/// Lazily-initialised GPU renderer, shared across all command invocations.
pub struct RendererState(pub tokio::sync::Mutex<Option<shade_gpu::Renderer>>);

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(std::sync::Mutex::new(commands::EditorState::default()))
        .manage(RendererState(tokio::sync::Mutex::new(None)))
        .setup(|app| {
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                match shade_gpu::Renderer::new().await {
                    Ok(r) => {
                        let state = handle.state::<RendererState>();
                        *state.0.lock().await = Some(r);
                        log::info!("GPU renderer initialised");
                    }
                    Err(e) => log::error!("Failed to init GPU renderer: {e}"),
                }
            });
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
            commands::set_layer_visible,
            commands::set_layer_opacity,
            commands::get_layer_stack,
            commands::list_pictures,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Tauri application");
}
