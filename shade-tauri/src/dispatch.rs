use crate::batch::{batch_clear_edits, batch_export_images, BatchExportItem};
use crate::collections::{
    add_to_collection, create_collection, delete_collection, list_collection_items,
    list_collections, remove_from_collection, rename_collection, reorder_collection,
};
use crate::edit_apply::{apply_edit, EditParams};
use crate::editor_state::{lock_editor_state, EditorState};
use crate::image_loaders::list_pictures;
use crate::layers::{
    add_layer, delete_layer, get_stack_snapshot, move_layer, rename_layer, replace_stack,
    set_layer_opacity, set_layer_visible, DeleteLayerParams, LayerOpacityParams,
    LayerVisibility, MoveLayerParams, RenameLayerParams,
};
use crate::masks::{
    apply_gradient_mask, create_brush_mask, remove_mask, stamp_brush_mask,
    CreateBrushMaskParams, GradientMaskParams, RemoveMaskParams, StampBrushMaskParams,
};
use crate::media_libraries::{
    add_media_library, add_s3_media_library, build_library_listing,
    delete_media_library_item, enrich_listing_metadata, get_s3_media_library,
    list_media_libraries, refresh_library_index, remove_media_library, set_library_mode,
    set_media_library_order, update_s3_media_library, upload_media_library_file,
    upload_media_library_path, upload_media_library_url,
};
use crate::media_metadata::{
    list_media_ratings, persist_media_rating, persist_media_tags,
};
use crate::peers::{
    apply_peer_metadata, get_local_peer_discovery_snapshot, get_peer_awareness,
    list_peer_pictures, pair_peer_device, set_local_awareness, sync_peer_snapshots,
};
use crate::presets::{
    apply_preset_snapshot, batch_apply_preset_snapshot, delete_preset, get_preset_json,
    get_snapshot_preset_json, list_presets, load_preset, rename_preset, save_preset,
    save_preset_from_json, BatchPresetItem,
};
use crate::snapshots::{
    list_snapshots, load_snapshot, save_snapshot, LoadSnapshotParams,
};
use crate::sync::sync_library;
use crate::text_layers::{
    add_font, add_text_layer, list_fonts, prune_unused_fonts, set_text_transform,
    update_text_content, update_text_style, AddFontParams, AddTextLayerParams,
    SetTextTransformParams, UpdateTextContentParams, UpdateTextStyleParams,
};
use std::sync::Mutex;

