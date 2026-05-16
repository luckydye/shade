use crate::config::{emit_peer_paired, is_peer_paired, pair_peer};
use crate::db::{library_db_conn, SUPERSEDED_IMAGE_LOAD_ERROR};
use crate::editor_state::{
    broadcast_layer_stack, lock_editor_state, restore_persisted_layers, EditorState,
    LayerInfoResponse, PersistedLayerData,
};
use crate::image_loaders::{
    decode_image_bytes_with_info, load_picture_bytes, load_picture_entries,
    load_thumbnail_bytes,
};
use crate::media_libraries::MediaLibrary;
use crate::snapshots::{
    load_latest_edit_version, persist_snapshot, register_image_source,
    snapshot_ids_by_source_name,
};
use serde::Serialize;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use tauri::Manager;
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};
use tokio::sync::Mutex as TokioMutex;

pub(crate) async fn require_p2p(
    p2p: &tauri::State<'_, crate::P2pState>,
) -> Result<std::sync::Arc<shade_p2p::LocalPeerDiscovery>, String> {
    p2p.0
        .read()
        .await
        .clone()
        .ok_or_else(|| "p2p is unavailable on this platform".to_string())
}
pub(crate) async fn sync_peer_snapshots_for_fingerprint(
    peer_endpoint_id: &str,
    fingerprint: &str,
    p2p: &std::sync::Arc<shade_p2p::LocalPeerDiscovery>,
    source_name: Option<&str>,
) -> Result<Vec<String>, String> {
    let peer_snapshots = p2p
        .list_peer_snapshots(peer_endpoint_id, fingerprint)
        .await
        .map_err(|e| e.to_string())?;
    if peer_snapshots.is_empty() {
        return Ok(Vec::new());
    }

    let local_ids = {
        let conn = library_db_conn().await;
        let mut rows = conn
            .query(
                "SELECT id FROM edit_versions WHERE fingerprint = ?1",
                [fingerprint],
            )
            .await
            .map_err(|e| e.to_string())?;
        let mut ids = std::collections::HashSet::new();
        while let Some(row) = rows.next().await.map_err(|e| e.to_string())? {
            if let Ok(id) = row.get::<String>(0) {
                ids.insert(id);
            }
        }
        ids
    };

    let mut synced_ids = Vec::new();
    for snap in peer_snapshots {
        if local_ids.contains(&snap.id) {
            if let Some(source_name) = source_name {
                let conn = library_db_conn().await;
                conn.execute(
                    "UPDATE images SET source_name = ?1 WHERE fingerprint = ?2",
                    libsql::params![source_name, fingerprint],
                )
                .await
                .map_err(|e| e.to_string())?;
            }
            continue;
        }
        let data_bytes =
            match p2p.get_peer_snapshot_data(peer_endpoint_id, &snap.id).await {
                Ok(b) => b,
                Err(e) => {
                    log::warn!("failed to fetch snapshot {} from peer: {}", snap.id, e);
                    continue;
                }
            };
        let layers_json = match String::from_utf8(data_bytes) {
            Ok(j) => j,
            Err(e) => {
                log::warn!("invalid UTF-8 in snapshot {} from peer: {}", snap.id, e);
                continue;
            }
        };
        let data: PersistedLayerData = match serde_json::from_str(&layers_json) {
            Ok(d) => d,
            Err(e) => {
                log::warn!("invalid JSON in snapshot {} from peer: {}", snap.id, e);
                continue;
            }
        };
        if let Err(e) = persist_snapshot(
            fingerprint,
            source_name,
            Some(&snap.id),
            Some(peer_endpoint_id),
            &data,
        )
        .await
        {
            log::warn!("failed to insert snapshot {} from peer: {}", snap.id, e);
            continue;
        }
        synced_ids.push(snap.id);
    }

    Ok(synced_ids)
}
pub(crate) async fn sync_snapshots_from_all_peers_for_fingerprint(
    p2p: &std::sync::Arc<shade_p2p::LocalPeerDiscovery>,
    fingerprint: &str,
) -> Result<Vec<String>, String> {
    let snapshot = p2p.snapshot().await;
    let mut synced_ids = Vec::new();
    for peer in snapshot.peers {
        synced_ids.extend(
            sync_peer_snapshots_for_fingerprint(
                &peer.endpoint_id,
                fingerprint,
                p2p,
                None,
            )
            .await?,
        );
    }
    Ok(synced_ids)
}
#[derive(Serialize, Debug)]
pub struct PeerPictureInfo {
    pub id: String,
    pub name: String,
    pub modified_at: Option<u64>,
    pub has_snapshots: bool,
    pub latest_snapshot_id: Option<String>,
}
pub(crate) async fn discovered_peers_by_endpoint<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
) -> HashMap<String, shade_p2p::LocalPeer> {
    let Some(p2p) = app.state::<crate::P2pState>().0.read().await.clone() else {
        return HashMap::new();
    };
    p2p.snapshot()
        .await
        .peers
        .into_iter()
        .map(|peer| (peer.endpoint_id.clone(), peer))
        .collect()
}
pub(crate) fn peer_library_id(peer_endpoint_id: &str) -> String {
    shade_io::peer_library_id(peer_endpoint_id)
}
pub(crate) fn peer_library_for_endpoint(
    peer_endpoint_id: &str,
    name: &str,
    is_online: bool,
) -> MediaLibrary {
    MediaLibrary {
        id: peer_library_id(peer_endpoint_id),
        name: name.to_owned(),
        kind: "peer".into(),
        path: Some(peer_endpoint_id.to_owned()),
        removable: true,
        readonly: true,
        is_online: Some(is_online),
        is_refreshing: None,
        mode: "browse".into(),
        sync_target: None,
    }
}
#[tauri::command]
pub async fn get_local_peer_discovery_snapshot(
    p2p: tauri::State<'_, crate::P2pState>,
) -> Result<shade_p2p::LocalPeerDiscoverySnapshot, String> {
    Ok(require_p2p(&p2p).await?.snapshot().await)
}
#[tauri::command]
pub async fn pair_peer_device<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    peer_endpoint_id: String,
    pairing_lock: tauri::State<'_, crate::PeerPairingState>,
) -> Result<(), String> {
    if is_peer_paired(&peer_endpoint_id).map_err(|error| error.to_string())? {
        return Ok(());
    }
    let _guard = pairing_lock.0.lock().await;
    if is_peer_paired(&peer_endpoint_id).map_err(|error| error.to_string())? {
        return Ok(());
    }
    let dialog_app = app.clone();
    let peer_endpoint_id_for_prompt = peer_endpoint_id.clone();
    let allow = tokio::task::spawn_blocking(move || -> bool {
        dialog_app
            .dialog()
            .message(format!(
                "Pair peer {peer_endpoint_id_for_prompt} with this device?"
            ))
            .buttons(MessageDialogButtons::OkCancelCustom(
                "Pair".into(),
                "Deny".into(),
            ))
            .blocking_show()
    })
    .await
    .map_err(|error| error.to_string())?;
    if !allow {
        return Err("peer pairing denied".to_string());
    }
    let discovered_peer_name = discovered_peers_by_endpoint(&app)
        .await
        .remove(&peer_endpoint_id)
        .map(|peer| peer.name);
    pair_peer(&peer_endpoint_id, discovered_peer_name.as_deref())
        .map_err(|error| error.to_string())?;
    emit_peer_paired(&app, &peer_endpoint_id)?;
    Ok(())
}
#[tauri::command]
pub async fn list_peer_pictures(
    peer_endpoint_id: String,
    p2p: tauri::State<'_, crate::P2pState>,
) -> Result<Vec<PeerPictureInfo>, String> {
    let pictures = require_p2p(&p2p)
        .await?
        .list_peer_pictures(&peer_endpoint_id)
        .await
        .map_err(|error| error.to_string())?;
    let snapshot_ids = snapshot_ids_by_source_name().await?;
    Ok(pictures
        .into_iter()
        .map(|picture| {
            let latest_snapshot_id = snapshot_ids.get(&picture.id).cloned();
            PeerPictureInfo {
                id: picture.id,
                name: picture.name,
                modified_at: picture.modified_at,
                has_snapshots: latest_snapshot_id.is_some(),
                latest_snapshot_id,
            }
        })
        .collect())
}
#[tauri::command]
pub async fn get_peer_image_bytes(
    peer_endpoint_id: String,
    picture_id: String,
    p2p: tauri::State<'_, crate::P2pState>,
) -> Result<Vec<u8>, String> {
    require_p2p(&p2p)
        .await?
        .get_peer_image_bytes(&peer_endpoint_id, &picture_id)
        .await
        .map_err(|error| error.to_string())
}
/// Update local awareness state (what image we are currently editing).
#[tauri::command]
pub async fn set_local_awareness(
    display_name: Option<String>,
    fingerprint: Option<String>,
    snapshot_id: Option<String>,
    awareness: tauri::State<'_, crate::AwarenessStateHandle>,
) -> Result<(), String> {
    let mut state = awareness.0.lock().await;
    if display_name.is_some() {
        state.display_name = display_name;
    }
    state.active_fingerprint = fingerprint;
    state.active_snapshot_id = snapshot_id;
    Ok(())
}
/// Get the current awareness state of a connected peer.
#[tauri::command]
pub async fn get_peer_awareness(
    peer_endpoint_id: String,
    p2p: tauri::State<'_, crate::P2pState>,
) -> Result<shade_p2p::AwarenessState, String> {
    require_p2p(&p2p)
        .await?
        .get_peer_awareness(&peer_endpoint_id)
        .await
        .map_err(|error| error.to_string())
}
#[derive(Serialize, Debug)]
pub struct SyncPeerSnapshotsResult {
    pub synced_ids: Vec<String>,
}
/// Pull snapshots from a peer for the given fingerprint that we don't have locally.
/// Returns the list of newly inserted snapshot IDs.
#[tauri::command]
pub async fn sync_peer_snapshots(
    peer_endpoint_id: String,
    fingerprint: String,
    p2p: tauri::State<'_, crate::P2pState>,
) -> Result<SyncPeerSnapshotsResult, String> {
    let p2p = require_p2p(&p2p).await?;
    Ok(SyncPeerSnapshotsResult {
        synced_ids: sync_peer_snapshots_for_fingerprint(
            &peer_endpoint_id,
            &fingerprint,
            &p2p,
            None,
        )
        .await?,
    })
}
/// Fetch metadata from a peer for the given file hashes and apply it locally
/// using last-write-wins for ratings and additive union for tags.
#[tauri::command]
pub async fn apply_peer_metadata(
    peer_endpoint_id: String,
    fingerprints: Vec<String>,
    p2p: tauri::State<'_, crate::P2pState>,
) -> Result<ApplyPeerMetadataResult, String> {
    let p2p = require_p2p(&p2p).await?;

    if fingerprints.is_empty() {
        return Ok(ApplyPeerMetadataResult {
            ratings_updated: 0,
            tags_added: 0,
        });
    }

    let peer_metadata = p2p
        .get_peer_metadata(&peer_endpoint_id, &fingerprints)
        .await
        .map_err(|e| e.to_string())?;

    if peer_metadata.is_empty() {
        return Ok(ApplyPeerMetadataResult {
            ratings_updated: 0,
            tags_added: 0,
        });
    }

    let conn = library_db_conn().await;
    let mut ratings_updated: u32 = 0;
    let mut tags_added: u32 = 0;

    for meta in peer_metadata {
        // ── Rating: last-write-wins ──────────────────────────────────────
        if let Some(peer_rating) = meta.rating {
            let peer_ts = meta.rating_updated_at.unwrap_or(0);
            let local_ts: i64 = conn
                .query(
                    "SELECT updated_at FROM media_ratings WHERE fingerprint = ?1 LIMIT 1",
                    [meta.fingerprint.as_str()],
                )
                .await
                .map_err(|e| e.to_string())?
                .next()
                .await
                .map_err(|e| e.to_string())?
                .and_then(|row| row.get::<i64>(0).ok())
                .unwrap_or(0);

            if peer_ts > local_ts {
                conn.execute(
                    "INSERT INTO media_ratings (fingerprint, rating, updated_at)
                     VALUES (?1, ?2, ?3)
                     ON CONFLICT(fingerprint)
                     DO UPDATE SET rating = excluded.rating, updated_at = excluded.updated_at",
                    libsql::params![meta.fingerprint.as_str(), i64::from(peer_rating), peer_ts],
                )
                .await
                .map_err(|e| e.to_string())?;
                ratings_updated += 1;
            }
        }

        // ── Tags: additive union ─────────────────────────────────────────
        if !meta.tags.is_empty() {
            let peer_tags_ts = meta.tags_updated_at.unwrap_or(0);
            let mut existing_tags = std::collections::HashSet::new();
            let mut tag_rows = conn
                .query(
                    "SELECT tag FROM media_tags WHERE fingerprint = ?1",
                    [meta.fingerprint.as_str()],
                )
                .await
                .map_err(|e| e.to_string())?;
            while let Some(row) = tag_rows.next().await.map_err(|e| e.to_string())? {
                if let Ok(tag) = row.get::<String>(0) {
                    existing_tags.insert(tag);
                }
            }
            for tag in &meta.tags {
                if !existing_tags.contains(tag) {
                    conn.execute(
                        "INSERT INTO media_tags (fingerprint, tag, updated_at)
                         VALUES (?1, ?2, ?3)",
                        libsql::params![
                            meta.fingerprint.as_str(),
                            tag.as_str(),
                            peer_tags_ts
                        ],
                    )
                    .await
                    .map_err(|e| e.to_string())?;
                    tags_added += 1;
                }
            }
        }
    }

    Ok(ApplyPeerMetadataResult {
        ratings_updated,
        tags_added,
    })
}
#[derive(Serialize, Debug)]
pub struct ApplyPeerMetadataResult {
    pub ratings_updated: u32,
    pub tags_added: u32,
}
#[tauri::command]
pub async fn open_peer_image<R: tauri::Runtime>(
    peer_endpoint_id: String,
    picture_id: String,
    file_name: Option<String>,
    p2p: tauri::State<'_, crate::P2pState>,
    state: tauri::State<'_, Mutex<EditorState>>,
    app: tauri::AppHandle<R>,
) -> Result<LayerInfoResponse, String> {
    let open_request_id = {
        let mut st = lock_editor_state(&state)?;
        st.begin_open_request()
    };
    let bytes = require_p2p(&p2p)
        .await?
        .get_peer_image_bytes(&peer_endpoint_id, &picture_id)
        .await
        .map_err(|error| error.to_string())?;
    let fingerprint = shade_io::fingerprint_from_bytes(&bytes).to_hex();
    let peer = require_p2p(&p2p).await?;
    let _ = sync_peer_snapshots_for_fingerprint(
        &peer_endpoint_id,
        &fingerprint,
        &peer,
        Some(&picture_id),
    )
    .await;
    register_image_source(&fingerprint, Some(&picture_id)).await?;
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
        restore_persisted_layers(
            &mut st,
            fingerprint.clone(),
            Some(picture_id),
            persisted,
        )?;
        response.fingerprint = Some(fingerprint);
        response
    };
    broadcast_layer_stack(&app, &state).await;
    Ok(response)
}
pub struct AppPeerProvider<R: tauri::Runtime = tauri::Wry> {
    pub(crate) app: tauri::AppHandle<R>,
    pub(crate) prompt_lock: Arc<TokioMutex<()>>,
    pub(crate) awareness: Arc<tokio::sync::Mutex<shade_p2p::AwarenessState>>,
}
impl<R: tauri::Runtime> AppPeerProvider<R> {
    pub fn new(
        app: tauri::AppHandle<R>,
        awareness: Arc<tokio::sync::Mutex<shade_p2p::AwarenessState>>,
        prompt_lock: Arc<TokioMutex<()>>,
    ) -> Self {
        Self {
            app,
            prompt_lock,
            awareness,
        }
    }
}
#[async_trait::async_trait]
impl<R: tauri::Runtime> shade_p2p::PeerProvider for AppPeerProvider<R> {
    async fn authorize_peer(&self, peer_endpoint_id: &str) -> anyhow::Result<()> {
        if is_peer_paired(peer_endpoint_id).map_err(anyhow::Error::msg)? {
            return Ok(());
        }
        let _guard = self.prompt_lock.lock().await;
        if is_peer_paired(peer_endpoint_id).map_err(anyhow::Error::msg)? {
            return Ok(());
        }
        let app = self.app.clone();
        let peer_endpoint_id = peer_endpoint_id.to_owned();
        let peer_endpoint_id_for_prompt = peer_endpoint_id.clone();
        let allow = tokio::task::spawn_blocking(move || {
            app.dialog()
                .message(format!(
                    "Peer {peer_endpoint_id_for_prompt} wants to browse your media library.\nAllow and pair this peer on this device?"
                ))
                .buttons(MessageDialogButtons::OkCancelCustom("Pair".into(), "Deny".into()))
                .blocking_show()
        })
        .await
        .map_err(|error| anyhow::anyhow!(error.to_string()))?;
        if !allow {
            return Err(anyhow::anyhow!("peer access denied"));
        }
        let discovered_peer_name = discovered_peers_by_endpoint(&self.app)
            .await
            .remove(&peer_endpoint_id)
            .map(|peer| peer.name);
        pair_peer(&peer_endpoint_id, discovered_peer_name.as_deref())
            .map_err(anyhow::Error::msg)?;
        emit_peer_paired(&self.app, &peer_endpoint_id).map_err(anyhow::Error::msg)?;
        Ok(())
    }

