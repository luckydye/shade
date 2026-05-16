use crate::db::library_db_conn;
use crate::editor_state::{
    broadcast_layer_stack, ensure_non_image_layers, lock_editor_state,
    non_image_layer_data, parse_layer_data, restore_masks_from_params, EditorState,
    PersistedEditVersion, PersistedLayerData,
};
use crate::media_metadata::unix_timestamp_millis;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Mutex;

pub(crate) async fn snapshot_ids_by_source_name(
) -> Result<HashMap<String, String>, String> {
    let conn = library_db_conn().await;
    let mut rows = conn
        .query(
            "SELECT i.source_name, ev.id
             FROM images i
             JOIN edit_versions ev ON ev.fingerprint = i.fingerprint
             WHERE i.source_name IS NOT NULL
             AND ev.created_at = (
                 SELECT MAX(ev2.created_at)
                 FROM edit_versions ev2
                 WHERE ev2.fingerprint = i.fingerprint
             )",
            (),
        )
        .await
        .map_err(|e| e.to_string())?;
    let mut snapshot_ids: HashMap<String, String> = HashMap::new();
    while let Some(row) = rows.next().await.map_err(|e| e.to_string())? {
        let source_name = row.get::<String>(0).map_err(|e| e.to_string())?;
        let id = row.get::<String>(1).map_err(|e| e.to_string())?;
        snapshot_ids.insert(source_name, id);
    }
    Ok(snapshot_ids)
}
pub(crate) async fn load_latest_edit_version(
    fingerprint: &str,
) -> Result<Option<PersistedEditVersion>, String> {
    let conn = library_db_conn().await;
    let mut rows = conn
        .query(
            "SELECT id, layers_json
             FROM edit_versions
             WHERE fingerprint = ?1
             ORDER BY created_at DESC
             LIMIT 1",
            [fingerprint],
        )
        .await
        .map_err(|e| e.to_string())?;
    let Some(row) = rows.next().await.map_err(|e| e.to_string())? else {
        return Ok(None);
    };
    let id = row.get::<String>(0).map_err(|e| e.to_string())?;
    let layers_json = row.get::<String>(1).map_err(|e| e.to_string())?;
    let data = parse_layer_data(&layers_json)?;
    ensure_non_image_layers(&data.layers)?;
    Ok(Some(PersistedEditVersion { id, data }))
}
pub(crate) async fn load_latest_edit_version_by_source(
    source_name: &str,
) -> Result<Option<PersistedEditVersion>, String> {
    let conn = library_db_conn().await;
    let mut rows = conn
        .query(
            "SELECT ev.id, ev.layers_json
             FROM images i
             JOIN edit_versions ev ON ev.fingerprint = i.fingerprint
             WHERE i.source_name = ?1
             ORDER BY ev.created_at DESC
             LIMIT 1",
            [source_name],
        )
        .await
        .map_err(|e| e.to_string())?;
    let Some(row) = rows.next().await.map_err(|e| e.to_string())? else {
        return Ok(None);
    };
    let id = row.get::<String>(0).map_err(|e| e.to_string())?;
    let layers_json = row.get::<String>(1).map_err(|e| e.to_string())?;
    let data = parse_layer_data(&layers_json)?;
    ensure_non_image_layers(&data.layers)?;
    Ok(Some(PersistedEditVersion { id, data }))
}
pub(crate) async fn latest_snapshot_created_at(source_name: &str) -> Option<i64> {
    let conn = library_db_conn().await;
    let mut rows = conn
        .query(
            "SELECT ev.created_at
             FROM images i
             JOIN edit_versions ev ON ev.fingerprint = i.fingerprint
             WHERE i.source_name = ?1
             ORDER BY ev.created_at DESC
             LIMIT 1",
            [source_name],
        )
        .await
        .ok()?;
    rows.next().await.ok()??.get::<i64>(0).ok()
}
pub(crate) async fn has_snapshot_for_source(source_name: &str) -> Result<bool, String> {
    let conn = library_db_conn().await;
    let mut rows = conn
        .query(
            "SELECT 1
             FROM images i
             JOIN edit_versions ev ON ev.fingerprint = i.fingerprint
             WHERE i.source_name = ?1
             LIMIT 1",
            [source_name],
        )
        .await
        .map_err(|e| e.to_string())?;
    Ok(rows.next().await.map_err(|e| e.to_string())?.is_some())
}
pub(crate) async fn register_image_source(
    fingerprint: &str,
    source_name: Option<&str>,
) -> Result<(), String> {
    let conn = library_db_conn().await;
    let now = unix_timestamp_millis()?;
    conn.execute(
        "INSERT INTO images (fingerprint, source_name, created_at)
         VALUES (?1, ?2, ?3)
         ON CONFLICT(fingerprint) DO UPDATE SET source_name = excluded.source_name",
        libsql::params![fingerprint, source_name, now],
    )
    .await
    .map_err(|e| e.to_string())?;
    Ok(())
}
/// Persists a snapshot and returns its UUID id.
/// If `id` is given (e.g. when inserting a synced peer snapshot), that id is used;
/// otherwise a new UUID v4 is generated.
pub(crate) async fn persist_snapshot(
    fingerprint: &str,
    source_name: Option<&str>,
    id: Option<&str>,
    peer_origin: Option<&str>,
    data: &PersistedLayerData,
) -> Result<String, String> {
    ensure_non_image_layers(&data.layers)?;
    register_image_source(fingerprint, source_name).await?;
    let conn = library_db_conn().await;
    let now = unix_timestamp_millis()?;
    let snapshot_id = id
        .map(|s| s.to_owned())
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    conn.execute(
        "INSERT OR IGNORE INTO edit_versions (id, fingerprint, created_at, layers_json, peer_origin)
         VALUES (?1, ?2, ?3, ?4, ?5)",
        libsql::params![
            snapshot_id.as_str(),
            fingerprint,
            now,
            serde_json::to_string(data).map_err(|e| e.to_string())?,
            peer_origin,
        ],
    )
    .await
    .map_err(|e| e.to_string())?;
    Ok(snapshot_id)
}
/// Persists the current edit state. If there is already a current snapshot id,
/// it updates that snapshot in place (upsert). Otherwise creates a new UUID snapshot.
pub(crate) async fn persist_current_edit_version(
    state: &tauri::State<'_, Mutex<EditorState>>,
) -> Result<String, String> {
    let (fingerprint, source_name, data, current_snapshot_id) = {
        let st = lock_editor_state(state)?;
        let fingerprint = st.current_image_hash.clone().ok_or_else(|| {
            "cannot persist edits without a loaded image hash".to_string()
        })?;
        (
            fingerprint,
            st.current_image_source.clone(),
            non_image_layer_data(&st.stack),
            st.current_snapshot_id.clone(),
        )
    };
    let id = if let Some(existing_id) = current_snapshot_id {
        // Update the existing snapshot in place.
        ensure_non_image_layers(&data.layers)?;
        let conn = library_db_conn().await;
        let now = unix_timestamp_millis()?;
        conn.execute(
            "UPDATE edit_versions SET layers_json = ?1, created_at = ?2 WHERE id = ?3",
            libsql::params![
                serde_json::to_string(&data).map_err(|e| e.to_string())?,
                now,
                existing_id.as_str(),
            ],
        )
        .await
        .map_err(|e| e.to_string())?;
        existing_id
    } else {
        persist_snapshot(&fingerprint, source_name.as_deref(), None, None, &data).await?
    };
    let mut st = lock_editor_state(state)?;
    st.current_snapshot_id = Some(id.clone());
    Ok(id)
}
pub(crate) async fn save_new_snapshot(
    state: &tauri::State<'_, Mutex<EditorState>>,
) -> Result<String, String> {
    let (fingerprint, source_name, data) = {
        let st = lock_editor_state(state)?;
        let fingerprint = st.current_image_hash.clone().ok_or_else(|| {
            "cannot save a snapshot without a loaded image hash".to_string()
        })?;
        (
            fingerprint,
            st.current_image_source.clone(),
            non_image_layer_data(&st.stack),
        )
    };
    let id =
        persist_snapshot(&fingerprint, source_name.as_deref(), None, None, &data).await?;
    let mut st = lock_editor_state(state)?;
    st.current_snapshot_id = Some(id.clone());
    Ok(id)
}
pub(crate) async fn list_snapshots_for_file(
    fingerprint: &str,
    current_snapshot_id: Option<&str>,
) -> Result<Vec<SnapshotInfo>, String> {
    let conn = library_db_conn().await;
    // ROW_NUMBER ordered by created_at gives a stable display index.
    let mut rows = conn
        .query(
            "SELECT id, created_at, peer_origin,
                    ROW_NUMBER() OVER (ORDER BY created_at) AS display_index
             FROM edit_versions
             WHERE fingerprint = ?1
             ORDER BY created_at DESC",
            [fingerprint],
        )
        .await
        .map_err(|e| e.to_string())?;
    let mut snapshots = Vec::new();
    while let Some(row) = rows.next().await.map_err(|e| e.to_string())? {
        let id = row.get::<String>(0).map_err(|e| e.to_string())?;
        let created_at = row.get::<i64>(1).map_err(|e| e.to_string())?;
        let peer_origin = row.get::<Option<String>>(2).map_err(|e| e.to_string())?;
        let display_index = row.get::<i64>(3).map_err(|e| e.to_string())?;
        snapshots.push(SnapshotInfo {
            is_current: current_snapshot_id == Some(id.as_str()),
            id,
            display_index,
            created_at,
            peer_origin,
        });
    }
    Ok(snapshots)
}
pub(crate) async fn load_snapshot_by_id(
    fingerprint: &str,
    id: &str,
) -> Result<PersistedEditVersion, String> {
    let conn = library_db_conn().await;
    let mut rows = conn
        .query(
            "SELECT layers_json
             FROM edit_versions
             WHERE fingerprint = ?1 AND id = ?2
             LIMIT 1",
            libsql::params![fingerprint, id],
        )
        .await
        .map_err(|e| e.to_string())?;
    let Some(row) = rows.next().await.map_err(|e| e.to_string())? else {
        return Err(format!("unknown snapshot id: {id}"));
    };
    let layers_json = row.get::<String>(0).map_err(|e| e.to_string())?;
    let data = parse_layer_data(&layers_json)?;
    ensure_non_image_layers(&data.layers)?;
    Ok(PersistedEditVersion {
        id: id.to_owned(),
        data,
    })
}
#[derive(Serialize, Deserialize, Debug)]
pub struct EditSnapshotInfo {
    pub id: String,
}
#[derive(Serialize, Deserialize, Debug)]
pub struct SnapshotInfo {
    pub id: String,
    pub display_index: i64,
    pub created_at: i64,
    pub is_current: bool,
    pub peer_origin: Option<String>,
}
#[derive(Serialize, Deserialize, Debug)]
pub struct LoadSnapshotParams {
    pub id: String,
}
#[tauri::command]
pub async fn save_snapshot(
    state: tauri::State<'_, Mutex<EditorState>>,
) -> Result<EditSnapshotInfo, String> {
    let id = save_new_snapshot(&state).await?;
    Ok(EditSnapshotInfo { id })
}
#[tauri::command]
pub async fn list_snapshots(
    state: tauri::State<'_, Mutex<EditorState>>,
) -> Result<Vec<SnapshotInfo>, String> {
    let (fingerprint, current_snapshot_id) = {
        let st = lock_editor_state(&state)?;
        (
            st.current_image_hash.clone(),
            st.current_snapshot_id.clone(),
        )
    };
    let Some(fingerprint) = fingerprint else {
        return Ok(Vec::new());
    };
    list_snapshots_for_file(&fingerprint, current_snapshot_id.as_deref()).await
}
#[tauri::command]
pub async fn load_snapshot<R: tauri::Runtime>(
    params: LoadSnapshotParams,
    state: tauri::State<'_, Mutex<EditorState>>,
    app: tauri::AppHandle<R>,
) -> Result<(), String> {
    let fingerprint = {
        let st = lock_editor_state(&state)?;
        st.current_image_hash
            .clone()
            .ok_or_else(|| "cannot load a snapshot without a loaded image".to_string())?
    };
    let snapshot = load_snapshot_by_id(&fingerprint, &params.id).await?;
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
            return Err("cannot load a snapshot without a loaded image".into());
        }
        st.stack.layers = image_layers;
        st.stack.masks.clear();
        st.stack.mask_params.clear();
        let base_idx = st.stack.layers.len();
        st.stack.layers.extend(snapshot.data.layers);
        let w = st.canvas_width;
        let h = st.canvas_height;
        restore_masks_from_params(
            &mut st.stack,
            base_idx,
            &snapshot.data.mask_params,
            w,
            h,
        );
        st.stack.generation += 1;
        st.current_snapshot_id = Some(snapshot.id);
    }
    broadcast_layer_stack(&app, &state).await;
    Ok(())
}
