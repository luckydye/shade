//! Coordination channel protocol — metadata-only messages between Rust and JS.
//!
//! Carries: viewport state (JS → Rust), invalidation/progress/lightweight metadata
//! (Rust → JS). Never carries pixel buffers or other binary payloads — those go
//! through the dedicated preview channel or the `shade://` custom protocol.

use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Clone, Copy, Debug)]
#[serde(rename_all = "snake_case")]
pub enum PreviewQuality {
    Interactive,
    Final,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct PreviewCropMessage {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct ArtboardViewport {
    pub artboard_id: String,
    pub crop: PreviewCropMessage,
    pub target_width: u32,
    pub target_height: u32,
    #[serde(default)]
    pub priority: u32,
    #[serde(default)]
    pub ignore_crop_layers: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct AwarenessStateMessage {
    #[serde(default)]
    pub cursor: Option<(f64, f64)>,
    #[serde(default)]
    pub selection: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ChannelMessage {
    // JS → Rust
    UpdatePreviewViewports {
        generation: u64,
        quality: PreviewQuality,
        viewports: Vec<ArtboardViewport>,
    },

    // Library (Rust → JS)
    LibraryScanProgress {
        library_id: String,
        #[serde(default)]
        scanned: u64,
        #[serde(default)]
        total: u64,
    },
    LibraryScanComplete {
        library_id: String,
    },
    // Thumbnail (Rust → JS)
    ThumbnailReady {
        path: String,
        edit_fingerprint: String,
    },

    // Batch (Rust → JS)
    BatchExportProgress {
        current: u32,
        total: u32,
        name: String,
        #[serde(default)]
        error: Option<String>,
    },
    // Final completion message for a batch mutation (apply_preset_snapshot /
    // clear_edits). Carries the actual count of items the backend processed.
    // Correlation is by `kind`; the UI never fires concurrent batches of the
    // same kind, so the bridge can one-shot subscribe to the next message.
    BatchCompleted {
        kind: String,
        count: u32,
    },

    // Peer (Rust → JS)
    PeerPaired {
        peer_id: String,
        name: String,
    },
    PeerAwarenessUpdate {
        peer_id: String,
        state: AwarenessStateMessage,
    },

    // Collections / Presets (Rust → JS)
    CollectionChanged {
        collection_id: String,
    },
    PresetListChanged,

    // Camera (Rust → JS)
    CameraHostsChanged {
        hosts: Vec<String>,
    },

    // Authoritative layer-stack state (Rust → JS). Pushed after every mutation
    // and on demand; replaces the `get_layer_stack` refetch pattern. The
    // payload carries the same shape as the legacy `get_layer_stack` invoke
    // return so the frontend store can adopt it directly.
    LayerStackSnapshot {
        stack: serde_json::Value,
    },

    // Media metadata changed for one or more fingerprints. Fired after
    // `SetMediaRating` / `SetMediaTags` / `ApplyPeerMetadata`. `rating`/`tags`
    // carry the new values; `None`/empty in a field means "unchanged in this
    // event."
    MediaMetadataChanged {
        fingerprints: Vec<String>,
    },

    // The collection list within a library changed (create/delete/reorder).
    // `library_id` is omitted when unknown — frontend can refetch globally.
    CollectionListChanged,

    // A new collection was created. Carries the freshly-minted record so the
    // bridge wrapper of `create_collection` (which is dispatched via
    // `MutationRequest::CreateCollection`) can resolve with the full data
    // without needing a mutation-id correlation.
    CollectionCreated {
        collection: serde_json::Value,
    },

    // A persisted snapshot was created. Frontend can refresh `list_snapshots`
    // for the affected fingerprint, or just record the id.
    SnapshotSaved {
        fingerprint: Option<String>,
        id: String,
    },

    // The configured media-library list changed (add/remove/reorder/mode).
    // Frontend re-queries `list_media_libraries`.
    MediaLibrariesChanged,

    // A media library was added or updated. Carries the freshly-minted /
    // updated MediaLibrary record so bridge wrappers for AddMediaLibrary,
    // AddS3MediaLibrary, UpdateS3MediaLibrary can resolve with the full data
    // without mutation-id correlation.
    MediaLibraryUpserted {
        library: serde_json::Value,
    },

    // Response to a `ReadRequest` dispatched through `dispatch_read`. The
    // `read_id` correlates with the originating request; `kind` discriminates
    // the payload shape and `value` carries the typed result as JSON.
    //
    // Single-shot reads emit one message with `done: true`. Streaming reads
    // emit multiple messages with the same `read_id`; the final message
    // carries `done: true`. Frontends discriminate via the `sendRead` vs
    // `sendChunkedRead` helpers.
    ReadResponse {
        read_id: u32,
        kind: String,
        value: serde_json::Value,
        #[serde(default)]
        done: bool,
    },
    // Error variant for failed reads — same correlation key.
    ReadFailed {
        read_id: u32,
        message: String,
    },
}

/// Editor-state mutation requests (JS → Rust). Sent through the single
/// `dispatch_mutation` invoke endpoint. Each variant carries the same payload
/// the original granular invoke command used; results land via channel
/// notifications (`LayerStackSnapshot` for stack-shape changes; future
/// `SnapshotSaved` / `PeerMetadataApplied` for the ones that returned ids).
///
/// The shape is transport-agnostic so a future web-worker backend can accept
/// the same tagged messages over `postMessage`.
#[derive(serde::Deserialize, Debug)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum MutationRequest {
    AddLayer {
        kind: String,
    },
    DeleteLayer {
        idx: usize,
    },
    MoveLayer {
        from: usize,
        to: usize,
    },
    SetLayerVisible {
        idx: usize,
        visible: bool,
    },
    SetLayerOpacity {
        idx: usize,
        opacity: f32,
    },
    RenameLayer {
        idx: usize,
        name: Option<String>,
    },
    ReplaceStack {
        layers_json: String,
    },
    ApplyEdit(serde_json::Value),
    ApplyGradientMask(serde_json::Value),
    RemoveMask {
        idx: usize,
    },
    CreateBrushMask {
        idx: usize,
    },
    StampBrushMask(serde_json::Value),
    LoadSnapshot {
        id: String,
    },
    LoadPreset {
        name: String,
    },
    ApplyPresetSnapshot {
        name: String,
    },

    // Media metadata
    SetMediaRating {
        fingerprint: String,
        rating: Option<u8>,
    },
    SetMediaTags {
        fingerprint: String,
        tags: Vec<String>,
    },
    ApplyPeerMetadata {
        peer_endpoint_id: String,
        fingerprints: Vec<String>,
    },

    // Presets
    SavePreset {
        name: String,
    },
    SavePresetFromJson {
        name: String,
        json: String,
    },
    RenamePreset {
        old_name: String,
        new_name: String,
    },
    DeletePreset {
        name: String,
    },

    // Collections (the new Collection record from `CreateCollection` lands
    // via the `CollectionCreated` notification; the bridge wrapper correlates
    // by library_id + name).
    CreateCollection {
        library_id: String,
        name: String,
    },
    RenameCollection {
        collection_id: String,
        name: String,
    },
    DeleteCollection {
        collection_id: String,
    },
    ReorderCollection {
        collection_id: String,
        new_position: i64,
    },
    AddToCollection {
        collection_id: String,
        fingerprints: Vec<String>,
    },
    RemoveFromCollection {
        collection_id: String,
        fingerprints: Vec<String>,
    },

    // Snapshots
    SaveSnapshot,

    // Batch operations (long-running; final count returns via
    // `BatchCompleted`, per-item progress for export rides
    // `BatchExportProgress`).
    BatchApplyPresetSnapshot {
        items: serde_json::Value,
        name: String,
    },
    BatchClearEdits {
        paths: Vec<String>,
    },
    BatchExportImages {
        items: serde_json::Value,
        target_dir: String,
    },

    // Library additions / S3 updates land via the MediaLibraryUpserted
    // notification; bridge wrappers one-shot subscribe for the next message.
    AddMediaLibrary {
        path: String,
    },
    AddS3MediaLibrary {
        params: serde_json::Value,
    },
    UpdateS3MediaLibrary {
        library_id: String,
        params: serde_json::Value,
    },

    // Library config (add_media_library, add_s3_media_library,
    // update_s3_media_library return rich Library records and stay as
    // regular invokes — same exception as create_collection).
    SetMediaLibraryOrder {
        library_order: Vec<String>,
    },
    SetLibraryMode {
        library_id: String,
        mode: String,
        #[serde(default)]
        sync_target: Option<String>,
    },
    SyncLibrary {
        library_id: String,
    },
    RefreshLibraryIndex {
        library_id: String,
    },
    DeleteMediaLibraryItem {
        path: String,
    },
    RemoveMediaLibrary {
        id: String,
    },
    UploadMediaLibraryUrl {
        library_id: String,
        url: String,
        file_name: String,
    },
    UploadMediaLibraryFile {
        library_id: String,
        file_name: String,
        bytes: Vec<u8>,
        #[serde(default)]
        modified_at: Option<u64>,
        #[serde(default)]
        append_timestamp_on_conflict: bool,
    },
    UploadMediaLibraryPath {
        library_id: String,
        path: String,
    },

    // Peer
    PairPeerDevice {
        peer_endpoint_id: String,
    },
    SetLocalAwareness {
        #[serde(default)]
        display_name: Option<String>,
        #[serde(default)]
        fingerprint: Option<String>,
        #[serde(default)]
        snapshot_id: Option<String>,
    },
}

/// Read requests (JS → Rust). Sent through `dispatch_read`; results come back
/// over the coordination channel as `ChannelMessage::ReadResponse` keyed by
/// `read_id`. Binary reads (`get_mask_thumbnail`, `get_peer_image_bytes`) and
/// `get_layer_stack` (already pushed reactively via `LayerStackSnapshot`) are
/// intentionally excluded.
#[derive(serde::Deserialize, Debug)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ReadRequest {
    ListPictures,
    ListMediaLibraries,
    ListLibraryImages { library_id: String },
    ListMediaRatings { fingerprints: Vec<String> },
    ListPresets,
    ListSnapshots,
    ListCollections { library_id: String },
    ListCollectionItems { collection_id: String },
    ListPeerPictures { peer_endpoint_id: String },
    GetLocalPeerDiscoverySnapshot,
    GetS3MediaLibrary { library_id: String },
    GetPresetJson { name: String },
    GetSnapshotPresetJson { fingerprint: String },
    GetPeerAwareness { peer_endpoint_id: String },
    GetStackSnapshot,
    SyncPeerSnapshots { peer_endpoint_id: String, fingerprint: String },
}