    async fn list_pictures(&self) -> anyhow::Result<Vec<shade_p2p::SharedPicture>> {
        load_picture_entries(self.app.clone())
            .await
            .map_err(anyhow::Error::msg)
    }

    async fn get_thumbnail(&self, picture_id: &str) -> anyhow::Result<Vec<u8>> {
        load_thumbnail_bytes(self.app.clone(), picture_id)
            .await
            .map_err(anyhow::Error::msg)
    }

    async fn get_image_bytes(&self, picture_id: &str) -> anyhow::Result<Vec<u8>> {
        load_picture_bytes(self.app.clone(), picture_id)
            .await
            .map_err(anyhow::Error::msg)
    }

    async fn get_awareness(&self) -> anyhow::Result<shade_p2p::AwarenessState> {
        Ok(self.awareness.lock().await.clone())
    }

    async fn list_snapshots(
        &self,
        fingerprint: &str,
    ) -> anyhow::Result<Vec<shade_p2p::SyncSnapshotInfo>> {
        let conn = library_db_conn().await;
        let mut rows = conn
            .query(
                "SELECT id, created_at FROM edit_versions WHERE fingerprint = ?1 ORDER BY created_at DESC",
                [fingerprint],
            )
            .await
            .map_err(|e| anyhow::anyhow!(e.to_string()))?;
        let mut list = Vec::new();
        while let Some(row) = rows
            .next()
            .await
            .map_err(|e| anyhow::anyhow!(e.to_string()))?
        {
            let id = row
                .get::<String>(0)
                .map_err(|e| anyhow::anyhow!(e.to_string()))?;
            let created_at = row
                .get::<i64>(1)
                .map_err(|e| anyhow::anyhow!(e.to_string()))?;
            list.push(shade_p2p::SyncSnapshotInfo { id, created_at });
        }
        Ok(list)
    }

