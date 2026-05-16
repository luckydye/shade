use crate::db::library_db_conn;
use crate::editor_state::{
    broadcast_layer_stack, finalize_layer_stack_mutation, lock_editor_state,
    non_image_layer_data, restore_masks_from_params, EditorState, PersistedLayerData,
};
use crate::paths::{preset_file_path, presets_dir_path};
use crate::snapshots::{persist_snapshot, save_new_snapshot, EditSnapshotInfo};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Mutex;

#[derive(Serialize, Deserialize, Debug)]
pub(crate) struct PresetFile {
    pub(crate) version: u32,
    pub(crate) layers: Vec<shade_lib::LayerEntry>,
    #[serde(default)]
    pub(crate) mask_params: HashMap<shade_lib::MaskId, shade_lib::MaskParams>,
}
#[derive(Serialize, Deserialize, Debug)]
pub struct PresetInfo {
    pub name: String,
    pub created_at: i64,
}
#[tauri::command]
pub async fn list_presets() -> Result<Vec<PresetInfo>, String> {
    let dir = presets_dir_path()?;
    if !dir.exists() {
        return Ok(Vec::new());
    }
    let mut presets = Vec::new();
    for entry in std::fs::read_dir(&dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        if path.extension().and_then(|ext| ext.to_str()) != Some("json") {
            continue;
        }
        let Some(stem) = path.file_stem().and_then(|stem| stem.to_str()) else {
            continue;
        };
        let created_at = entry
            .metadata()
            .ok()
            .and_then(|m| m.created().ok())
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0);
        presets.push(PresetInfo {
            name: stem.to_string(),
            created_at,
        });
    }
    presets.sort_by(|a, b| a.created_at.cmp(&b.created_at));
    Ok(presets)
}
#[tauri::command]
pub async fn save_preset(
    name: String,
    state: tauri::State<'_, Mutex<EditorState>>,
) -> Result<PresetInfo, String> {
    let path = preset_file_path(&name)?;
    let parent = path
        .parent()
        .ok_or_else(|| format!("invalid preset path: {}", path.display()))?;
    std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let st = state.lock().unwrap();
    let layer_data = non_image_layer_data(&st.stack);
    let file = PresetFile {
        version: 1,
        layers: layer_data.layers,
        mask_params: layer_data.mask_params,
    };
    let json = serde_json::to_string_pretty(&file).map_err(|e| e.to_string())?;
    std::fs::write(&path, json).map_err(|e| e.to_string())?;
    let created_at = std::fs::metadata(&path)
        .ok()
        .and_then(|m| m.created().ok())
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    Ok(PresetInfo {
        name: name.trim().to_string(),
        created_at,
    })
}
#[tauri::command]
pub async fn save_preset_from_json(name: String, json: String) -> Result<(), String> {
    let path = preset_file_path(&name)?;
    let parent = path
        .parent()
        .ok_or_else(|| format!("invalid preset path: {}", path.display()))?;
    std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let _file: PresetFile = serde_json::from_str(&json).map_err(|e| e.to_string())?;
    std::fs::write(&path, json).map_err(|e| e.to_string())
}
#[tauri::command]
pub async fn get_preset_json(name: String) -> Result<String, String> {
    let path = preset_file_path(&name)?;
    std::fs::read_to_string(&path).map_err(|e| e.to_string())
}
#[tauri::command]
pub async fn get_snapshot_preset_json(
    fingerprint: String,
) -> Result<Option<String>, String> {
    let conn = library_db_conn().await;
    let mut rows = conn
        .query(
            "SELECT layers_json FROM edit_versions WHERE fingerprint = ?1 ORDER BY created_at DESC LIMIT 1",
            libsql::params![fingerprint],
        )
        .await
        .map_err(|e| e.to_string())?;
    let Some(row) = rows.next().await.map_err(|e| e.to_string())? else {
        return Ok(None);
    };
    let layers_json: String = row.get::<String>(0).map_err(|e| e.to_string())?;
    let data: PersistedLayerData =
        serde_json::from_str(&layers_json).map_err(|e| e.to_string())?;
    let preset = PresetFile {
        version: 1,
        layers: data.layers,
        mask_params: data.mask_params,
    };
    Ok(Some(
        serde_json::to_string(&preset).map_err(|e| e.to_string())?,
    ))
}
#[tauri::command]
pub async fn rename_preset(
    old_name: String,
    new_name: String,
) -> Result<PresetInfo, String> {
    let old_path = preset_file_path(&old_name)?;
    let new_path = preset_file_path(&new_name)?;
    let created_at = std::fs::metadata(&old_path)
        .ok()
        .and_then(|m| m.created().ok())
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    if old_path == new_path {
        return Ok(PresetInfo {
            name: new_name.trim().to_string(),
            created_at,
        });
    }
    if !old_path.exists() {
        return Err(format!("preset not found: {}", old_name.trim()));
    }
    if new_path.exists() {
        return Err(format!("preset already exists: {}", new_name.trim()));
    }
    std::fs::rename(&old_path, &new_path).map_err(|e| e.to_string())?;
    Ok(PresetInfo {
        name: new_name.trim().to_string(),
        created_at,
    })
}
#[tauri::command]
pub async fn delete_preset(name: String) -> Result<(), String> {
    let path = preset_file_path(&name)?;
    if !path.exists() {
        return Err(format!("preset not found: {}", name.trim()));
    }
    std::fs::remove_file(&path).map_err(|e| e.to_string())
}
#[tauri::command]
pub async fn load_preset<R: tauri::Runtime>(
    name: String,
    state: tauri::State<'_, Mutex<EditorState>>,
    app: tauri::AppHandle<R>,
) -> Result<(), String> {
    let path = preset_file_path(&name)?;
    let json = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let file: PresetFile = serde_json::from_str(&json).map_err(|e| e.to_string())?;
    if file.version != 1 {
        return Err(format!("unsupported preset version: {}", file.version));
    }
    {
        let mut st = lock_editor_state(&state)?;
        let image_layers: Vec<_> = st
            .stack
            .layers
            .iter()
            .filter(|entry| matches!(entry.layer, shade_lib::Layer::Image { .. }))
            .cloned()
            .collect();
        if image_layers.is_empty() {
            return Err("cannot load a preset without a loaded image".into());
        }
        st.stack.layers = image_layers;
        st.stack.masks.clear();
        st.stack.mask_params.clear();
        let base_idx = st.stack.layers.len();
        st.stack.layers.extend(file.layers);
        let w = st.canvas_width;
        let h = st.canvas_height;
        restore_masks_from_params(&mut st.stack, base_idx, &file.mask_params, w, h);
        st.stack.generation += 1;
    }
    finalize_layer_stack_mutation(&app, &state).await?;
    Ok(())
}
#[tauri::command]
pub async fn apply_preset_snapshot<R: tauri::Runtime>(
    name: String,
    state: tauri::State<'_, Mutex<EditorState>>,
    app: tauri::AppHandle<R>,
) -> Result<EditSnapshotInfo, String> {
    let path = preset_file_path(&name)?;
    let json = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let file: PresetFile = serde_json::from_str(&json).map_err(|e| e.to_string())?;
    if file.version != 1 {
        return Err(format!("unsupported preset version: {}", file.version));
    }
    {
        let mut st = lock_editor_state(&state)?;
        let image_layers: Vec<_> = st
            .stack
            .layers
            .iter()
            .filter(|entry| matches!(entry.layer, shade_lib::Layer::Image { .. }))
            .cloned()
            .collect();
        if image_layers.is_empty() {
            return Err("cannot apply a preset without a loaded image".into());
        }
        st.stack.layers = image_layers;
        st.stack.masks.clear();
        st.stack.mask_params.clear();
        let base_idx = st.stack.layers.len();
        st.stack.layers.extend(file.layers);
        let w = st.canvas_width;
        let h = st.canvas_height;
        restore_masks_from_params(&mut st.stack, base_idx, &file.mask_params, w, h);
        st.stack.generation += 1;
    }
    let id = save_new_snapshot(&state).await?;
    broadcast_layer_stack(&app, &state).await;
    Ok(EditSnapshotInfo { id })
}
#[derive(Serialize, Deserialize)]
pub struct BatchPresetItem {
    pub(crate) path: String,
    pub(crate) fingerprint: Option<String>,
}
#[tauri::command]
pub async fn batch_apply_preset_snapshot<R: tauri::Runtime>(
    items: Vec<BatchPresetItem>,
    name: String,
    _app: tauri::AppHandle<R>,
) -> Result<u32, String> {
    let preset_path = preset_file_path(&name)?;
    let json = std::fs::read_to_string(&preset_path).map_err(|e| e.to_string())?;
    let file: PresetFile = serde_json::from_str(&json).map_err(|e| e.to_string())?;
    if file.version != 1 {
        return Err(format!("unsupported preset version: {}", file.version));
    }
    let mut count = 0u32;
    for item in items {
        let fingerprint = match item.fingerprint {
            Some(hash) => hash,
            None => {
                if item.path.starts_with("s3://") || item.path.starts_with("ccapi://") {
                    return Err(format!(
                        "remote items must arrive with fingerprint populated: {}",
                        item.path
                    ));
                }
                shade_io::fingerprint_local(std::path::Path::new(&item.path))
                    .map_err(|error| error.to_string())?
                    .fingerprint
                    .to_hex()
            }
        };
        let mut stack = shade_lib::LayerStack::new();
        stack.add_image_layer(0, 1, 1);
        stack.layers.extend(file.layers.clone());
        stack.mask_params = file.mask_params.clone();
        let data = non_image_layer_data(&stack);
        persist_snapshot(&fingerprint, Some(&item.path), None, None, &data).await?;
        count += 1;
    }
    Ok(count)
}