/// Single JS → Rust read dispatcher. Each variant of
/// [`ReadRequest`](crate::channel_protocol::ReadRequest) is routed to the
/// corresponding read fn; the result is serialised and pushed back over the
/// coordination channel as `ChannelMessage::ReadResponse` keyed by `read_id`.
/// Failures land as `ChannelMessage::ReadFailed`.
#[tauri::command]
pub async fn dispatch_read<R: tauri::Runtime>(
    read_id: u32,
    request: crate::channel_protocol::ReadRequest,
    state: tauri::State<'_, Mutex<EditorState>>,
    app: tauri::AppHandle<R>,
    p2p: tauri::State<'_, crate::P2pState>,
) -> Result<(), String> {
    use crate::channel_protocol::ReadRequest as R;
    let coord = crate::channel_server::channel_from_app(&app);

    // Streaming reads short-circuit: they emit their own ReadResponse chunks
    // and return early. Single-shot reads fall through to the common send.
    if let R::ListLibraryImages { library_id } = &request {
        let library_id = library_id.clone();
        let outcome = async {
            let mut listing = build_library_listing(&app, library_id).await?;
            enrich_listing_metadata(&mut listing).await?;
            const CHUNK_SIZE: usize = 256;
            let mut iter = listing.items.into_iter().peekable();
            let mut sent_any = false;
            while iter.peek().is_some() {
                let chunk: Vec<_> = iter.by_ref().take(CHUNK_SIZE).collect();
                let value = serde_json::to_value(&chunk).map_err(|e| e.to_string())?;
                let done = iter.peek().is_none();
                coord
                    .send(crate::ChannelMessage::ReadResponse {
                        read_id,
                        kind: "library_images_chunk".to_string(),
                        value,
                        done,
                    })
                    .await;
                sent_any = true;
            }
            if !sent_any {
                coord
                    .send(crate::ChannelMessage::ReadResponse {
                        read_id,
                        kind: "library_images_chunk".to_string(),
                        value: serde_json::Value::Array(Vec::new()),
                        done: true,
                    })
                    .await;
            }
            Ok::<(), String>(())
        }
        .await;
        if let Err(message) = outcome {
            coord
                .send(crate::ChannelMessage::ReadFailed { read_id, message })
                .await;
        }
        return Ok(());
    }

    let outcome: Result<(&'static str, serde_json::Value), String> = match request {
        R::ListLibraryImages { .. } => unreachable!("handled above"),
        R::ListPictures => list_pictures(app.clone())
            .await
            .and_then(|v| serde_json::to_value(v).map_err(|e| e.to_string()))
            .map(|v| ("pictures", v)),
        R::ListMediaLibraries => list_media_libraries(app.clone())
            .await
            .and_then(|v| serde_json::to_value(v).map_err(|e| e.to_string()))
            .map(|v| ("media_libraries", v)),
        R::ListMediaRatings { fingerprints } => list_media_ratings(fingerprints)
            .await
            .and_then(|v| serde_json::to_value(v).map_err(|e| e.to_string()))
            .map(|v| ("media_ratings", v)),
        R::ListPresets => list_presets()
            .await
            .and_then(|v| serde_json::to_value(v).map_err(|e| e.to_string()))
            .map(|v| ("presets", v)),
        R::ListSnapshots => list_snapshots(state)
            .await
            .and_then(|v| serde_json::to_value(v).map_err(|e| e.to_string()))
            .map(|v| ("snapshots", v)),
        R::ListCollections { library_id } => list_collections(library_id)
            .await
            .and_then(|v| serde_json::to_value(v).map_err(|e| e.to_string()))
            .map(|v| ("collections", v)),
        R::ListCollectionItems { collection_id } => list_collection_items(collection_id)
            .await
            .and_then(|v| serde_json::to_value(v).map_err(|e| e.to_string()))
            .map(|v| ("collection_items", v)),
        R::ListPeerPictures { peer_endpoint_id } => {
            list_peer_pictures(peer_endpoint_id, p2p)
                .await
                .and_then(|v| serde_json::to_value(v).map_err(|e| e.to_string()))
                .map(|v| ("peer_pictures", v))
        }
        R::GetLocalPeerDiscoverySnapshot => get_local_peer_discovery_snapshot(p2p)
            .await
            .and_then(|v| serde_json::to_value(v).map_err(|e| e.to_string()))
            .map(|v| ("local_peer_discovery_snapshot", v)),
        R::GetS3MediaLibrary { library_id } => get_s3_media_library(library_id)
            .await
            .and_then(|v| serde_json::to_value(v).map_err(|e| e.to_string()))
            .map(|v| ("s3_media_library", v)),
        R::GetPresetJson { name } => get_preset_json(name)
            .await
            .and_then(|v| serde_json::to_value(v).map_err(|e| e.to_string()))
            .map(|v| ("preset_json", v)),
        R::GetSnapshotPresetJson { fingerprint } => get_snapshot_preset_json(fingerprint)
            .await
            .and_then(|v| serde_json::to_value(v).map_err(|e| e.to_string()))
            .map(|v| ("snapshot_preset_json", v)),
        R::GetPeerAwareness { peer_endpoint_id } => {
            get_peer_awareness(peer_endpoint_id, p2p)
                .await
                .and_then(|v| serde_json::to_value(v).map_err(|e| e.to_string()))
                .map(|v| ("peer_awareness", v))
        }
        R::GetStackSnapshot => get_stack_snapshot(state)
            .and_then(|v| serde_json::to_value(v).map_err(|e| e.to_string()))
            .map(|v| ("stack_snapshot", v)),
        R::SyncPeerSnapshots {
            peer_endpoint_id,
            fingerprint,
        } => sync_peer_snapshots(peer_endpoint_id, fingerprint, p2p)
            .await
            .and_then(|v| serde_json::to_value(v).map_err(|e| e.to_string()))
            .map(|v| ("sync_peer_snapshots_result", v)),
        R::ListFonts => list_fonts(state)
            .and_then(|v| serde_json::to_value(v).map_err(|e| e.to_string()))
            .map(|v| ("fonts", v)),
    };
    match outcome {
        Ok((kind, value)) => {
            coord
                .send(crate::ChannelMessage::ReadResponse {
                    read_id,
                    kind: kind.to_string(),
                    value,
                    done: true,
                })
                .await;
        }
        Err(message) => {
            coord
                .send(crate::ChannelMessage::ReadFailed { read_id, message })
                .await;
        }
    }
    Ok(())
}
/// Single JS → Rust mutation dispatcher. Each variant of
/// [`MutationRequest`](crate::channel_protocol::MutationRequest) is routed to
/// the corresponding command body; persistence and the resulting
/// `LayerStackSnapshot` broadcast happen inside each command via
/// `finalize_layer_stack_mutation`.
///
/// Return values that the granular invokes used to produce
/// (`add_layer`/`move_layer` → idx, `apply_preset_snapshot` → snapshot id)
/// are discarded here; callers derive layer positions from the snapshot, and
/// snapshot-id consumers (none today) would subscribe to a future
/// `SnapshotSaved` channel message.
#[tauri::command]
pub async fn dispatch_mutation<R: tauri::Runtime>(
    request: crate::channel_protocol::MutationRequest,
    state: tauri::State<'_, Mutex<EditorState>>,
    app: tauri::AppHandle<R>,
    p2p: tauri::State<'_, crate::P2pState>,
    pairing_lock: tauri::State<'_, crate::PeerPairingState>,
    awareness: tauri::State<'_, crate::AwarenessStateHandle>,
    render_service: tauri::State<'_, crate::RenderService>,
) -> Result<(), String> {
    use crate::channel_protocol::MutationRequest as M;
    match request {
        M::AddLayer { kind } => {
            let _idx = add_layer(kind, state, app).await?;
        }
        M::DeleteLayer { idx } => {
            delete_layer(DeleteLayerParams { layer_idx: idx }, state, app).await?;
        }
        M::MoveLayer { from, to } => {
            let _idx = move_layer(
                MoveLayerParams {
                    from_idx: from,
                    to_idx: to,
                },
                state,
                app,
            )
            .await?;
        }
        M::SetLayerVisible { idx, visible } => {
            set_layer_visible(
                LayerVisibility {
                    layer_idx: idx,
                    visible,
                },
                state,
                app,
            )
            .await?;
        }
        M::SetLayerOpacity { idx, opacity } => {
            set_layer_opacity(
                LayerOpacityParams {
                    layer_idx: idx,
                    opacity,
                },
                state,
                app,
            )
            .await?;
        }
        M::RenameLayer { idx, name } => {
            rename_layer(
                RenameLayerParams {
                    layer_idx: idx,
                    name,
                },
                state,
                app,
            )
            .await?;
        }
        M::ReplaceStack { layers_json } => {
            replace_stack(layers_json, state, app).await?;
        }
        M::ApplyEdit(value) => {
            let params: EditParams = serde_json::from_value(value)
                .map_err(|e| format!("apply_edit: invalid params: {e}"))?;
            apply_edit(params, state, app).await?;
        }
        M::ApplyGradientMask(value) => {
            let params: GradientMaskParams = serde_json::from_value(value)
                .map_err(|e| format!("apply_gradient_mask: invalid params: {e}"))?;
            apply_gradient_mask(params, state, app).await?;
        }
        M::RemoveMask { idx } => {
            remove_mask(RemoveMaskParams { layer_idx: idx }, state, app).await?;
        }
        M::CreateBrushMask { idx } => {
            create_brush_mask(CreateBrushMaskParams { layer_idx: idx }, state, app)
                .await?;
        }
        M::StampBrushMask(value) => {
            let params: StampBrushMaskParams = serde_json::from_value(value)
                .map_err(|e| format!("stamp_brush_mask: invalid params: {e}"))?;
            // Brush strokes mutate mask pixel data only; mask params (the
            // shape visible in LayerStackSnapshot) don't change, so no
            // snapshot broadcast is needed per stroke.
            stamp_brush_mask(params, state).await?;
        }
        M::LoadSnapshot { id } => {
            load_snapshot(LoadSnapshotParams { id }, state, app).await?;
        }
        M::LoadPreset { name } => {
            load_preset(name, state, app).await?;
        }
        M::ApplyPresetSnapshot { name } => {
            let _info = apply_preset_snapshot(name, state, app).await?;
        }
        M::AddTextLayer {
            content,
            font_id,
            size_px,
        } => {
            let _idx = add_text_layer(
                AddTextLayerParams {
                    content,
                    font_id,
                    size_px,
                },
                state,
                app,
            )
            .await?;
        }
        M::UpdateTextContent { layer_idx, content } => {
            update_text_content(
                UpdateTextContentParams { layer_idx, content },
                state,
                app,
            )
            .await?;
        }
        M::UpdateTextStyle(value) => {
            let params: UpdateTextStyleParams = serde_json::from_value(value)
                .map_err(|e| format!("update_text_style: invalid params: {e}"))?;
            update_text_style(params, state, app).await?;
        }
        M::SetTextTransform {
            layer_idx,
            tx,
            ty,
            scale_x,
            scale_y,
            rotation,
        } => {
            set_text_transform(
                SetTextTransformParams {
                    layer_idx,
                    tx,
                    ty,
                    scale_x,
                    scale_y,
                    rotation,
                },
                state,
                app,
            )
            .await?;
        }
        M::AddFont { family, bytes } => {
            let _id = add_font(AddFontParams { family, bytes }, state, app).await?;
        }
        M::PruneUnusedFonts => {
            let _removed = prune_unused_fonts(state, app).await?;
        }
        M::SetMediaRating {
            fingerprint,
            rating,
        } => {
            if fingerprint.trim().is_empty() {
                return Err("file hash cannot be empty".to_string());
            }
            persist_media_rating(&fingerprint, rating).await?;
            crate::channel_server::channel_from_app(&app)
                .send(crate::ChannelMessage::MediaMetadataChanged {
                    fingerprints: vec![fingerprint],
                })
                .await;
        }
        M::SetMediaTags { fingerprint, tags } => {
            if fingerprint.trim().is_empty() {
                return Err("file hash cannot be empty".to_string());
            }
            persist_media_tags(&fingerprint, &tags).await?;
            crate::channel_server::channel_from_app(&app)
                .send(crate::ChannelMessage::MediaMetadataChanged {
                    fingerprints: vec![fingerprint],
                })
                .await;
        }
        M::ApplyPeerMetadata {
            peer_endpoint_id,
            fingerprints,
        } => {
            let touched = fingerprints.clone();
            let _result =
                apply_peer_metadata(peer_endpoint_id, fingerprints, p2p).await?;
            crate::channel_server::channel_from_app(&app)
                .send(crate::ChannelMessage::MediaMetadataChanged {
                    fingerprints: touched,
                })
                .await;
        }
        M::SavePreset { name } => {
            let _info = save_preset(name, state).await?;
            crate::channel_server::channel_from_app(&app)
                .send(crate::ChannelMessage::PresetListChanged)
                .await;
        }
        M::SavePresetFromJson { name, json } => {
            save_preset_from_json(name, json).await?;
            crate::channel_server::channel_from_app(&app)
                .send(crate::ChannelMessage::PresetListChanged)
                .await;
        }
        M::RenamePreset { old_name, new_name } => {
            let _info = rename_preset(old_name, new_name).await?;
            crate::channel_server::channel_from_app(&app)
                .send(crate::ChannelMessage::PresetListChanged)
                .await;
        }
        M::DeletePreset { name } => {
            delete_preset(name).await?;
            crate::channel_server::channel_from_app(&app)
                .send(crate::ChannelMessage::PresetListChanged)
                .await;
        }
        M::CreateCollection { library_id, name } => {
            let collection = create_collection(library_id, name).await?;
            let value = serde_json::to_value(&collection).map_err(|e| e.to_string())?;
            let coord = crate::channel_server::channel_from_app(&app);
            coord
                .send(crate::ChannelMessage::CollectionCreated { collection: value })
                .await;
            coord
                .send(crate::ChannelMessage::CollectionListChanged)
                .await;
        }
        M::RenameCollection {
            collection_id,
            name,
        } => {
            rename_collection(collection_id.clone(), name).await?;
            crate::channel_server::channel_from_app(&app)
                .send(crate::ChannelMessage::CollectionChanged { collection_id })
                .await;
        }
        M::DeleteCollection { collection_id } => {
            delete_collection(collection_id).await?;
            crate::channel_server::channel_from_app(&app)
                .send(crate::ChannelMessage::CollectionListChanged)
                .await;
        }
        M::ReorderCollection {
            collection_id,
            new_position,
        } => {
            reorder_collection(collection_id, new_position).await?;
            crate::channel_server::channel_from_app(&app)
                .send(crate::ChannelMessage::CollectionListChanged)
                .await;
        }
        M::AddToCollection {
            collection_id,
            fingerprints,
        } => {
            add_to_collection(collection_id.clone(), fingerprints).await?;
            crate::channel_server::channel_from_app(&app)
                .send(crate::ChannelMessage::CollectionChanged { collection_id })
                .await;
        }
        M::RemoveFromCollection {
            collection_id,
            fingerprints,
        } => {
            remove_from_collection(collection_id.clone(), fingerprints).await?;
            crate::channel_server::channel_from_app(&app)
                .send(crate::ChannelMessage::CollectionChanged { collection_id })
                .await;
        }
        M::BatchApplyPresetSnapshot { items, name } => {
            let items: Vec<BatchPresetItem> =
                serde_json::from_value(items).map_err(|e| {
                    format!("batch_apply_preset_snapshot: invalid items: {e}")
                })?;
            let count = batch_apply_preset_snapshot(items, name, app.clone()).await?;
            crate::channel_server::channel_from_app(&app)
                .send(crate::ChannelMessage::BatchCompleted {
                    kind: "apply_preset_snapshot".to_string(),
                    count,
                })
                .await;
        }
        M::BatchClearEdits { paths } => {
            let count = batch_clear_edits(paths).await?;
            crate::channel_server::channel_from_app(&app)
                .send(crate::ChannelMessage::BatchCompleted {
                    kind: "clear_edits".to_string(),
                    count,
                })
                .await;
        }
        M::BatchExportImages { items, target_dir } => {
            let items: Vec<BatchExportItem> = serde_json::from_value(items)
                .map_err(|e| format!("batch_export_images: invalid items: {e}"))?;
            let count =
                batch_export_images(items, target_dir, app.clone(), render_service)
                    .await?;
            crate::channel_server::channel_from_app(&app)
                .send(crate::ChannelMessage::BatchCompleted {
                    kind: "export_images".to_string(),
                    count,
                })
                .await;
        }
        M::AddMediaLibrary { path } => {
            let library = add_media_library(app.clone(), path).await?;
            let value = serde_json::to_value(&library).map_err(|e| e.to_string())?;
            let coord = crate::channel_server::channel_from_app(&app);
            coord
                .send(crate::ChannelMessage::MediaLibraryUpserted { library: value })
                .await;
            coord
                .send(crate::ChannelMessage::MediaLibrariesChanged)
                .await;
        }
        M::AddS3MediaLibrary { params } => {
            let params: shade_io::AddS3LibraryParams = serde_json::from_value(params)
                .map_err(|e| format!("add_s3_media_library: invalid params: {e}"))?;
            let library = add_s3_media_library(app.clone(), params).await?;
            let value = serde_json::to_value(&library).map_err(|e| e.to_string())?;
            let coord = crate::channel_server::channel_from_app(&app);
            coord
                .send(crate::ChannelMessage::MediaLibraryUpserted { library: value })
                .await;
            coord
                .send(crate::ChannelMessage::MediaLibrariesChanged)
                .await;
        }
        M::UpdateS3MediaLibrary { library_id, params } => {
            let params: shade_io::AddS3LibraryParams = serde_json::from_value(params)
                .map_err(|e| format!("update_s3_media_library: invalid params: {e}"))?;
            let library =
                update_s3_media_library(app.clone(), library_id, params).await?;
            let value = serde_json::to_value(&library).map_err(|e| e.to_string())?;
            let coord = crate::channel_server::channel_from_app(&app);
            coord
                .send(crate::ChannelMessage::MediaLibraryUpserted { library: value })
                .await;
            coord
                .send(crate::ChannelMessage::MediaLibrariesChanged)
                .await;
        }
        M::SaveSnapshot => {
            let info = save_snapshot(state.clone()).await?;
            let fingerprint = {
                let st = lock_editor_state(&state)?;
                st.current_image_hash.clone()
            };
            crate::channel_server::channel_from_app(&app)
                .send(crate::ChannelMessage::SnapshotSaved {
                    fingerprint,
                    id: info.id,
                })
                .await;
        }
        M::SetMediaLibraryOrder { library_order } => {
            set_media_library_order(library_order).await?;
            crate::channel_server::channel_from_app(&app)
                .send(crate::ChannelMessage::MediaLibrariesChanged)
                .await;
        }
        M::SetLibraryMode {
            library_id,
            mode,
            sync_target,
        } => {
            set_library_mode(library_id, mode, sync_target).await?;
            crate::channel_server::channel_from_app(&app)
                .send(crate::ChannelMessage::MediaLibrariesChanged)
                .await;
        }
        M::SyncLibrary { library_id } => {
            sync_library(app.clone(), library_id, p2p).await?;
            crate::channel_server::channel_from_app(&app)
                .send(crate::ChannelMessage::MediaLibrariesChanged)
                .await;
        }
        M::RefreshLibraryIndex { library_id } => {
            refresh_library_index(app.clone(), library_id).await?;
            crate::channel_server::channel_from_app(&app)
                .send(crate::ChannelMessage::MediaLibrariesChanged)
                .await;
        }
        M::DeleteMediaLibraryItem { path } => {
            delete_media_library_item(app.clone(), path).await?;
            crate::channel_server::channel_from_app(&app)
                .send(crate::ChannelMessage::MediaLibrariesChanged)
                .await;
        }
        M::RemoveMediaLibrary { id } => {
            remove_media_library(app.clone(), id).await?;
            crate::channel_server::channel_from_app(&app)
                .send(crate::ChannelMessage::MediaLibrariesChanged)
                .await;
        }
        M::UploadMediaLibraryUrl {
            library_id,
            url,
            file_name,
        } => {
            upload_media_library_url(app.clone(), library_id, url, file_name).await?;
            crate::channel_server::channel_from_app(&app)
                .send(crate::ChannelMessage::MediaLibrariesChanged)
                .await;
        }
        M::UploadMediaLibraryFile {
            library_id,
            file_name,
            bytes,
            modified_at,
            append_timestamp_on_conflict,
        } => {
            upload_media_library_file(
                app.clone(),
                library_id,
                file_name,
                bytes,
                modified_at,
                append_timestamp_on_conflict,
            )
            .await?;
            crate::channel_server::channel_from_app(&app)
                .send(crate::ChannelMessage::MediaLibrariesChanged)
                .await;
        }
        M::UploadMediaLibraryPath { library_id, path } => {
            upload_media_library_path(app.clone(), library_id, path).await?;
            crate::channel_server::channel_from_app(&app)
                .send(crate::ChannelMessage::MediaLibrariesChanged)
                .await;
        }
        M::PairPeerDevice { peer_endpoint_id } => {
            let peer_id = peer_endpoint_id.clone();
            pair_peer_device(app.clone(), peer_endpoint_id, pairing_lock).await?;
            // PeerPaired is already emitted by the inbound handshake path
            // (`emit_peer_paired`); fire it here too so outbound pairing is
            // visible to subscribers uniformly.
            crate::channel_server::channel_from_app(&app)
                .send(crate::ChannelMessage::PeerPaired {
                    peer_id,
                    name: String::new(),
                })
                .await;
        }
        M::SetLocalAwareness {
            display_name,
            fingerprint,
            snapshot_id,
        } => {
            set_local_awareness(display_name, fingerprint, snapshot_id, awareness)
                .await?;
            // No notification — local awareness is owned by the frontend's
            // view; remote awareness changes ride `PeerAwarenessUpdate`.
        }
    }
    Ok(())
}
