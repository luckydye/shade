use shade_io::library_index_db_path as shared_library_index_db_path;
use std::path::PathBuf;
use std::sync::OnceLock;
use tauri::Manager;


pub(crate) static APP_CONFIG_DIR: OnceLock<PathBuf> = OnceLock::new();
pub fn init_app_paths<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
) -> Result<(), String> {
    let config_dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    APP_CONFIG_DIR
        .set(config_dir)
        .map_err(|_| "app config path already initialized".to_string())
}
pub(crate) fn presets_dir_path() -> Result<PathBuf, String> {
    Ok(app_config_dir()?.join("presets"))
}
pub(crate) fn home_dir() -> Result<PathBuf, String> {
    std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .map(PathBuf::from)
        .map_err(|_| "Could not determine home directory".to_string())
}
pub(crate) fn app_config_dir() -> Result<PathBuf, String> {
    #[cfg(any(target_os = "android", target_os = "ios"))]
    {
        return APP_CONFIG_DIR
            .get()
            .cloned()
            .ok_or_else(|| "app config path is not initialized".to_string());
    }

    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        let home = home_dir()?;
        Ok(home.join(".config/shade"))
    }
}
pub(crate) fn preset_file_path(name: &str) -> Result<PathBuf, String> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err("preset name cannot be empty".into());
    }
    if trimmed.contains('/') || trimmed.contains('\\') || trimmed.contains("..") {
        return Err("preset name contains invalid path characters".into());
    }
    Ok(presets_dir_path()?.join(format!("{trimmed}.json")))
}
pub(crate) fn library_db_path() -> Result<PathBuf, String> {
    Ok(app_config_dir()?.join("library.db"))
}
pub(crate) fn library_index_db_path() -> Result<PathBuf, String> {
    Ok(shared_library_index_db_path(&app_config_dir()?))
}
pub(crate) fn thumbnail_cache_db_path() -> Result<PathBuf, String> {
    Ok(app_config_dir()?.join("thumbnails.db"))
}
pub(crate) fn library_sync_dir(library_id: &str) -> Result<PathBuf, String> {
    let dir = app_config_dir()?.join("sync").join(library_id);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}
pub(crate) fn default_pictures_dir() -> Result<PathBuf, String> {
    Ok(home_dir()?.join("Pictures"))
}
