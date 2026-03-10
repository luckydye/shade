mod commands;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(std::sync::Mutex::new(commands::EditorState::default()))
        .invoke_handler(tauri::generate_handler![
            commands::open_image,
            commands::open_image_bytes,
            commands::export_image,
            commands::apply_edit,
            commands::add_layer,
            commands::set_layer_visible,
            commands::set_layer_opacity,
            commands::get_layer_stack,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Tauri application");
}