    async fn get_snapshot_data(&self, id: &str) -> anyhow::Result<Vec<u8>> {
        let conn = library_db_conn().await;
        let mut rows = conn
            .query(
                "SELECT layers_json FROM edit_versions WHERE id = ?1 LIMIT 1",
                [id],
            )
            .await
            .map_err(|e| anyhow::anyhow!(e.to_string()))?;
        let Some(row) = rows
            .next()
            .await
            .map_err(|e| anyhow::anyhow!(e.to_string()))?
        else {
            return Err(anyhow::anyhow!("snapshot not found: {id}"));
        };
        let layers_json = row
            .get::<String>(0)
            .map_err(|e| anyhow::anyhow!(e.to_string()))?;
        Ok(layers_json.into_bytes())
    }

    async fn get_metadata(
        &self,
        fingerprints: &[String],
    ) -> anyhow::Result<Vec<shade_p2p::PictureMetadata>> {
        if fingerprints.is_empty() {
            return Ok(Vec::new());
        }
        let conn = library_db_conn().await;
        let mut result = Vec::new();
        for fingerprint in fingerprints {
            let mut rating_rows = conn
                .query(
                    "SELECT rating, updated_at FROM media_ratings WHERE fingerprint = ?1 LIMIT 1",
                    [fingerprint.as_str()],
                )
                .await
                .map_err(|e| anyhow::anyhow!(e.to_string()))?;
            let (rating, rating_updated_at) = if let Some(row) = rating_rows
                .next()
                .await
                .map_err(|e| anyhow::anyhow!(e.to_string()))?
            {
                let r = row
                    .get::<i64>(0)
                    .ok()
                    .and_then(|value| u8::try_from(value).ok());
                let t = row.get::<i64>(1).ok();
                (r, t)
            } else {
                (None, None)
            };
            let mut tag_rows = conn
                .query(
                    "SELECT tag, updated_at FROM media_tags WHERE fingerprint = ?1",
                    [fingerprint.as_str()],
                )
                .await
                .map_err(|e| anyhow::anyhow!(e.to_string()))?;
            let mut tags = Vec::new();
            let mut tags_updated_at: Option<i64> = None;
            while let Some(row) = tag_rows
                .next()
                .await
                .map_err(|e| anyhow::anyhow!(e.to_string()))?
            {
                let tag = row
                    .get::<String>(0)
                    .map_err(|e| anyhow::anyhow!(e.to_string()))?;
                let t = row.get::<i64>(1).ok();
                tags.push(tag);
                if let Some(t) = t {
                    tags_updated_at =
                        Some(tags_updated_at.map_or(t, |existing| existing.max(t)));
                }
            }
            result.push(shade_p2p::PictureMetadata {
                fingerprint: fingerprint.clone(),
                rating,
                tags,
                rating_updated_at,
                tags_updated_at,
            });
        }
        Ok(result)
    }
}
