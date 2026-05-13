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

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct LibraryImageMetadata {
    #[serde(default)]
    pub has_snapshots: bool,
    #[serde(default)]
    pub latest_snapshot_id: Option<String>,
    #[serde(default)]
    pub latest_snapshot_created_at: Option<i64>,
    #[serde(default)]
    pub rating: Option<u8>,
    #[serde(default)]
    pub tags: Vec<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct LibraryImageListing {
    pub path: String,
    pub name: String,
    #[serde(default)]
    pub modified_at: Option<u64>,
    #[serde(default)]
    pub fingerprint: Option<String>,
    #[serde(default)]
    pub metadata: LibraryImageMetadata,
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
    LibraryListChunk {
        request_id: u32,
        items: Vec<LibraryImageListing>,
        done: bool,
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
}
