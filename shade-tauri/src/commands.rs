use serde::{Deserialize, Serialize};
use shade_core::{
    build_curve_lut_from_points, linear_lut, AdjustmentOp, ColorParams, CropRect,
    CurveControlPoint, DenoiseParams, FloatImage, GlowParams, GrainParams, HslParams,
    LayerStack, MaskData, MaskParams, PreviewCrop as GpuPreviewCrop, Renderer,
    SharpenParams, VignetteParams,
};
use shade_io::{
    delete_persisted_library_index, has_persisted_library_index,
    has_persisted_library_index_by_root, is_supported_library_image,
    library_index_db_path as shared_library_index_db_path, load_image_bytes,
    load_image_bytes_f32_with_info, picture_display_name,
    replace_persisted_library_index_by_root, scan_directory_images, to_linear_srgb_f32,
    SourceImageInfo,
};
use std::collections::HashMap;
use std::io::Write;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::sync::{Arc, Mutex};
use tauri::{Emitter, Manager};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};
use tokio::sync::Mutex as TokioMutex;

#[cfg(target_os = "ios")]
extern "C" {
    fn ios_list_photos() -> *mut std::os::raw::c_char;
    fn ios_get_thumbnail(
        identifier: *const std::os::raw::c_char,
        width: i32,
        height: i32,
        out_size: *mut i32,
    ) -> *mut u8;
    fn ios_get_image_data(
        identifier: *const std::os::raw::c_char,
        out_size: *mut i32,
    ) -> *mut u8;
    fn ios_free_buffer(ptr: *mut u8);
    fn ios_free_string(ptr: *mut std::os::raw::c_char);
}

#[cfg(target_os = "ios")]
#[derive(Deserialize)]
struct IosPhotoEntry {
    id: String,
    modified_at: Option<u64>,
}

pub struct EditorState {
    pub stack: LayerStack,
    pub image_sources: Arc<std::collections::HashMap<shade_core::TextureId, FloatImage>>,
    pub canvas_width: u32,
    pub canvas_height: u32,
    pub next_texture_id: u64,
    pub source_bit_depth: String,
    pub current_image_hash: Option<String>,
    pub current_image_source: Option<String>,
    pub current_snapshot_id: Option<String>,
    pub next_open_request_id: u64,
    pub active_open_request_id: u64,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct MediaLibrary {
    pub id: String,
    pub name: String,
    pub kind: String,
    pub path: Option<String>,
    pub removable: bool,
    pub readonly: bool,
    pub is_online: Option<bool>,
    pub is_refreshing: Option<bool>,
    pub mode: String,
    pub sync_target: Option<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone, Default)]
pub struct LibraryImageMetadata {
    pub has_snapshots: bool,
    pub latest_snapshot_id: Option<String>,
    pub rating: Option<u8>,
    #[serde(default)]
    pub tags: Vec<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct LibraryImage {
    pub path: String,
    pub name: String,
    pub modified_at: Option<u64>,
    #[serde(default)]
    pub file_hash: Option<String>,
    #[serde(default)]
    pub metadata: LibraryImageMetadata,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct LibraryImageListing {
    pub items: Vec<LibraryImage>,
    pub is_complete: bool,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
struct PeerPairedEvent {
    peer_endpoint_id: String,
}

#[derive(Serialize, Clone)]
struct LibrarySyncProgress {
    library_id: String,
    total: usize,
    completed: usize,
    current_name: Option<String>,
}

static APP_CONFIG_DIR: OnceLock<PathBuf> = OnceLock::new();
static LIBRARY_DB: tokio::sync::OnceCell<LibraryDb> = tokio::sync::OnceCell::const_new();
static LIBRARY_INDEX_DB: tokio::sync::OnceCell<Arc<shade_io::LibraryIndexDb>> =
    tokio::sync::OnceCell::const_new();

pub struct LibraryDb {
    _db: libsql::Database,
    conn: TokioMutex<libsql::Connection>,
}

async fn init_library_db() -> Result<LibraryDb, String> {
    let path = library_db_path()?;
    let parent = path
        .parent()
        .ok_or_else(|| format!("invalid library db path: {}", path.display()))?;
    std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let db = libsql::Builder::new_local(&path)
        .build()
        .await
        .map_err(|e| e.to_string())?;
    let conn = db.connect().map_err(|e| e.to_string())?;
    conn.query("PRAGMA journal_mode = WAL", ())
        .await
        .map_err(|e| e.to_string())?;
    conn.query("PRAGMA busy_timeout = 5000", ())
        .await
        .map_err(|e| e.to_string())?;
    conn.execute(
        "CREATE TABLE IF NOT EXISTS images (
            file_hash TEXT PRIMARY KEY NOT NULL,
            source_name TEXT,
            created_at INTEGER NOT NULL
        )",
        (),
    )
    .await
    .map_err(|e| e.to_string())?;
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_images_source_name ON images(source_name)",
        (),
    )
    .await
    .map_err(|e| e.to_string())?;
    // Migrate from old integer-version schema to UUID-based schema if needed.
    let needs_migration = {
        let mut rows = conn
            .query(
                "SELECT COUNT(*) FROM pragma_table_info('edit_versions') WHERE name = 'version'",
                (),
            )
            .await
            .map_err(|e| e.to_string())?;
        let row = rows.next().await.map_err(|e| e.to_string())?;
        row.map(|r| r.get::<i64>(0).unwrap_or(0) > 0)
            .unwrap_or(false)
    };
    if needs_migration {
        conn.execute_batch(
            "BEGIN;
             ALTER TABLE edit_versions RENAME TO edit_versions_old;
             CREATE TABLE edit_versions (
                 id TEXT PRIMARY KEY NOT NULL,
                 file_hash TEXT NOT NULL,
                 created_at INTEGER NOT NULL,
                 layers_json TEXT NOT NULL,
                 peer_origin TEXT,
                 FOREIGN KEY (file_hash) REFERENCES images(file_hash)
             );
             INSERT INTO edit_versions (id, file_hash, created_at, layers_json, peer_origin)
                 SELECT lower(hex(randomblob(16))), file_hash, created_at, layers_json, NULL
                 FROM edit_versions_old;
             DROP TABLE edit_versions_old;
             COMMIT;",
        )
        .await
        .map_err(|e| e.to_string())?;
    } else {
        conn.execute(
            "CREATE TABLE IF NOT EXISTS edit_versions (
                id TEXT PRIMARY KEY NOT NULL,
                file_hash TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                layers_json TEXT NOT NULL,
                peer_origin TEXT,
                FOREIGN KEY (file_hash) REFERENCES images(file_hash)
            )",
            (),
        )
        .await
        .map_err(|e| e.to_string())?;
    }
    conn.execute(
        "CREATE TABLE IF NOT EXISTS media_ratings (
            file_hash TEXT PRIMARY KEY NOT NULL,
            rating INTEGER NOT NULL CHECK(rating BETWEEN 1 AND 5),
            updated_at INTEGER NOT NULL
        )",
        (),
    )
    .await
    .map_err(|e| e.to_string())?;
    conn.execute(
        "CREATE TABLE IF NOT EXISTS media_tags (
            file_hash TEXT NOT NULL,
            tag TEXT NOT NULL,
            updated_at INTEGER NOT NULL,
            PRIMARY KEY (file_hash, tag)
        )",
        (),
    )
    .await
    .map_err(|e| e.to_string())?;
    if table_has_column(&conn, "media_ratings", "media_id").await? {
        conn.execute_batch(
            "BEGIN;
             ALTER TABLE media_ratings RENAME TO media_ratings_old;
             CREATE TABLE media_ratings (
                 file_hash TEXT PRIMARY KEY NOT NULL,
                 rating INTEGER NOT NULL CHECK(rating BETWEEN 1 AND 5),
                 updated_at INTEGER NOT NULL
             );
             INSERT INTO media_ratings (file_hash, rating, updated_at)
                 SELECT images.file_hash, old.rating, old.updated_at
                 FROM media_ratings_old old
                 JOIN images ON images.source_name = old.media_id;
             DROP TABLE media_ratings_old;
             COMMIT;",
        )
        .await
        .map_err(|e| e.to_string())?;
    }
    if table_has_column(&conn, "media_tags", "media_id").await? {
        conn.execute_batch(
            "BEGIN;
             ALTER TABLE media_tags RENAME TO media_tags_old;
             CREATE TABLE media_tags (
                 file_hash TEXT NOT NULL,
                 tag TEXT NOT NULL,
                 updated_at INTEGER NOT NULL,
                 PRIMARY KEY (file_hash, tag)
             );
             INSERT INTO media_tags (file_hash, tag, updated_at)
                 SELECT images.file_hash, old.tag, old.updated_at
                 FROM media_tags_old old
                 JOIN images ON images.source_name = old.media_id;
             DROP TABLE media_tags_old;
             COMMIT;",
        )
        .await
        .map_err(|e| e.to_string())?;
    }
    shade_io::create_collections_tables(&conn).await?;
    Ok(LibraryDb {
        _db: db,
        conn: TokioMutex::new(conn),
    })
}

async fn library_db_conn() -> tokio::sync::MutexGuard<'static, libsql::Connection> {
    LIBRARY_DB
        .get()
        .expect("library db not initialized")
        .conn
        .lock()
        .await
}

pub async fn setup_library_db() -> Result<(), String> {
    let db = init_library_db().await?;
    LIBRARY_DB
        .set(db)
        .map_err(|_| "library db already initialized".to_string())
}

pub async fn setup_library_index_db() -> Result<Arc<shade_io::LibraryIndexDb>, String> {
    let path = library_index_db_path()?;
    let db = Arc::new(shade_io::LibraryIndexDb::open(&path).await?);
    LIBRARY_INDEX_DB
        .set(db.clone())
        .map_err(|_| "library index db already initialized".to_string())?;
    Ok(db)
}

fn library_index_db() -> &'static Arc<shade_io::LibraryIndexDb> {
    LIBRARY_INDEX_DB
        .get()
        .expect("library index db not initialized")
}
const SUPERSEDED_IMAGE_LOAD_ERROR: &str = "image load superseded by newer request";

pub struct S3LibraryScanState {
    pub scans: Mutex<HashMap<String, Arc<Mutex<shade_io::LibraryScanSnapshot>>>>,
    pub index_db: Arc<shade_io::LibraryIndexDb>,
}

impl S3LibraryScanState {
    pub fn new(index_db: Arc<shade_io::LibraryIndexDb>) -> Arc<Self> {
        Arc::new(Self {
            scans: Mutex::new(HashMap::new()),
            index_db,
        })
    }

    pub async fn ensure_snapshot_for_library(
        &self,
        config: &shade_io::S3LibraryConfig,
    ) -> Result<(Arc<Mutex<shade_io::LibraryScanSnapshot>>, bool), String> {
        let library_id = s3_library_id(&config.id);
        if let Some(snapshot) = self
            .scans
            .lock()
            .map_err(|_| "S3 library scan lock poisoned".to_string())?
            .get(&library_id)
            .cloned()
        {
            return Ok((snapshot, false));
        }
        let persisted = shade_io::load_persisted_library_index_by_root(
            &self.index_db,
            &library_id,
            &shade_io::format_s3_library_detail(config),
        )
        .await?;
        let should_scan = persisted.is_none();
        let completed_at = persisted.as_ref().map(|listing| listing.indexed_at);
        let snapshot = Arc::new(Mutex::new(shade_io::LibraryScanSnapshot {
            items: persisted.map(|listing| listing.items).unwrap_or_default(),
            is_scanning: false,
            is_complete: !should_scan,
            error: None,
            completed_at,
        }));
        let snapshot = {
            let mut scans = self
                .scans
                .lock()
                .map_err(|_| "S3 library scan lock poisoned".to_string())?;
            scans
                .entry(library_id)
                .or_insert_with(|| snapshot.clone())
                .clone()
        };
        Ok((snapshot, should_scan))
    }

    pub async fn snapshot_for_library(
        self: &Arc<Self>,
        config: &shade_io::S3LibraryConfig,
    ) -> Result<shade_io::LibraryScanSnapshot, String> {
        let (snapshot, should_scan) =
            self.ensure_snapshot_for_library(config).await?;
        if should_scan {
            start_s3_library_scan(
                snapshot.clone(),
                self.index_db.clone(),
                config.clone(),
                true,
            )?;
        }
        let snapshot = snapshot
            .lock()
            .map_err(|_| "S3 library scan snapshot lock poisoned".to_string())?
            .clone();
        if let Some(error) = &snapshot.error {
            return Err(error.clone());
        }
        Ok(snapshot)
    }

    pub async fn request_refresh(
        self: &Arc<Self>,
        config: &shade_io::S3LibraryConfig,
    ) -> Result<bool, String> {
        let (snapshot, _) = self.ensure_snapshot_for_library(config).await?;
        let publish_progress = {
            let guard = snapshot
                .lock()
                .map_err(|_| "S3 library scan snapshot lock poisoned".to_string())?;
            if guard.is_scanning {
                return Ok(false);
            }
            guard.completed_at.is_none() && guard.items.is_empty()
        };
        start_s3_library_scan(
            snapshot,
            self.index_db.clone(),
            config.clone(),
            publish_progress,
        )?;
        Ok(true)
    }

    pub async fn refresh_library(
        self: &Arc<Self>,
        config: &shade_io::S3LibraryConfig,
    ) -> Result<(), String> {
        if self.request_refresh(config).await? {
            return Ok(());
        }
        Err(format!(
            "library index refresh already running: {}",
            s3_library_id(&config.id)
        ))
    }

    pub fn remove_library(&self, library_id: &str) -> Result<(), String> {
        self.scans
            .lock()
            .map_err(|_| "S3 library scan lock poisoned".to_string())?
            .remove(library_id);
        Ok(())
    }
}

pub fn init_app_paths<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
) -> Result<(), String> {
    let config_dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    APP_CONFIG_DIR
        .set(config_dir)
        .map_err(|_| "app config path already initialized".to_string())
}

fn panic_payload_message(payload: Box<dyn std::any::Any + Send>) -> String {
    match payload.downcast::<String>() {
        Ok(message) => *message,
        Err(payload) => match payload.downcast::<&'static str>() {
            Ok(message) => (*message).to_string(),
            Err(_) => "panic without message".to_string(),
        },
    }
}

fn decode_image_bytes_with_info(
    bytes: &[u8],
    name_hint: Option<&str>,
) -> Result<(FloatImage, SourceImageInfo), String> {
    catch_unwind(AssertUnwindSafe(|| {
        load_image_bytes_f32_with_info(bytes, name_hint)
    }))
    .map_err(|payload| {
        format!("image decode panicked: {}", panic_payload_message(payload))
    })?
    .map_err(|e| e.to_string())
}

fn lock_editor_state<'a>(
    state: &'a tauri::State<'_, Mutex<EditorState>>,
) -> Result<std::sync::MutexGuard<'a, EditorState>, String> {
    state
        .lock()
        .map_err(|_| "editor state lock poisoned".to_string())
}

async fn require_p2p(
    p2p: &tauri::State<'_, crate::P2pState>,
) -> Result<std::sync::Arc<shade_p2p::LocalPeerDiscovery>, String> {
    p2p.0
        .read()
        .await
        .clone()
        .ok_or_else(|| "p2p is unavailable on this platform".to_string())
}

async fn sync_peer_snapshots_for_file_hash(
    peer_endpoint_id: &str,
    file_hash: &str,
    p2p: &std::sync::Arc<shade_p2p::LocalPeerDiscovery>,
    source_name: Option<&str>,
) -> Result<Vec<String>, String> {
    let peer_snapshots = p2p
        .list_peer_snapshots(peer_endpoint_id, file_hash)
        .await
        .map_err(|e| e.to_string())?;
    if peer_snapshots.is_empty() {
        return Ok(Vec::new());
    }

    let local_ids = {
        let conn = library_db_conn().await;
        let mut rows = conn
            .query(
                "SELECT id FROM edit_versions WHERE file_hash = ?1",
                [file_hash],
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
                    "UPDATE images SET source_name = ?1 WHERE file_hash = ?2",
                    libsql::params![source_name, file_hash],
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
            file_hash,
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

async fn sync_snapshots_from_all_peers_for_file_hash(
    p2p: &std::sync::Arc<shade_p2p::LocalPeerDiscovery>,
    file_hash: &str,
) -> Result<Vec<String>, String> {
    let snapshot = p2p.snapshot().await;
    let mut synced_ids = Vec::new();
    for peer in snapshot.peers {
        synced_ids.extend(
            sync_peer_snapshots_for_file_hash(&peer.endpoint_id, file_hash, p2p, None)
                .await?,
        );
    }
    Ok(synced_ids)
}

fn presets_dir_path() -> Result<PathBuf, String> {
    Ok(app_config_dir()?.join("presets"))
}

fn home_dir() -> Result<PathBuf, String> {
    std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .map(PathBuf::from)
        .map_err(|_| "Could not determine home directory".to_string())
}

fn app_config_dir() -> Result<PathBuf, String> {
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

fn preset_file_path(name: &str) -> Result<PathBuf, String> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err("preset name cannot be empty".into());
    }
    if trimmed.contains('/') || trimmed.contains('\\') || trimmed.contains("..") {
        return Err("preset name contains invalid path characters".into());
    }
    Ok(presets_dir_path()?.join(format!("{trimmed}.json")))
}

fn library_db_path() -> Result<PathBuf, String> {
    Ok(app_config_dir()?.join("library.db"))
}

fn library_index_db_path() -> Result<PathBuf, String> {
    Ok(shared_library_index_db_path(&app_config_dir()?))
}

fn thumbnail_cache_db_path() -> Result<PathBuf, String> {
    Ok(app_config_dir()?.join("thumbnails.db"))
}

fn library_sync_dir(library_id: &str) -> Result<PathBuf, String> {
    let dir = app_config_dir()?.join("sync").join(library_id);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

pub async fn open_thumbnail_cache_db(
) -> Result<crate::thumbnail_cache::ThumbnailCacheDb, String> {
    crate::thumbnail_cache::ThumbnailCacheDb::open(&thumbnail_cache_db_path()?).await
}

fn hash_bytes(bytes: &[u8]) -> String {
    blake3::hash(bytes).to_hex().to_string()
}

fn texture_id_for_file_hash(file_hash: &str) -> Result<shade_core::TextureId, String> {
    let prefix = file_hash
        .get(..16)
        .ok_or_else(|| format!("invalid file hash: {file_hash}"))?;
    u64::from_str_radix(prefix, 16).map_err(|e| e.to_string())
}

fn non_image_layer_data(stack: &LayerStack) -> PersistedLayerData {
    let layers: Vec<_> = stack
        .layers
        .iter()
        .filter(|entry| !matches!(entry.layer, shade_core::Layer::Image { .. }))
        .cloned()
        .collect();
    let mask_params: HashMap<shade_core::MaskId, shade_core::MaskParams> = layers
        .iter()
        .filter_map(|entry| entry.mask)
        .filter_map(|id| {
            let params = stack.mask_params.get(&id)?;
            // For brush masks, sync current pixel data from the mask store into params
            let synced = match params {
                shade_core::MaskParams::Brush { .. } => {
                    let data = stack.masks.get(&id)?;
                    shade_core::MaskParams::Brush {
                        width: data.width,
                        height: data.height,
                        pixels: data.pixels.clone(),
                    }
                }
                _ => params.clone(),
            };
            Some((id, synced))
        })
        .collect();
    PersistedLayerData {
        layers,
        mask_params,
    }
}

fn ensure_non_image_layers(layers: &[shade_core::LayerEntry]) -> Result<(), String> {
    if layers
        .iter()
        .any(|entry| matches!(entry.layer, shade_core::Layer::Image { .. }))
    {
        return Err("persisted edit versions cannot contain image layers".into());
    }
    Ok(())
}

fn parse_layer_data(json: &str) -> Result<PersistedLayerData, String> {
    if let Ok(data) = serde_json::from_str::<PersistedLayerData>(json) {
        return Ok(data);
    }
    let layers: Vec<shade_core::LayerEntry> =
        serde_json::from_str(json).map_err(|e| e.to_string())?;
    Ok(PersistedLayerData {
        layers,
        mask_params: HashMap::new(),
    })
}

fn restore_masks_from_params(
    stack: &mut LayerStack,
    base_idx: usize,
    saved_params: &HashMap<shade_core::MaskId, shade_core::MaskParams>,
    width: u32,
    height: u32,
) {
    for i in base_idx..stack.layers.len() {
        let Some(old_id) = stack.layers[i].mask else {
            continue;
        };
        let Some(params) = saved_params.get(&old_id) else {
            stack.layers[i].mask = None;
            continue;
        };
        let mask = match params {
            shade_core::MaskParams::Linear { x1, y1, x2, y2 } => {
                let mut m = shade_core::MaskData::new_empty(width, height);
                m.fill_linear_gradient(*x1, *y1, *x2, *y2);
                m
            }
            shade_core::MaskParams::Radial { cx, cy, radius } => {
                let mut m = shade_core::MaskData::new_empty(width, height);
                m.fill_radial_gradient(*cx, *cy, *radius);
                m
            }
            shade_core::MaskParams::Brush {
                width: bw,
                height: bh,
                pixels,
            } => shade_core::MaskData {
                width: *bw,
                height: *bh,
                pixels: pixels.clone(),
            },
        };
        stack.set_mask_with_params(i, mask, params.clone());
    }
}

async fn table_has_column(
    conn: &libsql::Connection,
    table: &str,
    column: &str,
) -> Result<bool, String> {
    let query =
        format!("SELECT COUNT(*) FROM pragma_table_info('{table}') WHERE name = ?1");
    let mut rows = conn
        .query(query.as_str(), libsql::params![column])
        .await
        .map_err(|e| e.to_string())?;
    Ok(rows
        .next()
        .await
        .map_err(|e| e.to_string())?
        .and_then(|row| row.get::<i64>(0).ok())
        .unwrap_or(0)
        > 0)
}

fn unix_timestamp_millis() -> Result<i64, String> {
    let duration = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| e.to_string())?;
    i64::try_from(duration.as_millis()).map_err(|e| e.to_string())
}

fn validate_media_rating(rating: Option<u8>) -> Result<Option<u8>, String> {
    match rating {
        Some(value) if (1..=5).contains(&value) => Ok(Some(value)),
        Some(value) => Err(format!("rating out of range: {value}")),
        None => Ok(None),
    }
}

fn normalize_media_tags(tags: &[String]) -> Vec<String> {
    let mut normalized = tags
        .iter()
        .map(|tag| tag.trim())
        .filter(|tag| !tag.is_empty())
        .map(str::to_string)
        .collect::<Vec<_>>();
    normalized.sort();
    normalized.dedup();
    normalized
}

async fn load_media_ratings_map(
    file_hashes: &[String],
) -> Result<HashMap<String, u8>, String> {
    if file_hashes.is_empty() {
        return Ok(HashMap::new());
    }
    let requested_hashes = file_hashes
        .iter()
        .cloned()
        .collect::<std::collections::HashSet<_>>();
    let conn = library_db_conn().await;
    let mut rows = conn
        .query("SELECT file_hash, rating FROM media_ratings", ())
        .await
        .map_err(|error| error.to_string())?;
    let mut ratings = HashMap::new();
    while let Some(row) = rows.next().await.map_err(|error| error.to_string())? {
        let file_hash = row.get::<String>(0).map_err(|error| error.to_string())?;
        if !requested_hashes.contains(&file_hash) {
            continue;
        }
        let rating = row
            .get::<i64>(1)
            .map_err(|error| error.to_string())
            .and_then(|value| u8::try_from(value).map_err(|error| error.to_string()))?;
        ratings.insert(file_hash, rating);
    }
    Ok(ratings)
}

async fn snapshot_ids_by_source_name() -> Result<HashMap<String, String>, String> {
    let conn = library_db_conn().await;
    let mut rows = conn
        .query(
            "SELECT i.source_name, ev.id
             FROM images i
             JOIN edit_versions ev ON ev.file_hash = i.file_hash
             WHERE i.source_name IS NOT NULL
             AND ev.created_at = (
                 SELECT MAX(ev2.created_at)
                 FROM edit_versions ev2
                 WHERE ev2.file_hash = i.file_hash
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

#[derive(Serialize, Debug)]
pub struct PeerPictureInfo {
    pub id: String,
    pub name: String,
    pub modified_at: Option<u64>,
    pub has_snapshots: bool,
    pub latest_snapshot_id: Option<String>,
}

async fn load_media_tags_map(
    file_hashes: &[String],
) -> Result<HashMap<String, Vec<String>>, String> {
    if file_hashes.is_empty() {
        return Ok(HashMap::new());
    }
    let requested_hashes = file_hashes
        .iter()
        .cloned()
        .collect::<std::collections::HashSet<_>>();
    let conn = library_db_conn().await;
    let mut rows = conn
        .query("SELECT file_hash, tag FROM media_tags ORDER BY tag ASC", ())
        .await
        .map_err(|error| error.to_string())?;
    let mut tags = HashMap::<String, Vec<String>>::new();
    while let Some(row) = rows.next().await.map_err(|error| error.to_string())? {
        let file_hash = row.get::<String>(0).map_err(|error| error.to_string())?;
        if !requested_hashes.contains(&file_hash) {
            continue;
        }
        let tag = row.get::<String>(1).map_err(|error| error.to_string())?;
        if tag.is_empty() {
            continue;
        }
        tags.entry(file_hash).or_default().push(tag);
    }
    Ok(tags)
}

async fn persist_media_rating(file_hash: &str, rating: Option<u8>) -> Result<(), String> {
    let normalized = validate_media_rating(rating)?;
    let conn = library_db_conn().await;
    if let Some(value) = normalized {
        conn.execute(
            "INSERT INTO media_ratings (file_hash, rating, updated_at)
             VALUES (?1, ?2, ?3)
             ON CONFLICT(file_hash)
             DO UPDATE SET rating = excluded.rating, updated_at = excluded.updated_at",
            libsql::params![file_hash, i64::from(value), unix_timestamp_millis()?],
        )
        .await
        .map_err(|error| error.to_string())?;
        return Ok(());
    }
    conn.execute(
        "DELETE FROM media_ratings WHERE file_hash = ?1",
        [file_hash],
    )
    .await
    .map_err(|error| error.to_string())?;
    Ok(())
}

// Reads the XMP sidecar rating for a local file path and stores it with INSERT OR IGNORE,
// so it never overwrites a rating the user has set explicitly.
async fn import_xmp_rating(picture_id: &str, file_hash: &str) {
    if picture_id.contains("://") {
        return; // skip non-local paths (ccapi://, s3://, etc.)
    }
    let path = std::path::Path::new(picture_id);
    let Ok(Some(rating)) = shade_io::rating_for_image_path(path) else {
        return;
    };
    let Ok(now) = unix_timestamp_millis() else {
        return;
    };
    if let Ok(conn) = tokio::time::timeout(
        std::time::Duration::from_secs(2),
        library_db_conn(),
    ).await {
        let _ = conn.execute(
            "INSERT OR IGNORE INTO media_ratings (file_hash, rating, updated_at) VALUES (?1, ?2, ?3)",
            libsql::params![file_hash, i64::from(rating), now],
        ).await;
    }
}

pub async fn persist_media_tags(file_hash: &str, tags: &[String]) -> Result<(), String> {
    let normalized = normalize_media_tags(tags);
    let conn = library_db_conn().await;
    conn.execute("BEGIN IMMEDIATE", ())
        .await
        .map_err(|error| error.to_string())?;
    let result = async {
        conn.execute("DELETE FROM media_tags WHERE file_hash = ?1", [file_hash])
            .await
            .map_err(|error| error.to_string())?;
        let updated_at = unix_timestamp_millis()?;
        for tag in normalized {
            conn.execute(
                "INSERT INTO media_tags (file_hash, tag, updated_at)
                 VALUES (?1, ?2, ?3)",
                libsql::params![file_hash, tag, updated_at],
            )
            .await
            .map_err(|error| error.to_string())?;
        }
        Ok::<(), String>(())
    }
    .await;
    match result {
        Ok(()) => {
            conn.execute("COMMIT", ())
                .await
                .map_err(|error| error.to_string())?;
            Ok(())
        }
        Err(error) => {
            let _ = conn.execute("ROLLBACK", ()).await;
            Err(error)
        }
    }
}

pub async fn persist_media_tags_empty(file_hash: &str) -> Result<(), String> {
    let conn = library_db_conn().await;
    conn.execute("BEGIN IMMEDIATE", ())
        .await
        .map_err(|error| error.to_string())?;
    let result = async {
        conn.execute("DELETE FROM media_tags WHERE file_hash = ?1", [file_hash])
            .await
            .map_err(|error| error.to_string())?;
        conn.execute(
            "INSERT INTO media_tags (file_hash, tag, updated_at)
             VALUES (?1, '', ?2)",
            libsql::params![file_hash, unix_timestamp_millis()?],
        )
        .await
        .map_err(|error| error.to_string())?;
        Ok::<(), String>(())
    }
    .await;
    match result {
        Ok(()) => {
            conn.execute("COMMIT", ())
                .await
                .map_err(|error| error.to_string())?;
            Ok(())
        }
        Err(error) => {
            let _ = conn.execute("ROLLBACK", ()).await;
            Err(error)
        }
    }
}

pub async fn max_media_tag_updated_at() -> Result<i64, String> {
    let conn = library_db_conn().await;
    let mut rows = conn
        .query("SELECT MAX(updated_at) FROM media_tags", ())
        .await
        .map_err(|error| error.to_string())?;
    let max = match rows.next().await.map_err(|error| error.to_string())? {
        Some(row) => row
            .get::<Option<i64>>(0)
            .map_err(|e| e.to_string())?
            .unwrap_or(0),
        None => 0,
    };
    Ok(max)
}

pub async fn media_tags_exist(file_hash: &str) -> Result<bool, String> {
    let conn = library_db_conn().await;
    let mut rows = conn
        .query(
            "SELECT 1 FROM media_tags WHERE file_hash = ?1 LIMIT 1",
            [file_hash],
        )
        .await
        .map_err(|error| error.to_string())?;
    Ok(rows
        .next()
        .await
        .map_err(|error| error.to_string())?
        .is_some())
}

async fn load_latest_edit_version(
    file_hash: &str,
) -> Result<Option<PersistedEditVersion>, String> {
    let conn = library_db_conn().await;
    let mut rows = conn
        .query(
            "SELECT id, layers_json
             FROM edit_versions
             WHERE file_hash = ?1
             ORDER BY created_at DESC
             LIMIT 1",
            [file_hash],
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

async fn has_snapshot_for_source(source_name: &str) -> Result<bool, String> {
    let conn = library_db_conn().await;
    let mut rows = conn
        .query(
            "SELECT 1
             FROM images i
             JOIN edit_versions ev ON ev.file_hash = i.file_hash
             WHERE i.source_name = ?1
             LIMIT 1",
            [source_name],
        )
        .await
        .map_err(|e| e.to_string())?;
    Ok(rows.next().await.map_err(|e| e.to_string())?.is_some())
}

async fn register_image_source(
    file_hash: &str,
    source_name: Option<&str>,
) -> Result<(), String> {
    let conn = library_db_conn().await;
    let now = unix_timestamp_millis()?;
    conn.execute(
        "INSERT INTO images (file_hash, source_name, created_at)
         VALUES (?1, ?2, ?3)
         ON CONFLICT(file_hash) DO UPDATE SET source_name = excluded.source_name",
        libsql::params![file_hash, source_name, now],
    )
    .await
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Persists a snapshot and returns its UUID id.
/// If `id` is given (e.g. when inserting a synced peer snapshot), that id is used;
/// otherwise a new UUID v4 is generated.
async fn persist_snapshot(
    file_hash: &str,
    source_name: Option<&str>,
    id: Option<&str>,
    peer_origin: Option<&str>,
    data: &PersistedLayerData,
) -> Result<String, String> {
    ensure_non_image_layers(&data.layers)?;
    register_image_source(file_hash, source_name).await?;
    let conn = library_db_conn().await;
    let now = unix_timestamp_millis()?;
    let snapshot_id = id
        .map(|s| s.to_owned())
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    conn.execute(
        "INSERT OR IGNORE INTO edit_versions (id, file_hash, created_at, layers_json, peer_origin)
         VALUES (?1, ?2, ?3, ?4, ?5)",
        libsql::params![
            snapshot_id.as_str(),
            file_hash,
            now,
            serde_json::to_string(data).map_err(|e| e.to_string())?,
            peer_origin,
        ],
    )
    .await
    .map_err(|e| e.to_string())?;
    Ok(snapshot_id)
}

fn restore_persisted_layers(
    state: &mut EditorState,
    file_hash: String,
    source_name: Option<String>,
    persisted: Option<PersistedEditVersion>,
) -> Result<(), String> {
    state.current_image_hash = Some(file_hash);
    state.current_image_source = source_name;
    state.current_snapshot_id = persisted.as_ref().map(|v| v.id.clone());
    let Some(persisted) = persisted else {
        return Ok(());
    };
    ensure_non_image_layers(&persisted.data.layers)?;
    let image_layers: Vec<_> = state
        .stack
        .layers
        .iter()
        .filter(|entry| matches!(entry.layer, shade_core::Layer::Image { .. }))
        .cloned()
        .collect();
    if image_layers.is_empty() {
        return Err("cannot restore persisted edits without an image layer".into());
    }
    state.stack.layers = image_layers;
    state.stack.masks.clear();
    state.stack.mask_params.clear();
    let base_idx = state.stack.layers.len();
    state.stack.layers.extend(persisted.data.layers);
    restore_masks_from_params(
        &mut state.stack,
        base_idx,
        &persisted.data.mask_params,
        state.canvas_width,
        state.canvas_height,
    );
    state.stack.generation += 1;
    Ok(())
}

fn build_persisted_layer_stack(
    texture_id: shade_core::TextureId,
    width: u32,
    height: u32,
    persisted: &PersistedEditVersion,
) -> Result<LayerStack, String> {
    ensure_non_image_layers(&persisted.data.layers)?;
    let mut stack = LayerStack::new();
    stack.add_image_layer(texture_id, width, height);
    let base_idx = stack.layers.len();
    stack.layers.extend(persisted.data.layers.clone());
    restore_masks_from_params(
        &mut stack,
        base_idx,
        &persisted.data.mask_params,
        width,
        height,
    );
    stack.generation += 1;
    Ok(stack)
}

/// Persists the current edit state. If there is already a current snapshot id,
/// it updates that snapshot in place (upsert). Otherwise creates a new UUID snapshot.
async fn persist_current_edit_version(
    state: &tauri::State<'_, Mutex<EditorState>>,
) -> Result<String, String> {
    let (file_hash, source_name, data, current_snapshot_id) = {
        let st = lock_editor_state(state)?;
        let file_hash = st.current_image_hash.clone().ok_or_else(|| {
            "cannot persist edits without a loaded image hash".to_string()
        })?;
        (
            file_hash,
            st.current_image_source.clone(),
            non_image_layer_data(&st.stack),
            st.current_snapshot_id.clone(),
        )
    };
    let id = if let Some(existing_id) = current_snapshot_id {
        // Update the existing snapshot in place.
        ensure_non_image_layers(&data.layers)?;
        let conn = library_db_conn().await;
        conn.execute(
            "UPDATE edit_versions SET layers_json = ?1 WHERE id = ?2",
            libsql::params![
                serde_json::to_string(&data).map_err(|e| e.to_string())?,
                existing_id.as_str(),
            ],
        )
        .await
        .map_err(|e| e.to_string())?;
        existing_id
    } else {
        persist_snapshot(&file_hash, source_name.as_deref(), None, None, &data).await?
    };
    let mut st = lock_editor_state(state)?;
    st.current_snapshot_id = Some(id.clone());
    Ok(id)
}

async fn save_new_snapshot(
    state: &tauri::State<'_, Mutex<EditorState>>,
) -> Result<String, String> {
    let (file_hash, source_name, data) = {
        let st = lock_editor_state(state)?;
        let file_hash = st.current_image_hash.clone().ok_or_else(|| {
            "cannot save a snapshot without a loaded image hash".to_string()
        })?;
        (
            file_hash,
            st.current_image_source.clone(),
            non_image_layer_data(&st.stack),
        )
    };
    let id =
        persist_snapshot(&file_hash, source_name.as_deref(), None, None, &data).await?;
    let mut st = lock_editor_state(state)?;
    st.current_snapshot_id = Some(id.clone());
    Ok(id)
}

async fn list_snapshots_for_file(
    file_hash: &str,
    current_snapshot_id: Option<&str>,
) -> Result<Vec<SnapshotInfo>, String> {
    let conn = library_db_conn().await;
    // ROW_NUMBER ordered by created_at gives a stable display index.
    let mut rows = conn
        .query(
            "SELECT id, created_at, peer_origin,
                    ROW_NUMBER() OVER (ORDER BY created_at) AS display_index
             FROM edit_versions
             WHERE file_hash = ?1
             ORDER BY created_at DESC",
            [file_hash],
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

async fn load_snapshot_by_id(
    file_hash: &str,
    id: &str,
) -> Result<PersistedEditVersion, String> {
    let conn = library_db_conn().await;
    let mut rows = conn
        .query(
            "SELECT layers_json
             FROM edit_versions
             WHERE file_hash = ?1 AND id = ?2
             LIMIT 1",
            libsql::params![file_hash, id],
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
struct PersistedLayerData {
    layers: Vec<shade_core::LayerEntry>,
    #[serde(default)]
    mask_params: HashMap<shade_core::MaskId, shade_core::MaskParams>,
}

#[derive(Serialize, Deserialize, Debug)]
struct PresetFile {
    version: u32,
    layers: Vec<shade_core::LayerEntry>,
    #[serde(default)]
    mask_params: HashMap<shade_core::MaskId, shade_core::MaskParams>,
}

#[derive(Debug)]
struct PersistedEditVersion {
    id: String,
    data: PersistedLayerData,
}

#[derive(Serialize, Deserialize, Debug)]
pub struct PresetInfo {
    pub name: String,
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
pub struct MediaRatingParams {
    pub file_hash: String,
    pub rating: Option<u8>,
}

#[derive(Serialize, Deserialize, Debug)]
pub struct MediaTagsParams {
    pub file_hash: String,
    pub tags: Vec<String>,
}

#[derive(Serialize, Deserialize, Debug)]
pub struct LoadSnapshotParams {
    pub id: String,
}

fn load_app_config() -> Result<shade_io::AppConfig, String> {
    shade_io::load_app_config(&app_config_dir()?)
}

fn save_app_config(config: &shade_io::AppConfig) -> Result<(), String> {
    shade_io::save_app_config(&app_config_dir()?, config)
}

pub fn load_p2p_secret_key() -> Result<Option<iroh::SecretKey>, String> {
    Ok(load_app_config()?
        .p2p_secret_key
        .map(|bytes| iroh::SecretKey::from_bytes(&bytes)))
}

pub fn save_p2p_secret_key(secret_key: [u8; 32]) -> Result<(), String> {
    let mut config = load_app_config()?;
    config.p2p_secret_key = Some(secret_key);
    save_app_config(&config)
}

fn is_peer_paired(peer_endpoint_id: &str) -> Result<bool, String> {
    Ok(shade_io::is_peer_paired(
        &load_app_config()?,
        peer_endpoint_id,
    ))
}

fn pair_peer(peer_endpoint_id: &str, peer_name: Option<&str>) -> Result<(), String> {
    let mut config = load_app_config()?;
    if !shade_io::pair_peer(&mut config, peer_endpoint_id, peer_name) {
        return Ok(());
    }
    save_app_config(&config)
}

async fn discovered_peers_by_endpoint<R: tauri::Runtime>(
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

fn sync_persisted_peer_names(
    config: &mut shade_io::AppConfig,
    discovered_peers: &HashMap<String, shade_p2p::LocalPeer>,
) -> bool {
    let persisted_peer_names = config
        .libraries
        .iter()
        .filter_map(|library| {
            let shade_io::LibraryConfig::Peer(peer_config) = library else {
                return None;
            };
            discovered_peers
                .get(&peer_config.peer_id)
                .map(|peer| (peer_config.peer_id.clone(), peer.name.clone()))
        })
        .collect::<Vec<_>>();
    let mut changed = false;
    for (peer_endpoint_id, peer_name) in persisted_peer_names {
        changed |=
            shade_io::pair_peer(config, &peer_endpoint_id, Some(peer_name.as_str()));
    }
    changed
}

fn emit_peer_paired<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    peer_endpoint_id: &str,
) -> Result<(), String> {
    app.emit(
        "peer-paired",
        PeerPairedEvent {
            peer_endpoint_id: peer_endpoint_id.to_owned(),
        },
    )
    .map_err(|error| error.to_string())
}

fn set_library_order(library_order: Vec<String>) -> Result<(), String> {
    let mut config = load_app_config()?;
    let mut seen = std::collections::HashSet::new();
    let mut normalized_order = Vec::with_capacity(library_order.len() + 1);
    normalized_order.push("pictures".to_string());
    for library_id in &library_order {
        if library_id == "pictures" {
            continue;
        }
        if !seen.insert(library_id) {
            return Err(format!("duplicate media library in order: {library_id}"));
        }
        normalized_order.push(library_id.clone());
    }
    config.library_order = normalized_order;
    save_app_config(&config)
}

fn ordered_library_entries(
    libraries: Vec<MediaLibrary>,
    order: &[String],
) -> Vec<MediaLibrary> {
    let mut order = order.to_vec();
    if let Some(index) = order.iter().position(|library_id| library_id == "pictures") {
        if index != 0 {
            let pictures = order.remove(index);
            order.insert(0, pictures);
        }
    } else {
        order.insert(0, "pictures".to_string());
    }
    for library in &libraries {
        if !order.iter().any(|candidate| candidate == &library.id) {
            order.push(library.id.clone());
        }
    }
    let mut positions = std::collections::HashMap::new();
    for (index, library_id) in order.iter().enumerate() {
        positions.insert(library_id.clone(), index);
    }
    let mut libraries = libraries;
    libraries.sort_by(|left, right| {
        let left_index = positions
            .get(&left.id)
            .copied()
            .unwrap_or_else(|| panic!("missing library order entry for {}", left.id));
        let right_index = positions
            .get(&right.id)
            .copied()
            .unwrap_or_else(|| panic!("missing library order entry for {}", right.id));
        left_index.cmp(&right_index)
    });
    libraries
}

fn default_pictures_dir() -> Result<PathBuf, String> {
    Ok(home_dir()?.join("Pictures"))
}

fn custom_library_id(path: &Path) -> String {
    shade_io::local_library_id(path)
}

fn s3_library_id(source_id: &str) -> String {
    shade_io::s3_library_id(source_id)
}

fn ccapi_library_id(host: &str) -> String {
    shade_io::camera_library_id(host)
}

fn peer_library_id(peer_endpoint_id: &str) -> String {
    shade_io::peer_library_id(peer_endpoint_id)
}

fn ccapi_media_path(host: &str, file_path: &str) -> String {
    format!("ccapi://{host}{file_path}")
}

fn ccapi_library_for_host(host: &str, is_online: bool, removable: bool) -> MediaLibrary {
    MediaLibrary {
        id: ccapi_library_id(host),
        name: format!("Camera {host}"),
        kind: "camera".into(),
        path: Some(host.to_string()),
        removable,
        readonly: true,
        is_online: Some(is_online),
        is_refreshing: None,
        mode: "browse".into(),
        sync_target: None,
    }
}

fn peer_library_for_endpoint(
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

fn local_library_is_available(path: &Path) -> bool {
    path.is_dir()
}

fn unavailable_local_library_error(path: &Path) -> String {
    format!("media library is unavailable: {}", path.display())
}

fn require_local_library_path(path: PathBuf) -> Result<PathBuf, String> {
    if local_library_is_available(&path) {
        return Ok(path);
    }
    Err(unavailable_local_library_error(&path))
}

fn library_for_directory(path: PathBuf, is_refreshing: bool) -> MediaLibrary {
    let is_online = local_library_is_available(&path);
    let name = path
        .file_name()
        .and_then(|segment| segment.to_str())
        .map(str::to_string)
        .unwrap_or_else(|| path.display().to_string());
    MediaLibrary {
        id: custom_library_id(&path),
        name,
        kind: "directory".into(),
        path: Some(path.display().to_string()),
        removable: true,
        readonly: false,
        is_online: Some(is_online),
        is_refreshing: Some(is_refreshing && is_online),
        mode: "browse".into(),
        sync_target: None,
    }
}

fn library_for_s3(config: &shade_io::S3LibraryConfig) -> MediaLibrary {
    MediaLibrary {
        id: s3_library_id(&config.id),
        name: shade_io::display_s3_library_name(config),
        kind: "s3".into(),
        path: Some(shade_io::format_s3_library_detail(config)),
        removable: true,
        readonly: false,
        is_online: None,
        is_refreshing: None,
        mode: "browse".into(),
        sync_target: None,
    }
}

fn normalize_upload_file_name(file_name: &str) -> Result<String, String> {
    let trimmed = file_name.trim();
    if trimmed.is_empty() {
        return Err("upload file name cannot be empty".to_string());
    }
    if trimmed == "."
        || trimmed == ".."
        || trimmed.contains('/')
        || trimmed.contains('\\')
    {
        return Err(format!("invalid upload file name: {file_name}"));
    }
    Ok(trimmed.to_string())
}

fn s3_upload_object_key(config: &shade_io::S3LibraryConfig, file_name: &str) -> String {
    match config.prefix.as_deref() {
        Some(prefix) => format!("{prefix}/{file_name}"),
        None => file_name.to_string(),
    }
}

async fn ccapi_host_is_online(host: &str) -> bool {
    let api = shade_io::ccapi::CCAPI::new(host);
    tokio::time::timeout(std::time::Duration::from_millis(1200), api.probe())
        .await
        .is_ok_and(|result| result)
}

fn ipv4_to_u32(ip: Ipv4Addr) -> u32 {
    u32::from_be_bytes(ip.octets())
}

fn u32_to_ipv4(value: u32) -> Ipv4Addr {
    Ipv4Addr::from(value.to_be_bytes())
}

fn local_ipv4_scan_ranges() -> Result<Vec<(Ipv4Addr, Ipv4Addr)>, String> {
    let mut ranges = Vec::new();
    for iface in if_addrs::get_if_addrs().map_err(|e| e.to_string())? {
        let if_addrs::IfAddr::V4(addr) = iface.addr else {
            continue;
        };
        if addr.ip.is_loopback() {
            continue;
        }
        let mask = ipv4_to_u32(addr.netmask);
        let network = ipv4_to_u32(addr.ip) & mask;
        let broadcast = network | !mask;
        if broadcast <= network + 1 {
            continue;
        }
        ranges.push((u32_to_ipv4(network + 1), u32_to_ipv4(broadcast - 1)));
    }
    ranges.sort_unstable();
    ranges.dedup();
    Ok(ranges)
}

async fn host_has_open_port_8080(ip: Ipv4Addr) -> bool {
    tokio::time::timeout(
        std::time::Duration::from_millis(200),
        tokio::net::TcpStream::connect(SocketAddr::new(IpAddr::V4(ip), 8080)),
    )
    .await
    .is_ok_and(|result| result.is_ok())
}

async fn scan_ccapi_hosts_on_local_subnets() -> Result<Vec<String>, String> {
    let semaphore = Arc::new(tokio::sync::Semaphore::new(128));
    let mut join_set = tokio::task::JoinSet::new();
    for (start, end) in local_ipv4_scan_ranges()? {
        let mut current = ipv4_to_u32(start);
        let end = ipv4_to_u32(end);
        while current <= end {
            let ip = u32_to_ipv4(current);
            let permit = semaphore
                .clone()
                .acquire_owned()
                .await
                .expect("camera discovery semaphore closed");
            join_set.spawn(async move {
                let _permit = permit;
                if !host_has_open_port_8080(ip).await {
                    return None;
                }
                let host = format!("{ip}:8080");
                if !ccapi_host_is_online(&host).await {
                    return None;
                }
                Some(host)
            });
            current += 1;
        }
    }
    let mut hosts = Vec::new();
    while let Some(result) = join_set.join_next().await {
        let host = result.map_err(|e| e.to_string())?;
        if let Some(host) = host {
            hosts.push(host);
        }
    }
    hosts.sort();
    hosts.dedup();
    Ok(hosts)
}

pub fn spawn_camera_discovery<R: tauri::Runtime>(app: tauri::AppHandle<R>) {
    #[cfg(any(target_os = "ios", target_os = "android"))]
    {
        let _ = app;
    }

    #[cfg(not(any(target_os = "ios", target_os = "android")))]
    tauri::async_runtime::spawn(async move {
        loop {
            let hosts = scan_ccapi_hosts_on_local_subnets()
                .await
                .expect("camera discovery scan failed");
            app.state::<crate::CameraDiscoveryService>()
                .0
                .replace_hosts(hosts)
                .await;
            tokio::time::sleep(std::time::Duration::from_secs(10)).await;
        }
    });
}

async fn list_desktop_media_libraries<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
) -> Result<Vec<MediaLibrary>, String> {
    let pictures_dir = default_pictures_dir()?;
    let scan_service = &app.state::<crate::LibraryScanService>().0;
    let pictures_online = local_library_is_available(&pictures_dir);
    let mut libraries = vec![MediaLibrary {
        id: "pictures".into(),
        name: "Pictures".into(),
        kind: "directory".into(),
        path: Some(pictures_dir.display().to_string()),
        removable: false,
        readonly: false,
        is_online: Some(pictures_online),
        is_refreshing: Some(pictures_online && scan_service.is_refreshing("pictures")?),
        mode: "browse".into(),
        sync_target: None,
    }];
    let mut config = load_app_config()?;
    let discovered_peers = discovered_peers_by_endpoint(app).await;
    if sync_persisted_peer_names(&mut config, &discovered_peers) {
        save_app_config(&config)?;
    }
    let mut configured_camera_hosts = std::collections::HashSet::new();
    for library in &config.libraries {
        match library {
            shade_io::LibraryConfig::Local(config) => {
                let path = PathBuf::from(&config.path);
                libraries.push(library_for_directory(
                    path.clone(),
                    local_library_is_available(&path)
                        && scan_service.is_refreshing(&custom_library_id(&path))?,
                ));
            }
            shade_io::LibraryConfig::S3(config) => libraries.push(library_for_s3(config)),
            shade_io::LibraryConfig::Camera(config) => {
                configured_camera_hosts.insert(config.host.clone());
                libraries.push(ccapi_library_for_host(
                    &config.host,
                    ccapi_host_is_online(&config.host).await,
                    true,
                ));
            }
            shade_io::LibraryConfig::Peer(config) => {
                let discovered = discovered_peers.get(&config.peer_id);
                libraries.push(peer_library_for_endpoint(
                    &config.peer_id,
                    discovered
                        .map(|peer| peer.name.as_str())
                        .or(config.name.as_deref())
                        .unwrap_or(config.peer_id.as_str()),
                    discovered.is_some(),
                ));
            }
        }
    }
    for host in app
        .state::<crate::CameraDiscoveryService>()
        .0
        .snapshot()
        .await
    {
        if configured_camera_hosts.contains(&host) {
            continue;
        }
        libraries.push(ccapi_library_for_host(&host, true, false));
    }
    let mut result = ordered_library_entries(libraries, &config.library_order);
    for lib in &mut result {
        if let Some(mode) = config.library_modes.get(&lib.id) {
            lib.mode = match mode {
                shade_io::LibraryMode::Browse => "browse".into(),
                shade_io::LibraryMode::Sync => "sync".into(),
            };
        }
        if let Some(target) = config.sync_targets.get(&lib.id) {
            lib.sync_target = Some(target.clone());
        }
    }
    Ok(result)
}

#[tauri::command]
pub async fn set_media_library_order(library_order: Vec<String>) -> Result<(), String> {
    set_library_order(library_order)
}

#[tauri::command]
pub async fn set_library_mode(library_id: String, mode: String, sync_target: Option<String>) -> Result<(), String> {
    let library_mode = match mode.as_str() {
        "browse" => shade_io::LibraryMode::Browse,
        "sync" => shade_io::LibraryMode::Sync,
        other => return Err(format!("invalid library mode: {other}")),
    };
    let mut config = load_app_config()?;
    config.library_modes.insert(library_id.clone(), library_mode);
    match sync_target {
        Some(target) => { config.sync_targets.insert(library_id, target); }
        None => { config.sync_targets.remove(&library_id); }
    }
    save_app_config(&config)
}

#[tauri::command]
pub async fn sync_library<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    library_id: String,
    p2p: tauri::State<'_, crate::P2pState>,
) -> Result<(), String> {
    if library_id.starts_with("s3:") {
        sync_download_s3(&app, &library_id).await
    } else if library_id.starts_with("peer:") {
        sync_download_peer(&app, &library_id, &p2p).await
    } else {
        sync_upload_local(&app, &library_id).await
    }
}

async fn sync_download_s3<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    library_id: &str,
) -> Result<(), String> {
    let sync_dir = library_sync_dir(library_id)?;
    let config = resolve_s3_library_config(library_id)?;
    let objects = shade_io::list_s3_objects(&config).await?;
    let entries: Vec<_> = objects
        .into_iter()
        .filter(|entry| is_supported_library_image(Path::new(&entry.key)))
        .collect();
    let total = entries.len();
    for (i, entry) in entries.iter().enumerate() {
        let file_name = Path::new(&entry.key)
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| entry.key.clone());
        let dest = sync_dir.join(&file_name);
        if dest.exists() {
            continue;
        }
        let _ = app.emit(
            "library-sync-progress",
            LibrarySyncProgress {
                library_id: library_id.to_owned(),
                total,
                completed: i,
                current_name: Some(file_name.clone()),
            },
        );
        let bytes = shade_io::get_s3_object_bytes(&config, &entry.key).await?;
        std::fs::write(&dest, &bytes).map_err(|e| e.to_string())?;
    }
    emit_sync_complete(app, library_id, total);
    Ok(())
}

async fn sync_download_peer<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    library_id: &str,
    p2p: &tauri::State<'_, crate::P2pState>,
) -> Result<(), String> {
    let sync_dir = library_sync_dir(library_id)?;
    let peer_endpoint_id = library_id
        .strip_prefix("peer:")
        .expect("peer: prefix already checked");
    let p2p_handle = require_p2p(p2p).await?;
    let pictures = p2p_handle
        .list_peer_pictures(peer_endpoint_id)
        .await
        .map_err(|e| e.to_string())?;
    let total = pictures.len();
    for (i, picture) in pictures.iter().enumerate() {
        let dest = sync_dir.join(&picture.name);
        if dest.exists() {
            continue;
        }
        let _ = app.emit(
            "library-sync-progress",
            LibrarySyncProgress {
                library_id: library_id.to_owned(),
                total,
                completed: i,
                current_name: Some(picture.name.clone()),
            },
        );
        let bytes = p2p_handle
            .get_peer_image_bytes(peer_endpoint_id, &picture.id)
            .await
            .map_err(|e| e.to_string())?;
        std::fs::write(&dest, &bytes).map_err(|e| e.to_string())?;
    }
    emit_sync_complete(app, library_id, total);
    Ok(())
}

async fn sync_upload_local<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    library_id: &str,
) -> Result<(), String> {
    let library_path =
        require_local_library_path(resolve_desktop_library_path(library_id)?)?;
    let local_files = scan_directory_images(&library_path)?;
    if local_files.is_empty() {
        return Ok(());
    }

    let config = load_app_config()?;
    let target_id = config
        .sync_targets
        .get(library_id)
        .ok_or_else(|| format!("no sync target configured for library: {library_id}"))?;
    let target = resolve_s3_library_config(target_id)?;
    let remote_names = list_s3_remote_names(&target).await?;
    let total = local_files.len();
    let mut completed = 0;

    for local_file in &local_files {
        let local_path = Path::new(&local_file.path);
        let file_name = local_path
            .file_name()
            .and_then(|n| n.to_str())
            .ok_or_else(|| format!("invalid file name: {}", local_file.path))?;
        if remote_names.contains(file_name) {
            completed += 1;
            continue;
        }
        let _ = app.emit(
            "library-sync-progress",
            LibrarySyncProgress {
                library_id: library_id.to_owned(),
                total,
                completed,
                current_name: Some(file_name.to_owned()),
            },
        );
        let bytes = std::fs::read(local_path).map_err(|e| e.to_string())?;
        let key = s3_upload_object_key(&target, file_name);
        shade_io::put_s3_object_bytes_with_modified(&target, &key, &bytes, local_file.modified_at).await?;
        completed += 1;
    }
    emit_sync_complete(app, library_id, total);
    Ok(())
}

async fn list_s3_remote_names(
    config: &shade_io::S3LibraryConfig,
) -> Result<std::collections::HashSet<String>, String> {
    let objects = shade_io::list_s3_objects(config).await?;
    Ok(objects
        .into_iter()
        .filter_map(|entry| {
            Path::new(&entry.key)
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
        })
        .collect())
}

fn emit_sync_complete<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    library_id: &str,
    total: usize,
) {
    let _ = app.emit(
        "library-sync-progress",
        LibrarySyncProgress {
            library_id: library_id.to_owned(),
            total,
            completed: total,
            current_name: None,
        },
    );
}

fn resolve_desktop_library_path(library_id: &str) -> Result<PathBuf, String> {
    if library_id == "pictures" {
        return default_pictures_dir();
    }
    for library in load_app_config()?.libraries {
        if let shade_io::LibraryConfig::Local(config) = library {
            let path = PathBuf::from(&config.path);
            if custom_library_id(&path) == library_id {
                return Ok(path);
            }
        }
    }
    Err(format!("unknown media library: {library_id}"))
}

fn desktop_local_library_roots() -> Result<Vec<(String, PathBuf)>, String> {
    let mut roots = vec![("pictures".to_string(), default_pictures_dir()?)];
    for library in load_app_config()?.libraries {
        if let shade_io::LibraryConfig::Local(config) = library {
            let path = PathBuf::from(config.path);
            roots.push((custom_library_id(&path), path));
        }
    }
    Ok(roots)
}

fn local_upload_target_path(
    library_root: &Path,
    file_name: &str,
) -> Result<PathBuf, String> {
    let normalized = normalize_upload_file_name(file_name)?;
    let target_path = library_root.join(&normalized);
    if target_path.exists() {
        return Err(format!(
            "upload destination already exists: {}",
            target_path.display()
        ));
    }
    Ok(target_path)
}

fn timestamp_suffix_file_name(file_name: &str) -> Result<String, String> {
    let path = Path::new(file_name);
    let stem = path
        .file_stem()
        .and_then(|segment| segment.to_str())
        .ok_or_else(|| format!("invalid upload file name: {file_name}"))?;
    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|error| error.to_string())?
        .as_millis();
    let suffixed = match path.extension().and_then(|segment| segment.to_str()) {
        Some(extension) => format!("{stem}-{timestamp}.{extension}"),
        None => format!("{stem}-{timestamp}"),
    };
    normalize_upload_file_name(&suffixed)
}

fn local_upload_target_path_with_conflict_policy(
    library_root: &Path,
    file_name: &str,
    append_timestamp_on_conflict: bool,
) -> Result<PathBuf, String> {
    match local_upload_target_path(library_root, file_name) {
        Ok(path) => Ok(path),
        Err(error)
            if append_timestamp_on_conflict
                && error.starts_with("upload destination already exists: ") =>
        {
            local_upload_target_path(
                library_root,
                &timestamp_suffix_file_name(file_name)?,
            )
        }
        Err(error) => Err(error),
    }
}

fn resolve_local_library_item(path: &str) -> Result<(String, PathBuf), String> {
    let item_path = PathBuf::from(path);
    if !item_path.is_file() {
        return Err(format!("media item path is not a file: {path}"));
    }
    let canonical_item_path =
        std::fs::canonicalize(&item_path).map_err(|e| e.to_string())?;
    for (library_id, root) in desktop_local_library_roots()? {
        if !local_library_is_available(&root) {
            continue;
        }
        let canonical_root = std::fs::canonicalize(&root).map_err(|e| e.to_string())?;
        if canonical_item_path.starts_with(&canonical_root) {
            return Ok((library_id, canonical_item_path));
        }
    }
    Err(format!("media item is not part of a local library: {path}"))
}

async fn refresh_desktop_local_library<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    library_id: &str,
    library_root: PathBuf,
) -> Result<(), String> {
    app.state::<crate::LibraryScanService>()
        .0
        .refresh_library(library_id, library_root)
        .await
}

fn start_s3_library_scan(
    snapshot: Arc<Mutex<shade_io::LibraryScanSnapshot>>,
    index_db: Arc<shade_io::LibraryIndexDb>,
    config: shade_io::S3LibraryConfig,
    publish_progress: bool,
) -> Result<(), String> {
    let library_id = s3_library_id(&config.id);
    let root = shade_io::format_s3_library_detail(&config);
    {
        let mut guard = snapshot
            .lock()
            .map_err(|_| "S3 library scan snapshot lock poisoned".to_string())?;
        if guard.is_scanning {
            return Err(format!(
                "library index refresh already running: {library_id}"
            ));
        }
        guard.is_scanning = true;
        guard.is_complete = false;
        guard.error = None;
        if publish_progress {
            guard.items.clear();
            guard.completed_at = None;
        }
    }
    std::thread::Builder::new()
        .name("shade-s3-library-scan".into())
        .spawn(move || {
            let result = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .map_err(|error| error.to_string())
                .and_then(|runtime| {
                    runtime.block_on(async {
                        let items = scan_s3_library_into_snapshot(
                            &config,
                            &snapshot,
                            publish_progress,
                        )
                        .await?;
                        let indexed_at = replace_persisted_library_index_by_root(
                            &index_db,
                            &library_id,
                            &root,
                            &items,
                        )
                        .await?;
                        Ok::<(Vec<shade_io::IndexedLibraryImage>, u64), String>((
                            items, indexed_at,
                        ))
                    })
                });
            let mut guard = snapshot
                .lock()
                .expect("S3 library scan snapshot lock poisoned");
            match result {
                Ok((items, indexed_at)) => {
                    if !publish_progress {
                        guard.items = items;
                    }
                    guard.completed_at = Some(indexed_at);
                }
                Err(error) => {
                    guard.error = Some(error);
                }
            }
            guard.is_scanning = false;
            guard.is_complete = true;
        })
        .map_err(|error| error.to_string())?;
    Ok(())
}

async fn scan_s3_library_into_snapshot(
    config: &shade_io::S3LibraryConfig,
    snapshot: &Arc<Mutex<shade_io::LibraryScanSnapshot>>,
    publish_progress: bool,
) -> Result<Vec<shade_io::IndexedLibraryImage>, String> {
    let mut continuation_token: Option<String> = None;
    let mut batch = Vec::new();
    let mut items = Vec::new();
    loop {
        let page =
            shade_io::list_s3_objects_page(config, continuation_token.as_deref()).await?;
        for object in page.objects {
            if !is_supported_library_image(Path::new(&object.key)) {
                continue;
            }
            let item = shade_io::IndexedLibraryImage {
                name: picture_display_name(&object.key),
                path: shade_io::media_path_for_s3_object(&config.id, &object.key),
                modified_at: object.modified_at,
                rating: None,
            };
            items.push(item.clone());
            if publish_progress {
                batch.push(item);
            }
        }
        if publish_progress && batch.len() >= 64 {
            shade_io::flush_library_scan_batch(snapshot, &mut batch)?;
        }
        continuation_token = page.next_continuation_token;
        if continuation_token.is_none() {
            break;
        }
    }
    if publish_progress {
        shade_io::flush_library_scan_batch(snapshot, &mut batch)?;
    }
    shade_io::sort_indexed_library_items(&mut items);
    Ok(items)
}

pub fn prime_missing_library_indexes<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
) -> Result<(), String> {
    #[cfg(any(target_os = "ios", target_os = "android"))]
    {
        let _ = app;
        Ok(())
    }

    #[cfg(not(any(target_os = "ios", target_os = "android")))]
    {
        let index_db = library_index_db();
        let library_scan_service = app.state::<crate::LibraryScanService>().0.clone();
        let s3_scan_service = app.state::<crate::S3LibraryScanService>().0.clone();
        for (library_id, root) in desktop_local_library_roots()? {
            if !local_library_is_available(&root) {
                continue;
            }
            library_scan_service.watch_library(&library_id, root.clone())?;
            if tauri::async_runtime::block_on(has_persisted_library_index(
                index_db,
                &library_id,
                &root,
            ))? {
                continue;
            }
            tauri::async_runtime::block_on(library_scan_service.refresh_library(
                &library_id,
                root,
            ))?;
        }
        for library in load_app_config()?.libraries {
            let shade_io::LibraryConfig::S3(config) = library else {
                continue;
            };
            if tauri::async_runtime::block_on(has_persisted_library_index_by_root(
                index_db,
                &s3_library_id(&config.id),
                &shade_io::format_s3_library_detail(&config),
            ))? {
                continue;
            }
            tauri::async_runtime::block_on(
                s3_scan_service.refresh_library(&config),
            )?;
        }
        Ok(())
    }
}

fn resolve_ccapi_library_host(library_id: &str) -> Result<String, String> {
    let host = library_id
        .strip_prefix("ccapi:")
        .ok_or_else(|| format!("unknown camera library: {library_id}"))?;
    if host.is_empty() {
        return Err(format!("unknown camera library: {library_id}"));
    }
    Ok(host.to_string())
}

fn collect_images_in_directory(dir: &Path) -> Result<Vec<LibraryImage>, String> {
    Ok(scan_directory_images(dir)?
        .into_iter()
        .map(|item| LibraryImage {
            name: item.name,
            path: item.path,
            modified_at: item.modified_at,
            file_hash: None,
            metadata: LibraryImageMetadata {
                has_snapshots: false,
                latest_snapshot_id: None,
                rating: item.rating,
                tags: Vec::new(),
            },
        })
        .collect())
}

fn ccapi_rating(value: &str) -> Result<Option<u8>, String> {
    shade_io::library_index::normalize_rating(value)
}

async fn list_ccapi_library_images(host: &str) -> Result<LibraryImageListing, String> {
    let api = shade_io::ccapi::CCAPI::new(host);
    let storage = api.storage().await.map_err(|e| e.to_string())?;
    let mut items = Vec::new();
    for storage in storage.storagelist {
        for file_path in api.files(&storage).await.map_err(|e| e.to_string())? {
            let info = match tokio::time::timeout(
                std::time::Duration::from_secs(2),
                api.info(&file_path),
            )
            .await
            {
                Ok(result) => Some(result.map_err(|error| error.to_string())?),
                Err(_) => {
                    return Err(format!(
                        "timed out loading CCAPI metadata for {file_path}"
                    ))
                }
            };
            let modified_at = info
                .as_ref()
                .map(|value| chrono_like_timestamp_millis(&value.lastmodifieddate))
                .transpose()?
                .flatten();
            let rating = info
                .as_ref()
                .map(|value| ccapi_rating(&value.rating))
                .transpose()?
                .flatten();
            items.push(LibraryImage {
                name: picture_display_name(&file_path),
                path: ccapi_media_path(host, &file_path),
                modified_at,
                file_hash: None,
                metadata: LibraryImageMetadata {
                    has_snapshots: false,
                    latest_snapshot_id: None,
                    rating,
                    tags: Vec::new(),
                },
            });
        }
    }
    items.sort_by(|left, right| right.modified_at.cmp(&left.modified_at));
    Ok(LibraryImageListing {
        items,
        is_complete: true,
    })
}

fn resolve_s3_library_config(
    library_id: &str,
) -> Result<shade_io::S3LibraryConfig, String> {
    let source_id = shade_io::resolve_s3_source_id_from_library_id(library_id)?;
    for library in load_app_config()?.libraries {
        if let shade_io::LibraryConfig::S3(config) = library {
            if config.id == source_id {
                return Ok(config);
            }
        }
    }
    Err(format!("unknown S3 media library: {library_id}"))
}

fn resolve_s3_library_for_media_path(
    picture_id: &str,
) -> Result<(shade_io::S3LibraryConfig, String), String> {
    let (source_id, key) = shade_io::parse_s3_media_path(picture_id)?;
    Ok((
        resolve_s3_library_config(&s3_library_id(source_id))?,
        key.to_string(),
    ))
}

async fn list_s3_library_images<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    config: &shade_io::S3LibraryConfig,
) -> Result<LibraryImageListing, String> {
    let snapshot = app
        .state::<crate::S3LibraryScanService>()
        .0
        .snapshot_for_library(config)
        .await?;
    Ok(LibraryImageListing {
        items: snapshot
            .items
            .into_iter()
            .map(local_library_image)
            .collect(),
        is_complete: snapshot.is_complete,
    })
}

fn chrono_like_timestamp_millis(value: &str) -> Result<Option<u64>, String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }
    let normalized = trimmed.replace(' ', "T");
    let parsed = chrono::DateTime::parse_from_rfc2822(trimmed)
        .or_else(|_| chrono::DateTime::parse_from_rfc3339(trimmed))
        .or_else(|_| chrono::DateTime::parse_from_rfc3339(&format!("{normalized}Z")))
        .or_else(|_| chrono::DateTime::parse_from_rfc3339(&normalized))
        .map_err(|e| format!("invalid CCAPI timestamp `{trimmed}`: {e}"))?;
    u64::try_from(parsed.timestamp_millis())
        .map(Some)
        .map_err(|e| e.to_string())
}

fn local_library_image(item: shade_io::IndexedLibraryImage) -> LibraryImage {
    LibraryImage {
        name: item.name,
        path: item.path,
        modified_at: item.modified_at,
        file_hash: None,
        metadata: LibraryImageMetadata {
            has_snapshots: false,
            latest_snapshot_id: None,
            rating: item.rating,
            tags: Vec::new(),
        },
    }
}

async fn load_camera_thumbnail_from_tauri<R: tauri::Runtime>(
    _app: &tauri::AppHandle<R>,
    host: &str,
    file_path: &str,
) -> Result<Vec<u8>, String> {
    let _permit = _app
        .state::<crate::CameraThumbnailService>()
        .0
        .acquire(host)
        .await?;
    shade_io::ccapi::CCAPI::new(host)
        .thumbnail(file_path)
        .await
        .map(|bytes| bytes.to_vec())
        .map_err(|error| error.to_string())
}

async fn load_s3_thumbnail_from_tauri(picture_id: &str) -> Result<Vec<u8>, String> {
    let (config, key) = resolve_s3_library_for_media_path(picture_id)?;
    let bytes = shade_io::get_s3_object_bytes(&config, &key).await?;
    let (pixels, width, height) =
        load_image_bytes(&bytes, Some(&picture_display_name(&key)))
            .map_err(|error| error.to_string())?;
    let image = image::RgbaImage::from_raw(width, height, pixels).ok_or_else(|| {
        format!("failed to decode S3 image for thumbnail: {picture_id}")
    })?;
    let thumbnail = image::DynamicImage::ImageRgba8(image).thumbnail(320, 320);
    let mut jpeg = Vec::new();
    thumbnail
        .write_to(
            &mut std::io::Cursor::new(&mut jpeg),
            image::ImageFormat::Jpeg,
        )
        .map_err(|error| error.to_string())?;
    Ok(jpeg)
}

async fn load_photo_thumbnail_from_tauri<R: tauri::Runtime>(
    _app: &tauri::AppHandle<R>,
    picture_id: &str,
) -> Result<Option<Vec<u8>>, String> {
    #[cfg(target_os = "android")]
    if picture_id.starts_with("content://") {
        return _app
            .state::<crate::photos::PhotosHandle<R>>()
            .get_thumbnail(picture_id)
            .await
            .map(Some);
    }

    #[cfg(target_os = "ios")]
    if !picture_id.starts_with('/') {
        let picture_id = picture_id.to_owned();
        let bytes = tokio::task::spawn_blocking(move || {
            let c_id =
                std::ffi::CString::new(picture_id.as_str()).map_err(|e| e.to_string())?;
            let mut out_size: i32 = 0;
            let ptr =
                unsafe { ios_get_thumbnail(c_id.as_ptr(), 320, 320, &mut out_size) };
            if ptr.is_null() {
                return Err("failed to get thumbnail from photo library".to_string());
            }
            let bytes = unsafe {
                let v = std::slice::from_raw_parts(ptr, out_size as usize).to_vec();
                ios_free_buffer(ptr);
                v
            };
            Ok(bytes)
        })
        .await
        .map_err(|error| error.to_string())??;
        return Ok(Some(bytes));
    }

    let _ = picture_id;
    Ok(None)
}

async fn load_camera_image_from_tauri(
    host: &str,
    file_path: &str,
) -> Result<Vec<u8>, String> {
    shade_io::ccapi::CCAPI::new(host)
        .original(file_path)
        .await
        .map(|bytes| bytes.to_vec())
        .map_err(|error| error.to_string())
}

async fn load_s3_image_from_tauri(path: &str) -> Result<Vec<u8>, String> {
    let (config, key) = resolve_s3_library_for_media_path(path)?;
    shade_io::get_s3_object_bytes(&config, &key).await
}

async fn load_photo_image_from_tauri<R: tauri::Runtime>(
    _app: &tauri::AppHandle<R>,
    picture_id: &str,
) -> Result<Option<Vec<u8>>, String> {
    #[cfg(target_os = "android")]
    if picture_id.starts_with("content://") {
        return _app
            .state::<crate::photos::PhotosHandle<R>>()
            .get_image_data(picture_id)
            .await
            .map(Some);
    }

    #[cfg(target_os = "ios")]
    if !picture_id.starts_with('/') {
        let picture_id = picture_id.to_owned();
        let bytes = tokio::task::spawn_blocking(move || {
            let c_id =
                std::ffi::CString::new(picture_id.as_str()).map_err(|e| e.to_string())?;
            let mut out_size: i32 = 0;
            let ptr = unsafe { ios_get_image_data(c_id.as_ptr(), &mut out_size) };
            if ptr.is_null() {
                return Err("failed to fetch image from photo library".to_string());
            }
            let bytes = unsafe {
                let v = std::slice::from_raw_parts(ptr, out_size as usize).to_vec();
                ios_free_buffer(ptr);
                v
            };
            Ok(bytes)
        })
        .await
        .map_err(|error| error.to_string())??;
        return Ok(Some(bytes));
    }

    let _ = picture_id;
    Ok(None)
}

pub enum RenderJob {
    Preview {
        stack: LayerStack,
        sources: Arc<std::collections::HashMap<shade_core::TextureId, FloatImage>>,
        canvas_width: u32,
        canvas_height: u32,
        request: PreviewRenderRequest,
        response: tokio::sync::oneshot::Sender<Result<PreviewFrameResponse, String>>,
    },
    PreviewFloat16 {
        stack: LayerStack,
        sources: Arc<std::collections::HashMap<shade_core::TextureId, FloatImage>>,
        canvas_width: u32,
        canvas_height: u32,
        request: PreviewRenderRequest,
        response:
            tokio::sync::oneshot::Sender<Result<PreviewFrameFloat16Response, String>>,
    },
    Export {
        stack: LayerStack,
        sources: Arc<std::collections::HashMap<shade_core::TextureId, FloatImage>>,
        canvas_width: u32,
        canvas_height: u32,
        request: PreviewRenderRequest,
        response: tokio::sync::oneshot::Sender<Result<Vec<u8>, String>>,
    },
}

pub struct ThumbnailRenderJob {
    stack: LayerStack,
    sources: Arc<std::collections::HashMap<shade_core::TextureId, FloatImage>>,
    canvas_width: u32,
    canvas_height: u32,
    request: PreviewRenderRequest,
    response: tokio::sync::oneshot::Sender<Result<Vec<u8>, String>>,
}

fn panic_to_string(payload: Box<dyn std::any::Any + Send>) -> String {
    if let Some(s) = payload.downcast_ref::<&str>() {
        return (*s).to_string();
    }
    if let Some(s) = payload.downcast_ref::<String>() {
        return s.clone();
    }
    "render worker panic".to_string()
}

pub fn spawn_render_worker() -> crossbeam_channel::Sender<RenderJob> {
    let (sender, receiver) = crossbeam_channel::unbounded::<RenderJob>();
    std::thread::Builder::new()
        .name("shade-render".into())
        .spawn(move || {
            let runtime = match tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
            {
                Ok(r) => r,
                Err(e) => {
                    eprintln!("render worker: failed to create runtime: {e}");
                    return;
                }
            };
            let renderer = match runtime.block_on(Renderer::new()) {
                Ok(r) => r,
                Err(e) => {
                    eprintln!("render worker: Renderer::new() failed: {e}");
                    return;
                }
            };
            eprintln!("render worker: ready");
            let mut deferred_job = None;
            loop {
                let mut job = match deferred_job.take() {
                    Some(job) => job,
                    None => match receiver.recv() {
                        Ok(job) => job,
                        Err(_) => break,
                    },
                };
                if matches!(
                    job,
                    RenderJob::Preview { .. } | RenderJob::PreviewFloat16 { .. }
                ) {
                    loop {
                        match receiver.try_recv() {
                            Ok(next_job) => match next_job {
                                RenderJob::Preview { .. }
                                | RenderJob::PreviewFloat16 { .. } => {
                                    job = next_job;
                                }
                                _ => {
                                    deferred_job = Some(next_job);
                                    break;
                                }
                            },
                            Err(crossbeam_channel::TryRecvError::Empty) => break,
                            Err(crossbeam_channel::TryRecvError::Disconnected) => break,
                        }
                    }
                }
                match job {
                    RenderJob::Preview {
                        stack,
                        sources,
                        canvas_width,
                        canvas_height,
                        request,
                        response,
                    } => {
                        let result = std::panic::catch_unwind(
                            std::panic::AssertUnwindSafe(|| {
                                runtime
                                    .block_on(renderer.render_stack_preview(
                                        &stack,
                                        sources.as_ref(),
                                        canvas_width,
                                        canvas_height,
                                        request.target_width,
                                        request.target_height,
                                        request.crop.map(|crop| GpuPreviewCrop {
                                            x: crop.x,
                                            y: crop.y,
                                            width: crop.width,
                                            height: crop.height,
                                        }),
                                    ))
                                    .map(|pixels| PreviewFrameResponse {
                                        pixels,
                                        width: request.target_width,
                                        height: request.target_height,
                                    })
                                    .map_err(|e| e.to_string())
                            }),
                        )
                        .unwrap_or_else(|e| Err(panic_to_string(e)));
                        let _ = response.send(result);
                    }
                    RenderJob::PreviewFloat16 {
                        stack,
                        sources,
                        canvas_width,
                        canvas_height,
                        request,
                        response,
                    } => {
                        let result = std::panic::catch_unwind(
                            std::panic::AssertUnwindSafe(|| {
                                runtime
                                    .block_on(renderer.render_stack_preview_f16(
                                        &stack,
                                        sources.as_ref(),
                                        canvas_width,
                                        canvas_height,
                                        request.target_width,
                                        request.target_height,
                                        request.crop.map(|crop| GpuPreviewCrop {
                                            x: crop.x,
                                            y: crop.y,
                                            width: crop.width,
                                            height: crop.height,
                                        }),
                                    ))
                                    .map(|pixels| PreviewFrameFloat16Response {
                                        pixels,
                                        width: request.target_width,
                                        height: request.target_height,
                                    })
                                    .map_err(|e| e.to_string())
                            }),
                        )
                        .unwrap_or_else(|e| Err(panic_to_string(e)));
                        let _ = response.send(result);
                    }
                    RenderJob::Export {
                        stack,
                        sources,
                        canvas_width,
                        canvas_height,
                        request,
                        response,
                    } => {
                        let result = std::panic::catch_unwind(
                            std::panic::AssertUnwindSafe(|| {
                                runtime
                                    .block_on(renderer.render_stack_preview(
                                        &stack,
                                        sources.as_ref(),
                                        canvas_width,
                                        canvas_height,
                                        request.target_width,
                                        request.target_height,
                                        request.crop.map(|crop| GpuPreviewCrop {
                                            x: crop.x,
                                            y: crop.y,
                                            width: crop.width,
                                            height: crop.height,
                                        }),
                                    ))
                                    .map_err(|e| e.to_string())
                            }),
                        )
                        .unwrap_or_else(|e| Err(panic_to_string(e)));
                        let _ = response.send(result);
                    }
                }
            }
        })
        .expect("failed to spawn render worker thread");
    sender
}

pub fn spawn_thumbnail_render_worker() -> crossbeam_channel::Sender<ThumbnailRenderJob> {
    let (sender, receiver) = crossbeam_channel::unbounded::<ThumbnailRenderJob>();
    std::thread::Builder::new()
        .name("shade-thumbnail-render".into())
        .spawn(move || {
            let runtime = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .expect("failed to create thumbnail render runtime");
            let renderer = runtime.block_on(Renderer::new()).map_err(|e| e.to_string());
            while let Ok(job) = receiver.recv() {
                let result = match &renderer {
                    Ok(renderer) => {
                        std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                            runtime
                                .block_on(renderer.render_stack_preview(
                                    &job.stack,
                                    job.sources.as_ref(),
                                    job.canvas_width,
                                    job.canvas_height,
                                    job.request.target_width,
                                    job.request.target_height,
                                    job.request.crop.map(|crop| GpuPreviewCrop {
                                        x: crop.x,
                                        y: crop.y,
                                        width: crop.width,
                                        height: crop.height,
                                    }),
                                ))
                                .map_err(|e| e.to_string())
                                .and_then(|pixels| {
                                    encode_jpeg_thumbnail(
                                        pixels,
                                        job.request.target_width,
                                        job.request.target_height,
                                    )
                                })
                        }))
                        .unwrap_or_else(|e| Err(panic_to_string(e)))
                    }
                    Err(error) => Err(error.clone()),
                };
                let _ = job.response.send(result);
            }
        })
        .expect("failed to spawn thumbnail render worker thread");
    sender
}

impl Default for EditorState {
    fn default() -> Self {
        Self {
            stack: LayerStack::new(),
            image_sources: Arc::new(std::collections::HashMap::new()),
            canvas_width: 1920,
            canvas_height: 1080,
            next_texture_id: 1,
            source_bit_depth: "Unknown".into(),
            current_image_hash: None,
            current_image_source: None,
            current_snapshot_id: None,
            next_open_request_id: 0,
            active_open_request_id: 0,
        }
    }
}

impl EditorState {
    pub fn begin_open_request(&mut self) -> u64 {
        self.next_open_request_id += 1;
        self.active_open_request_id = self.next_open_request_id;
        self.active_open_request_id
    }

    pub fn is_current_open_request(&self, request_id: u64) -> bool {
        self.active_open_request_id == request_id
    }

    pub fn replace_with_image(
        &mut self,
        mut pixels: Vec<f32>,
        width: u32,
        height: u32,
        source_bit_depth: String,
        color_space: shade_core::ColorSpace,
    ) -> LayerInfoResponse {
        // Convert source pixels to linear sRGB (the internal working space).
        to_linear_srgb_f32(&mut pixels, &color_space);
        let texture_id = self.next_texture_id;
        self.next_texture_id += 1;
        self.stack = LayerStack::new();
        self.image_sources = Arc::new(std::collections::HashMap::from([(
            texture_id,
            FloatImage {
                pixels: pixels.into(),
                width,
                height,
            },
        )]));
        self.canvas_width = width;
        self.canvas_height = height;
        self.source_bit_depth = source_bit_depth.clone();
        self.current_image_hash = None;
        self.current_image_source = None;
        self.current_snapshot_id = None;
        self.stack.add_image_layer(texture_id, width, height);
        self.stack.add_adjustment_layer(vec![AdjustmentOp::Tone {
            exposure: 0.0,
            contrast: 0.0,
            blacks: 0.0,
            whites: 0.0,
            highlights: 0.0,
            shadows: 0.0,
            gamma: 1.0,
        }]);
        LayerInfoResponse {
            layer_count: self.stack.layers.len(),
            canvas_width: width,
            canvas_height: height,
            source_bit_depth,
            file_hash: None,
        }
    }

    pub fn replace_with_linear_image(
        &mut self,
        pixels: Vec<f32>,
        width: u32,
        height: u32,
        source_bit_depth: String,
    ) -> LayerInfoResponse {
        let texture_id = self.next_texture_id;
        self.next_texture_id += 1;
        self.stack = LayerStack::new();
        self.image_sources = Arc::new(std::collections::HashMap::from([(
            texture_id,
            FloatImage {
                pixels: pixels.into(),
                width,
                height,
            },
        )]));
        self.canvas_width = width;
        self.canvas_height = height;
        self.source_bit_depth = source_bit_depth.clone();
        self.current_image_hash = None;
        self.current_image_source = None;
        self.current_snapshot_id = None;
        self.stack.add_image_layer(texture_id, width, height);
        self.stack.add_adjustment_layer(vec![AdjustmentOp::Tone {
            exposure: 0.0,
            contrast: 0.0,
            blacks: 0.0,
            whites: 0.0,
            highlights: 0.0,
            shadows: 0.0,
            gamma: 1.0,
        }]);
        LayerInfoResponse {
            layer_count: self.stack.layers.len(),
            canvas_width: width,
            canvas_height: height,
            source_bit_depth,
            file_hash: None,
        }
    }
}

// Commands return Result<T, String> where Err is displayed to the user

#[derive(Serialize, Deserialize, Debug)]
pub struct LayerInfoResponse {
    pub layer_count: usize,
    pub canvas_width: u32,
    pub canvas_height: u32,
    pub source_bit_depth: String,
    pub file_hash: Option<String>,
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
pub async fn get_peer_thumbnail(
    peer_endpoint_id: String,
    picture_id: String,
    p2p: tauri::State<'_, crate::P2pState>,
) -> Result<Vec<u8>, String> {
    require_p2p(&p2p)
        .await?
        .get_peer_thumbnail(&peer_endpoint_id, &picture_id)
        .await
        .map_err(|error| error.to_string())
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
    file_hash: Option<String>,
    snapshot_id: Option<String>,
    awareness: tauri::State<'_, crate::AwarenessStateHandle>,
) -> Result<(), String> {
    let mut state = awareness.0.lock().await;
    if display_name.is_some() {
        state.display_name = display_name;
    }
    state.active_file_hash = file_hash;
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

/// Pull snapshots from a peer for the given file_hash that we don't have locally.
/// Returns the list of newly inserted snapshot IDs.
#[tauri::command]
pub async fn sync_peer_snapshots(
    peer_endpoint_id: String,
    file_hash: String,
    p2p: tauri::State<'_, crate::P2pState>,
) -> Result<SyncPeerSnapshotsResult, String> {
    let p2p = require_p2p(&p2p).await?;
    Ok(SyncPeerSnapshotsResult {
        synced_ids: sync_peer_snapshots_for_file_hash(
            &peer_endpoint_id,
            &file_hash,
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
    file_hashes: Vec<String>,
    p2p: tauri::State<'_, crate::P2pState>,
) -> Result<ApplyPeerMetadataResult, String> {
    let p2p = require_p2p(&p2p).await?;

    if file_hashes.is_empty() {
        return Ok(ApplyPeerMetadataResult {
            ratings_updated: 0,
            tags_added: 0,
        });
    }

    let peer_metadata = p2p
        .get_peer_metadata(&peer_endpoint_id, &file_hashes)
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
                    "SELECT updated_at FROM media_ratings WHERE file_hash = ?1 LIMIT 1",
                    [meta.file_hash.as_str()],
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
                    "INSERT INTO media_ratings (file_hash, rating, updated_at)
                     VALUES (?1, ?2, ?3)
                     ON CONFLICT(file_hash)
                     DO UPDATE SET rating = excluded.rating, updated_at = excluded.updated_at",
                    libsql::params![meta.file_hash.as_str(), i64::from(peer_rating), peer_ts],
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
                    "SELECT tag FROM media_tags WHERE file_hash = ?1",
                    [meta.file_hash.as_str()],
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
                        "INSERT INTO media_tags (file_hash, tag, updated_at)
                         VALUES (?1, ?2, ?3)",
                        libsql::params![
                            meta.file_hash.as_str(),
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
pub async fn open_peer_image(
    peer_endpoint_id: String,
    picture_id: String,
    file_name: Option<String>,
    p2p: tauri::State<'_, crate::P2pState>,
    state: tauri::State<'_, Mutex<EditorState>>,
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
    let file_hash = hash_bytes(&bytes);
    let peer = require_p2p(&p2p).await?;
    let _ = sync_peer_snapshots_for_file_hash(
        &peer_endpoint_id,
        &file_hash,
        &peer,
        Some(&picture_id),
    )
    .await;
    register_image_source(&file_hash, Some(&picture_id)).await?;
    let persisted = load_latest_edit_version(&file_hash).await?;
    let (image, info) = decode_image_bytes_with_info(&bytes, file_name.as_deref())?;
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
            file_hash.clone(),
            Some(picture_id),
            persisted,
        )?;
        response.file_hash = Some(file_hash);
        response
    };
    Ok(response)
}

#[tauri::command]
#[allow(unused_variables)]
pub async fn open_image<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    path: String,
    p2p: tauri::State<'_, crate::P2pState>,
    state: tauri::State<'_, Mutex<EditorState>>,
) -> Result<LayerInfoResponse, String> {
    let open_request_id = {
        let mut st = lock_editor_state(&state)?;
        st.begin_open_request()
    };
    let photo_app = app.clone();
    let opened =
        shade_io::open_image(
            &path,
            |host, file_path| async move {
                load_camera_image_from_tauri(&host, &file_path).await
            },
            |s3_path| async move { load_s3_image_from_tauri(&s3_path).await },
            move |picture_id| {
                let app = photo_app.clone();
                async move { load_photo_image_from_tauri(&app, &picture_id).await }
            },
        )
        .await?;
    let file_hash = opened.file_hash;
    if let Some(source_name) = opened.source_name.as_deref() {
        register_image_source(&file_hash, Some(source_name)).await?;
    }
    if let Some(peer) = p2p.0.read().await.clone() {
        let _ = sync_snapshots_from_all_peers_for_file_hash(&peer, &file_hash).await;
    }
    let persisted = load_latest_edit_version(&file_hash).await?;
    let response = {
        let mut st = lock_editor_state(&state)?;
        if !st.is_current_open_request(open_request_id) {
            return Err(SUPERSEDED_IMAGE_LOAD_ERROR.into());
        }
        let mut response = st.replace_with_linear_image(
            opened.image.pixels.to_vec(),
            opened.image.width,
            opened.image.height,
            opened.info.bit_depth,
        );
        restore_persisted_layers(
            &mut st,
            file_hash.clone(),
            opened.source_name,
            persisted,
        )?;
        response.file_hash = Some(file_hash);
        response
    };
    Ok(response)
}

#[tauri::command]
pub async fn open_image_encoded_bytes(
    bytes: Vec<u8>,
    file_name: Option<String>,
    p2p: tauri::State<'_, crate::P2pState>,
    state: tauri::State<'_, Mutex<EditorState>>,
) -> Result<LayerInfoResponse, String> {
    let open_request_id = {
        let mut st = lock_editor_state(&state)?;
        st.begin_open_request()
    };
    let file_hash = hash_bytes(&bytes);
    if let Some(file_name) = file_name.as_deref() {
        register_image_source(&file_hash, Some(file_name)).await?;
    }
    if let Some(peer) = p2p.0.read().await.clone() {
        let _ = sync_snapshots_from_all_peers_for_file_hash(&peer, &file_hash).await;
    }
    let persisted = load_latest_edit_version(&file_hash).await?;
    let (image, info) = decode_image_bytes_with_info(&bytes, file_name.as_deref())?;
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
        restore_persisted_layers(&mut st, file_hash.clone(), file_name, persisted)?;
        response.file_hash = Some(file_hash);
        response
    };
    Ok(response)
}

/// Accept raw RGBA8 bytes decoded in the webview (file picker / drag-drop).
/// This avoids needing a file path — the JS side decodes the image via
/// `createImageBitmap` and passes the pixel buffer directly.
/// NOTE: pixels here are already decoded by the browser, which applies color management
/// and outputs sRGB-encoded values.
#[tauri::command]
pub async fn open_image_bytes(
    pixels: Vec<u8>,
    width: u32,
    height: u32,
    p2p: tauri::State<'_, crate::P2pState>,
    state: tauri::State<'_, Mutex<EditorState>>,
) -> Result<LayerInfoResponse, String> {
    let open_request_id = {
        let mut st = lock_editor_state(&state)?;
        st.begin_open_request()
    };
    if pixels.len() != (width * height * 4) as usize {
        return Err(format!(
            "pixel buffer size mismatch: expected {}, got {}",
            width * height * 4,
            pixels.len()
        ));
    }
    let file_hash = hash_bytes(&pixels);
    if let Some(peer) = p2p.0.read().await.clone() {
        let _ = sync_snapshots_from_all_peers_for_file_hash(&peer, &file_hash).await;
    }
    let persisted = load_latest_edit_version(&file_hash).await?;
    let response = {
        let mut st = lock_editor_state(&state)?;
        if !st.is_current_open_request(open_request_id) {
            return Err(SUPERSEDED_IMAGE_LOAD_ERROR.into());
        }
        let mut response = st.replace_with_image(
            pixels
                .into_iter()
                .map(|channel| channel as f32 / 255.0)
                .collect(),
            width,
            height,
            "8-bit".into(),
            shade_core::ColorSpace::Srgb,
        );
        restore_persisted_layers(&mut st, file_hash.clone(), None, persisted)?;
        response.file_hash = Some(file_hash);
        response
    };
    Ok(response)
}

#[derive(Serialize, Deserialize, Debug)]
pub struct PreviewFrameResponse {
    pub pixels: Vec<u8>,
    pub width: u32,
    pub height: u32,
}

#[derive(Serialize, Deserialize, Debug)]
pub struct PreviewFrameFloat16Response {
    pub pixels: Vec<u16>,
    pub width: u32,
    pub height: u32,
}

fn pack_preview_rgba_response(frame: PreviewFrameResponse) -> tauri::ipc::Response {
    let mut bytes = Vec::with_capacity(8 + frame.pixels.len());
    bytes.extend_from_slice(&frame.width.to_le_bytes());
    bytes.extend_from_slice(&frame.height.to_le_bytes());
    bytes.extend_from_slice(&frame.pixels);
    tauri::ipc::Response::new(bytes)
}

fn pack_preview_float16_response(
    frame: PreviewFrameFloat16Response,
) -> tauri::ipc::Response {
    let mut bytes = Vec::with_capacity(8 + frame.pixels.len() * 2);
    bytes.extend_from_slice(&frame.width.to_le_bytes());
    bytes.extend_from_slice(&frame.height.to_le_bytes());
    for word in frame.pixels {
        bytes.extend_from_slice(&word.to_le_bytes());
    }
    tauri::ipc::Response::new(bytes)
}

#[derive(Clone, Serialize, Deserialize, Debug)]
pub struct PreviewCrop {
    pub x: f32,
    pub y: f32,
    pub width: f32,
    pub height: f32,
}

#[derive(Clone, Serialize, Deserialize, Debug)]
pub struct PreviewRenderRequest {
    pub target_width: u32,
    pub target_height: u32,
    pub crop: Option<PreviewCrop>,
    pub ignore_crop_layers: Option<bool>,
}

fn snapshot_render_state(
    state: &tauri::State<'_, Mutex<EditorState>>,
) -> Result<
    (
        LayerStack,
        Arc<std::collections::HashMap<shade_core::TextureId, FloatImage>>,
        u32,
        u32,
    ),
    String,
> {
    let st = lock_editor_state(state)?;
    if st.canvas_width == 0 {
        return Err("no image loaded".to_string());
    }
    Ok((
        st.stack.clone(),
        st.image_sources.clone(),
        st.canvas_width,
        st.canvas_height,
    ))
}

fn apply_preview_request(
    mut stack: LayerStack,
    canvas_width: u32,
    canvas_height: u32,
    request: Option<PreviewRenderRequest>,
) -> (LayerStack, PreviewRenderRequest) {
    let request = request.unwrap_or(PreviewRenderRequest {
        target_width: canvas_width,
        target_height: canvas_height,
        crop: None,
        ignore_crop_layers: None,
    });
    if request.ignore_crop_layers.unwrap_or(false) {
        for entry in &mut stack.layers {
            if matches!(entry.layer, shade_core::Layer::Crop { .. }) {
                entry.visible = false;
            }
        }
    }
    (stack, request)
}

fn export_dimension(value: f32, axis: &str) -> Result<u32, String> {
    if !value.is_finite() {
        return Err(format!("crop {axis} must be finite"));
    }
    let rounded = value.round();
    if rounded < 1.0 || rounded > u32::MAX as f32 {
        return Err(format!("crop {axis} is out of range"));
    }
    Ok(rounded as u32)
}

fn export_render_request(
    stack: &LayerStack,
    canvas_width: u32,
    canvas_height: u32,
) -> Result<PreviewRenderRequest, String> {
    let crop = stack.layers.iter().find_map(|entry| {
        if !entry.visible {
            return None;
        }
        let shade_core::Layer::Crop { rect } = &entry.layer else {
            return None;
        };
        Some(PreviewCrop {
            x: rect.x,
            y: rect.y,
            width: rect.width,
            height: rect.height,
        })
    });
    let target_width = match &crop {
        Some(crop) => export_dimension(crop.width, "width")?,
        None => canvas_width,
    };
    let target_height = match &crop {
        Some(crop) => export_dimension(crop.height, "height")?,
        None => canvas_height,
    };
    Ok(PreviewRenderRequest {
        target_width,
        target_height,
        crop,
        ignore_crop_layers: None,
    })
}

fn thumbnail_render_request(
    stack: &LayerStack,
    canvas_width: u32,
    canvas_height: u32,
) -> Result<PreviewRenderRequest, String> {
    let request = export_render_request(stack, canvas_width, canvas_height)?;
    let longest_edge = request.target_width.max(request.target_height);
    if longest_edge <= 320 {
        return Ok(request);
    }
    Ok(PreviewRenderRequest {
        target_width: std::cmp::max(
            1,
            ((request.target_width as f64 * 320.0) / longest_edge as f64).round() as u32,
        ),
        target_height: std::cmp::max(
            1,
            ((request.target_height as f64 * 320.0) / longest_edge as f64).round() as u32,
        ),
        crop: request.crop,
        ignore_crop_layers: request.ignore_crop_layers,
    })
}

fn encode_jpeg_thumbnail(
    pixels: Vec<u8>,
    width: u32,
    height: u32,
) -> Result<Vec<u8>, String> {
    let image = image::RgbaImage::from_raw(width, height, pixels)
        .ok_or("failed to wrap rendered thumbnail pixels")?;
    let mut jpeg = Vec::new();
    image::DynamicImage::ImageRgba8(image)
        .write_to(
            &mut std::io::Cursor::new(&mut jpeg),
            image::ImageFormat::Jpeg,
        )
        .map_err(|error| error.to_string())?;
    Ok(jpeg)
}

async fn render_snapshot_thumbnail_bytes<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    picture_id: &str,
) -> Result<Option<(Vec<u8>, String)>, String> {
    if !has_snapshot_for_source(picture_id).await? {
        return Ok(None);
    }
    let photo_app = app.clone();
    let opened =
        shade_io::open_image(
            picture_id,
            |host, file_path| async move {
                load_camera_image_from_tauri(&host, &file_path).await
            },
            |s3_path| async move { load_s3_image_from_tauri(&s3_path).await },
            move |photo_id| {
                let app = photo_app.clone();
                async move { load_photo_image_from_tauri(&app, &photo_id).await }
            },
        )
        .await?;
    let Some(persisted) = load_latest_edit_version(&opened.file_hash).await? else {
        return Ok(None);
    };
    let image = FloatImage {
        pixels: opened.image.pixels.clone(),
        width: opened.image.width,
        height: opened.image.height,
    };
    let texture_id = texture_id_for_file_hash(&opened.file_hash)?;
    let canvas_width = image.width;
    let canvas_height = image.height;
    let stack =
        build_persisted_layer_stack(texture_id, canvas_width, canvas_height, &persisted)?;
    let request = thumbnail_render_request(&stack, canvas_width, canvas_height)?;
    let sources = Arc::new(std::collections::HashMap::from([(texture_id, image)]));
    let render_sender = app.state::<crate::ThumbnailService>().render_sender.clone();
    let (response_tx, response_rx) = tokio::sync::oneshot::channel();
    render_sender
        .send(ThumbnailRenderJob {
            stack,
            sources,
            canvas_width,
            canvas_height,
            request,
            response: response_tx,
        })
        .map_err(|e| e.to_string())?;
    let bytes = response_rx.await.map_err(|error| error.to_string())??;
    Ok(Some((bytes, opened.file_hash)))
}

/// Run the full GPU render pipeline and return raw RGBA8 pixels.
#[tauri::command]
pub async fn render_preview(
    request: Option<PreviewRenderRequest>,
    render_service: tauri::State<'_, crate::RenderService>,
    state: tauri::State<'_, Mutex<EditorState>>,
) -> Result<tauri::ipc::Response, String> {
    let (stack, sources, canvas_width, canvas_height) = snapshot_render_state(&state)?;
    let (stack, request) =
        apply_preview_request(stack, canvas_width, canvas_height, request);
    let (response_tx, response_rx) = tokio::sync::oneshot::channel();
    render_service
        .0
        .send(RenderJob::Preview {
            stack,
            sources,
            canvas_width,
            canvas_height,
            request,
            response: response_tx,
        })
        .map_err(|e| e.to_string())?;
    response_rx
        .await
        .map_err(|e| e.to_string())?
        .map(pack_preview_rgba_response)
}

#[tauri::command]
pub async fn render_preview_float16(
    request: Option<PreviewRenderRequest>,
    render_service: tauri::State<'_, crate::RenderService>,
    state: tauri::State<'_, Mutex<EditorState>>,
) -> Result<tauri::ipc::Response, String> {
    let (stack, sources, canvas_width, canvas_height) = {
        let st = lock_editor_state(&state)?;
        if st.canvas_width == 0 {
            return Err("no image loaded".to_string());
        }
        (
            st.stack.clone(),
            st.image_sources.clone(),
            st.canvas_width,
            st.canvas_height,
        )
    };
    let (stack, request) =
        apply_preview_request(stack, canvas_width, canvas_height, request);
    let (response_tx, response_rx) = tokio::sync::oneshot::channel();
    render_service
        .0
        .send(RenderJob::PreviewFloat16 {
            stack,
            sources,
            canvas_width,
            canvas_height,
            request,
            response: response_tx,
        })
        .map_err(|e| e.to_string())?;
    response_rx
        .await
        .map_err(|e| e.to_string())?
        .map(pack_preview_float16_response)
}

#[tauri::command]
pub async fn export_image(
    path: String,
    render_service: tauri::State<'_, crate::RenderService>,
    state: tauri::State<'_, Mutex<EditorState>>,
) -> Result<(), String> {
    let export_path = PathBuf::from(&path);
    let ext = export_path
        .extension()
        .and_then(|segment| segment.to_str())
        .map(|segment| segment.to_lowercase())
        .ok_or_else(|| "export path must end in .png, .jpg, or .jpeg".to_string())?;
    if ext != "png" && ext != "jpg" && ext != "jpeg" {
        return Err("export format must be png, jpg, or jpeg".into());
    }
    let (stack, sources, canvas_width, canvas_height) = snapshot_render_state(&state)?;
    let request = export_render_request(&stack, canvas_width, canvas_height)?;
    let export_width = request.target_width;
    let export_height = request.target_height;
    let (response_tx, response_rx) = tokio::sync::oneshot::channel();
    render_service
        .0
        .send(RenderJob::Export {
            stack,
            sources,
            canvas_width,
            canvas_height,
            request,
            response: response_tx,
        })
        .map_err(|e| e.to_string())?;
    let pixels = response_rx.await.map_err(|e| e.to_string())??;
    tokio::task::spawn_blocking(move || -> Result<(), String> {
        shade_io::save_image(&export_path, &pixels, export_width, export_height)
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())??;
    Ok(())
}

#[derive(Serialize, Deserialize, Debug)]
pub struct EditParams {
    pub layer_idx: usize,
    pub op: String, // "tone", "curves", "ls_curve", "color", "vignette", "sharpen", "grain"
    pub exposure: Option<f32>,
    pub contrast: Option<f32>,
    pub blacks: Option<f32>,
    pub whites: Option<f32>,
    pub highlights: Option<f32>,
    pub shadows: Option<f32>,
    pub gamma: Option<f32>,

    pub lut_r: Option<Vec<f32>>,
    pub lut_g: Option<Vec<f32>>,
    pub lut_b: Option<Vec<f32>>,
    pub lut_master: Option<Vec<f32>>,
    pub per_channel: Option<bool>,
    pub curve_points: Option<Vec<CurveControlPoint>>,
    pub saturation: Option<f32>,
    pub vibrancy: Option<f32>,
    pub temperature: Option<f32>,
    pub tint: Option<f32>,
    pub vignette_amount: Option<f32>,
    pub sharpen_amount: Option<f32>,
    pub grain_amount: Option<f32>,
    pub grain_size: Option<f32>,
    pub glow_amount: Option<f32>,
    pub red_hue: Option<f32>,
    pub red_sat: Option<f32>,
    pub red_lum: Option<f32>,
    pub green_hue: Option<f32>,
    pub green_sat: Option<f32>,
    pub green_lum: Option<f32>,
    pub blue_hue: Option<f32>,
    pub blue_sat: Option<f32>,
    pub blue_lum: Option<f32>,
    pub crop_x: Option<f32>,
    pub crop_y: Option<f32>,
    pub crop_width: Option<f32>,
    pub crop_height: Option<f32>,
    pub crop_rotation: Option<f32>,
    pub denoise_luma_strength: Option<f32>,
    pub denoise_chroma_strength: Option<f32>,
    pub denoise_mode: Option<u32>,
}

#[tauri::command]
pub async fn apply_edit(
    params: EditParams,
    state: tauri::State<'_, Mutex<EditorState>>,
) -> Result<(), String> {
    {
        let mut st = lock_editor_state(&state)?;
        let canvas_width = st.canvas_width;
        let canvas_height = st.canvas_height;
        if params.layer_idx >= st.stack.layers.len() {
            return Err("layer index out of bounds".into());
        }
        let layer = &mut st.stack.layers[params.layer_idx];
        match &mut layer.layer {
            shade_core::Layer::Crop { rect } => {
                if params.op != "crop" {
                    return Err("target layer is a crop layer".into());
                }
                *rect = normalize_crop_rect(
                    CropRect {
                        x: params.crop_x.ok_or("missing crop_x")?,
                        y: params.crop_y.ok_or("missing crop_y")?,
                        width: params.crop_width.ok_or("missing crop_width")?,
                        height: params.crop_height.ok_or("missing crop_height")?,
                        rotation: params.crop_rotation.unwrap_or(rect.rotation),
                    },
                    canvas_width,
                    canvas_height,
                )?;
                st.stack.generation += 1;
            }
            shade_core::Layer::Adjustment { ops } => {
                match params.op.as_str() {
                    "tone" => {
                        let next = AdjustmentOp::Tone {
                            exposure: params.exposure.unwrap_or(0.0),
                            contrast: params.contrast.unwrap_or(0.0),
                            blacks: params.blacks.unwrap_or(0.0),
                            whites: params.whites.unwrap_or(0.0),
                            highlights: params.highlights.unwrap_or(0.0),
                            shadows: params.shadows.unwrap_or(0.0),
                            gamma: params.gamma.unwrap_or(1.0),
                        };
                        if let Some(op) = ops
                            .iter_mut()
                            .find(|op| matches!(op, AdjustmentOp::Tone { .. }))
                        {
                            *op = next;
                        } else {
                            ops.push(next);
                        }
                    }
                    "color" => {
                        let next = AdjustmentOp::Color(ColorParams {
                            saturation: params.saturation.unwrap_or(1.0),
                            vibrancy: params.vibrancy.unwrap_or(0.0),
                            temperature: params.temperature.unwrap_or(0.0),
                            tint: params.tint.unwrap_or(0.0),
                        });
                        if let Some(op) = ops
                            .iter_mut()
                            .find(|op| matches!(op, AdjustmentOp::Color(_)))
                        {
                            *op = next;
                        } else {
                            ops.push(next);
                        }
                    }
                    "curves" => {
                        let curve_points =
                            params.curve_points.ok_or("missing curve_points")?;
                        let next = AdjustmentOp::Curves {
                            lut_r: linear_lut(),
                            lut_g: linear_lut(),
                            lut_b: linear_lut(),
                            lut_master: build_curve_lut_from_points(&curve_points),
                            per_channel: false,
                            control_points: Some(curve_points),
                        };
                        if let Some(op) = ops
                            .iter_mut()
                            .find(|op| matches!(op, AdjustmentOp::Curves { .. }))
                        {
                            *op = next;
                        } else {
                            ops.push(next);
                        }
                    }
                    "ls_curve" => {
                        let curve_points =
                            params.curve_points.ok_or("missing curve_points")?;
                        let next = AdjustmentOp::LsCurve {
                            lut: build_curve_lut_from_points(&curve_points),
                            control_points: Some(curve_points),
                        };
                        if let Some(op) = ops
                            .iter_mut()
                            .find(|op| matches!(op, AdjustmentOp::LsCurve { .. }))
                        {
                            *op = next;
                        } else {
                            ops.push(next);
                        }
                    }
                    "vignette" => {
                        let next = AdjustmentOp::Vignette(VignetteParams {
                            amount: params.vignette_amount.unwrap_or(0.0),
                            ..Default::default()
                        });
                        if let Some(op) = ops
                            .iter_mut()
                            .find(|op| matches!(op, AdjustmentOp::Vignette(_)))
                        {
                            *op = next;
                        } else {
                            ops.push(next);
                        }
                    }
                    "sharpen" => {
                        let next = AdjustmentOp::Sharpen(SharpenParams {
                            amount: params.sharpen_amount.unwrap_or(0.0),
                            threshold: 0.1,
                        });
                        if let Some(op) = ops
                            .iter_mut()
                            .find(|op| matches!(op, AdjustmentOp::Sharpen(_)))
                        {
                            *op = next;
                        } else {
                            ops.push(next);
                        }
                    }
                    "grain" => {
                        let existing = ops
                            .iter()
                            .find_map(|op| {
                                if let AdjustmentOp::Grain(p) = op {
                                    Some(*p)
                                } else {
                                    None
                                }
                            })
                            .unwrap_or_default();
                        let next = AdjustmentOp::Grain(GrainParams {
                            amount: params.grain_amount.unwrap_or(existing.amount),
                            size: params.grain_size.unwrap_or(existing.size),
                            ..existing
                        });
                        if let Some(op) = ops
                            .iter_mut()
                            .find(|op| matches!(op, AdjustmentOp::Grain(_)))
                        {
                            *op = next;
                        } else {
                            ops.push(next);
                        }
                    }
                    "glow" => {
                        let next = AdjustmentOp::Glow(GlowParams {
                            amount: params.glow_amount.unwrap_or(0.0),
                            ..GlowParams::default()
                        });
                        if let Some(op) = ops
                            .iter_mut()
                            .find(|op| matches!(op, AdjustmentOp::Glow(_)))
                        {
                            *op = next;
                        } else {
                            ops.push(next);
                        }
                    }
                    "hsl" => {
                        let next = AdjustmentOp::Hsl(HslParams {
                            red_hue: params.red_hue.unwrap_or(0.0),
                            red_sat: params.red_sat.unwrap_or(0.0),
                            red_lum: params.red_lum.unwrap_or(0.0),
                            green_hue: params.green_hue.unwrap_or(0.0),
                            green_sat: params.green_sat.unwrap_or(0.0),
                            green_lum: params.green_lum.unwrap_or(0.0),
                            blue_hue: params.blue_hue.unwrap_or(0.0),
                            blue_sat: params.blue_sat.unwrap_or(0.0),
                            blue_lum: params.blue_lum.unwrap_or(0.0),
                        });
                        if let Some(op) =
                            ops.iter_mut().find(|op| matches!(op, AdjustmentOp::Hsl(_)))
                        {
                            *op = next;
                        } else {
                            ops.push(next);
                        }
                    }
                    "denoise" => {
                        let next = AdjustmentOp::Denoise(DenoiseParams {
                            luma_strength: params.denoise_luma_strength.unwrap_or(0.0),
                            chroma_strength: params
                                .denoise_chroma_strength
                                .unwrap_or(0.0),
                            mode: params.denoise_mode.unwrap_or(0),
                            _pad: 0.0,
                        });
                        if let Some(op) = ops
                            .iter_mut()
                            .find(|op| matches!(op, AdjustmentOp::Denoise(_)))
                        {
                            *op = next;
                        } else {
                            ops.push(next);
                        }
                    }
                    _ => return Err(format!("unknown op: {}", params.op)),
                }
                st.stack.generation += 1;
            }
            _ => return Err("target layer is not editable by apply_edit".into()),
        }
    }
    persist_current_edit_version(&state).await?;
    Ok(())
}

#[tauri::command]
pub async fn add_layer(
    kind: String,
    state: tauri::State<'_, Mutex<EditorState>>,
) -> Result<usize, String> {
    let idx = {
        let mut st = lock_editor_state(&state)?;
        let canvas_width = st.canvas_width;
        let canvas_height = st.canvas_height;
        match kind.as_str() {
            "adjustment" => st.stack.add_adjustment_layer(vec![AdjustmentOp::Tone {
                exposure: 0.0,
                contrast: 0.0,
                blacks: 0.0,
                whites: 0.0,
                highlights: 0.0,
                shadows: 0.0,
                gamma: 1.0,
            }]),
            "curves" => st.stack.add_adjustment_layer(vec![AdjustmentOp::Curves {
                lut_r: linear_lut(),
                lut_g: linear_lut(),
                lut_b: linear_lut(),
                lut_master: linear_lut(),
                per_channel: false,
                control_points: None,
            }]),
            "ls_curve" => st.stack.add_adjustment_layer(vec![AdjustmentOp::LsCurve {
                lut: linear_lut(),
                control_points: None,
            }]),
            "crop" => st.stack.add_crop_layer(CropRect {
                x: 0.0,
                y: 0.0,
                width: canvas_width as f32,
                height: canvas_height as f32,
                rotation: 0.0,
            }),
            _ => return Err(format!("unknown layer kind: {kind}")),
        }
    };
    persist_current_edit_version(&state).await?;
    Ok(idx)
}

#[derive(Serialize, Deserialize, Debug)]
pub struct LayerVisibility {
    pub layer_idx: usize,
    pub visible: bool,
}

#[tauri::command]
pub async fn set_layer_visible(
    params: LayerVisibility,
    state: tauri::State<'_, Mutex<EditorState>>,
) -> Result<(), String> {
    {
        let mut st = lock_editor_state(&state)?;
        if params.layer_idx >= st.stack.layers.len() {
            return Err("index out of bounds".into());
        }
        st.stack.layers[params.layer_idx].visible = params.visible;
        st.stack.generation += 1;
    }
    persist_current_edit_version(&state).await?;
    Ok(())
}

#[derive(Serialize, Deserialize, Debug)]
pub struct LayerOpacityParams {
    pub layer_idx: usize,
    pub opacity: f32,
}

#[derive(Serialize, Deserialize, Debug)]
pub struct RenameLayerParams {
    pub layer_idx: usize,
    pub name: Option<String>,
}

#[tauri::command]
pub async fn set_layer_opacity(
    params: LayerOpacityParams,
    state: tauri::State<'_, Mutex<EditorState>>,
) -> Result<(), String> {
    {
        let mut st = lock_editor_state(&state)?;
        if params.layer_idx >= st.stack.layers.len() {
            return Err("index out of bounds".into());
        }
        st.stack.layers[params.layer_idx].opacity = params.opacity.clamp(0.0, 1.0);
        st.stack.generation += 1;
    }
    persist_current_edit_version(&state).await?;
    Ok(())
}

#[tauri::command]
pub async fn rename_layer(
    params: RenameLayerParams,
    state: tauri::State<'_, Mutex<EditorState>>,
) -> Result<(), String> {
    {
        let mut st = lock_editor_state(&state)?;
        if params.layer_idx >= st.stack.layers.len() {
            return Err("index out of bounds".into());
        }
        st.stack.layers[params.layer_idx].name = params
            .name
            .as_ref()
            .map(|name| name.trim().to_string())
            .filter(|name| !name.is_empty());
        st.stack.generation += 1;
    }
    persist_current_edit_version(&state).await?;
    Ok(())
}

#[derive(Serialize, Deserialize, Debug)]
pub struct DeleteLayerParams {
    pub layer_idx: usize,
}

#[tauri::command]
pub async fn delete_layer(
    params: DeleteLayerParams,
    state: tauri::State<'_, Mutex<EditorState>>,
) -> Result<(), String> {
    {
        let mut st = lock_editor_state(&state)?;
        if params.layer_idx >= st.stack.layers.len() {
            return Err("index out of bounds".into());
        }
        if let Some(mask_id) = st.stack.layers[params.layer_idx].mask {
            st.stack.masks.remove(&mask_id);
        }
        st.stack.layers.remove(params.layer_idx);
        st.stack.generation += 1;
    }
    persist_current_edit_version(&state).await?;
    Ok(())
}

#[derive(Serialize, Deserialize, Debug)]
pub struct MoveLayerParams {
    pub from_idx: usize,
    pub to_idx: usize,
}

#[tauri::command]
pub async fn move_layer(
    params: MoveLayerParams,
    state: tauri::State<'_, Mutex<EditorState>>,
) -> Result<usize, String> {
    let new_idx = {
        let mut st = lock_editor_state(&state)?;
        let len = st.stack.layers.len();
        if params.from_idx >= len {
            return Err("source index out of bounds".into());
        }
        if params.to_idx > len {
            return Err("target index out of bounds".into());
        }
        if params.to_idx == params.from_idx || params.to_idx == params.from_idx + 1 {
            return Ok(params.from_idx);
        }
        let entry = st.stack.layers.remove(params.from_idx);
        let insert_idx = if params.to_idx > params.from_idx {
            params.to_idx - 1
        } else {
            params.to_idx
        };
        st.stack.layers.insert(insert_idx, entry);
        st.stack.generation += 1;
        insert_idx
    };
    persist_current_edit_version(&state).await?;
    Ok(new_idx)
}

#[derive(Serialize, Deserialize, Debug)]
pub struct LayerStackInfo {
    pub layers: Vec<LayerEntryInfo>,
    pub canvas_width: u32,
    pub canvas_height: u32,
    pub generation: u64,
}

#[derive(Serialize, Deserialize, Debug)]
pub struct MaskParamsInfo {
    pub kind: String,
    // linear
    pub x1: Option<f32>,
    pub y1: Option<f32>,
    pub x2: Option<f32>,
    pub y2: Option<f32>,
    // radial
    pub cx: Option<f32>,
    pub cy: Option<f32>,
    pub radius: Option<f32>,
}

impl From<&MaskParams> for MaskParamsInfo {
    fn from(p: &MaskParams) -> Self {
        match p {
            MaskParams::Linear { x1, y1, x2, y2 } => MaskParamsInfo {
                kind: "linear".into(),
                x1: Some(*x1),
                y1: Some(*y1),
                x2: Some(*x2),
                y2: Some(*y2),
                cx: None,
                cy: None,
                radius: None,
            },
            MaskParams::Radial { cx, cy, radius } => MaskParamsInfo {
                kind: "radial".into(),
                x1: None,
                y1: None,
                x2: None,
                y2: None,
                cx: Some(*cx),
                cy: Some(*cy),
                radius: Some(*radius),
            },
            MaskParams::Brush { .. } => MaskParamsInfo {
                kind: "brush".into(),
                x1: None,
                y1: None,
                x2: None,
                y2: None,
                cx: None,
                cy: None,
                radius: None,
            },
        }
    }
}

#[derive(Serialize, Deserialize, Debug)]
pub struct LayerEntryInfo {
    pub kind: String,
    pub name: Option<String>,
    pub visible: bool,
    pub opacity: f32,
    pub blend_mode: String,
    pub has_mask: bool,
    pub mask_params: Option<MaskParamsInfo>,
    pub adjustments: Option<AdjustmentValues>,
    pub crop: Option<CropValues>,
}

#[derive(Serialize, Deserialize, Debug)]
pub struct CropValues {
    pub x: f32,
    pub y: f32,
    pub width: f32,
    pub height: f32,
    pub rotation: f32,
}

#[derive(Serialize, Deserialize, Debug, Default)]
pub struct AdjustmentValues {
    pub tone: Option<ToneValues>,
    pub curves: Option<CurvesValues>,
    pub ls_curve: Option<LsCurveValues>,
    pub color: Option<ColorValues>,
    pub vignette: Option<VignetteValues>,
    pub sharpen: Option<SharpenValues>,
    pub grain: Option<GrainValues>,
    pub glow: Option<GlowValues>,
    pub hsl: Option<HslValues>,
    pub denoise: Option<DenoiseValues>,
}

#[derive(Serialize, Deserialize, Debug)]
pub struct DenoiseValues {
    pub luma_strength: f32,
    pub chroma_strength: f32,
    pub mode: u32,
}

#[derive(Serialize, Deserialize, Debug)]
pub struct ToneValues {
    pub exposure: f32,
    pub contrast: f32,
    pub blacks: f32,
    pub whites: f32,
    pub highlights: f32,
    pub shadows: f32,
    pub gamma: f32,
}

#[derive(Serialize, Deserialize, Debug)]
pub struct CurvesValues {
    pub lut_r: Vec<f32>,
    pub lut_g: Vec<f32>,
    pub lut_b: Vec<f32>,
    pub lut_master: Vec<f32>,
    pub per_channel: bool,
    pub control_points: Option<Vec<CurveControlPoint>>,
}

#[derive(Serialize, Deserialize, Debug)]
pub struct LsCurveValues {
    pub lut: Vec<f32>,
    pub control_points: Option<Vec<CurveControlPoint>>,
}

#[derive(Serialize, Deserialize, Debug)]
pub struct ColorValues {
    pub saturation: f32,
    pub temperature: f32,
    pub tint: f32,
}

#[derive(Serialize, Deserialize, Debug)]
pub struct VignetteValues {
    pub amount: f32,
}

#[derive(Serialize, Deserialize, Debug)]
pub struct SharpenValues {
    pub amount: f32,
}

#[derive(Serialize, Deserialize, Debug)]
pub struct GrainValues {
    pub amount: f32,
    pub size: f32,
}

#[derive(Serialize, Deserialize, Debug)]
pub struct GlowValues {
    pub amount: f32,
}

#[derive(Serialize, Deserialize, Debug)]
pub struct HslValues {
    pub red_hue: f32,
    pub red_sat: f32,
    pub red_lum: f32,
    pub green_hue: f32,
    pub green_sat: f32,
    pub green_lum: f32,
    pub blue_hue: f32,
    pub blue_sat: f32,
    pub blue_lum: f32,
}

#[tauri::command]
pub async fn get_thumbnail<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    _thumbnail_service: tauri::State<'_, crate::ThumbnailService>,
    path: String,
) -> Result<Vec<u8>, String> {
    load_thumbnail_bytes(app, &path).await
}

pub async fn load_thumbnail_bytes<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    picture_id: &str,
) -> Result<Vec<u8>, String> {
    // The picture_id may contain a #modified_at or #snapshot:<id> suffix for cache busting.
    // Strip it for the actual load path, keep the original for the cache key.
    let load_path = picture_id.split_once('#').map_or(picture_id, |(p, _)| p);
    let cache = app.state::<crate::ThumbnailCacheDb>();
    let cache_key = crate::thumbnail_cache::thumbnail_cache_key(picture_id);
    if let Ok(Some((cached_file_hash, cached_bytes))) = cache.0.get(&cache_key).await {
        if let Some(file_hash) = cached_file_hash.as_deref() {
            register_image_source(file_hash, Some(load_path)).await?;
            return Ok(cached_bytes);
        }
        let is_local_path =
            !load_path.starts_with("ccapi://") && !load_path.starts_with("s3://");
        if !is_local_path {
            return Ok(cached_bytes);
        }
    }
    if let Some((bytes, file_hash)) = render_snapshot_thumbnail_bytes(&app, load_path).await? {
        register_image_source(&file_hash, Some(load_path)).await?;
        cache.0.put(&cache_key, Some(&file_hash), &bytes).await?;
        return Ok(bytes);
    }
    let thumbnail_queue = app.state::<crate::ThumbnailService>().raw_queue.clone();
    let thumbnail = shade_io::load_thumbnail_bytes(
        load_path,
        thumbnail_queue.as_ref(),
        {
            let app = app.clone();
            move |host, file_path| {
                let app = app.clone();
                async move { load_camera_thumbnail_from_tauri(&app, &host, &file_path).await }
            }
        },
        |s3_path| async move { load_s3_thumbnail_from_tauri(&s3_path).await },
        {
            let app = app.clone();
            move |picture_id| {
                let app = app.clone();
                async move { load_photo_thumbnail_from_tauri(&app, &picture_id).await }
            }
        },
    )
    .await?;
    if let Some(file_hash) = thumbnail.file_hash.as_deref() {
        register_image_source(file_hash, Some(load_path)).await?;
    }
    cache
        .0
        .put(&cache_key, thumbnail.file_hash.as_deref(), &thumbnail.bytes)
        .await?;
    #[cfg(not(any(target_os = "ios", target_os = "android")))]
    if let Some(file_hash) = thumbnail.file_hash.clone() {
        import_xmp_rating(picture_id, &file_hash).await;
        crate::tagging_worker::enqueue_thumbnail_for_tagging(
            &app,
            crate::thumbnail_cache::ThumbnailCacheEntry {
                picture_id: cache_key,
                file_hash,
                data: thumbnail.bytes.clone(),
            },
        )?;
    }
    Ok(thumbnail.bytes)
}

pub async fn load_picture_bytes<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    picture_id: &str,
) -> Result<Vec<u8>, String> {
    shade_io::load_picture_bytes(
        picture_id,
        |host, file_path| async move { load_camera_image_from_tauri(&host, &file_path).await },
        |s3_path| async move { load_s3_image_from_tauri(&s3_path).await },
        {
            let app = app.clone();
            move |picture_id| {
                let app = app.clone();
                async move { load_photo_image_from_tauri(&app, &picture_id).await }
            }
        },
    )
    .await
}

#[tauri::command]
pub async fn list_pictures<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
) -> Result<Vec<String>, String> {
    Ok(load_picture_entries(app)
        .await?
        .into_iter()
        .map(|picture| picture.id)
        .collect())
}

pub async fn load_picture_entries<R: tauri::Runtime>(
    _app: tauri::AppHandle<R>,
) -> Result<Vec<shade_p2p::SharedPicture>, String> {
    #[cfg(target_os = "android")]
    {
        let mut pictures = _app
            .state::<crate::photos::PhotosHandle<R>>()
            .list_photos()
            .await
            .map(|pictures| {
                pictures
                    .into_iter()
                    .map(|photo| shade_p2p::SharedPicture {
                        name: picture_display_name(&photo.uri),
                        id: photo.uri,
                        modified_at: photo.modified_at,
                    })
                    .collect::<Vec<_>>()
            })?;
        return Ok(pictures);
    }

    #[cfg(target_os = "ios")]
    {
        let mut pictures = tokio::task::spawn_blocking(|| {
            let ptr = unsafe { ios_list_photos() };
            if ptr.is_null() {
                return Ok::<Vec<shade_p2p::SharedPicture>, String>(vec![]);
            }
            let json = unsafe {
                let s = std::ffi::CStr::from_ptr(ptr).to_string_lossy().into_owned();
                ios_free_string(ptr);
                s
            };
            serde_json::from_str::<Vec<IosPhotoEntry>>(&json)
                .map(|pictures| {
                    pictures
                        .into_iter()
                        .map(|photo| shade_p2p::SharedPicture {
                            name: picture_display_name(&photo.id),
                            id: photo.id,
                            modified_at: photo.modified_at,
                        })
                        .collect::<Vec<_>>()
                })
                .map_err(|e| e.to_string())
        })
        .await
        .map_err(|e| e.to_string())??;
        return Ok(pictures);
    }

    #[cfg(not(any(target_os = "ios", target_os = "android")))]
    {
        let pictures = collect_images_in_directory(&default_pictures_dir()?)?
            .into_iter()
            .map(|picture| shade_p2p::SharedPicture {
                name: picture.name,
                id: picture.path,
                modified_at: picture.modified_at,
            })
            .collect::<Vec<_>>();
        Ok(pictures)
    }
}

#[tauri::command]
pub async fn list_media_libraries<R: tauri::Runtime>(
    _app: tauri::AppHandle<R>,
) -> Result<Vec<MediaLibrary>, String> {
    #[cfg(target_os = "android")]
    {
        let mut libraries = vec![MediaLibrary {
            id: "photos".into(),
            name: "Photos".into(),
            kind: "directory".into(),
            path: None,
            removable: false,
            readonly: true,
            is_online: None,
            is_refreshing: None,
            mode: "browse".into(),
            sync_target: None,
        }];
        let mut config = load_app_config()?;
        let discovered_peers = discovered_peers_by_endpoint(&_app).await;
        if sync_persisted_peer_names(&mut config, &discovered_peers) {
            save_app_config(&config)?;
        }
        for library in &config.libraries {
            if let shade_io::LibraryConfig::Peer(config) = library {
                let discovered = discovered_peers.get(&config.peer_id);
                libraries.push(peer_library_for_endpoint(
                    &config.peer_id,
                    discovered
                        .map(|peer| peer.name.as_str())
                        .or(config.name.as_deref())
                        .unwrap_or(config.peer_id.as_str()),
                    discovered.is_some(),
                ));
            }
        }
        return Ok(ordered_library_entries(libraries, &config.library_order));
    }

    #[cfg(target_os = "ios")]
    {
        let mut libraries = vec![MediaLibrary {
            id: "photos".into(),
            name: "Photos".into(),
            kind: "directory".into(),
            path: None,
            removable: false,
            readonly: true,
            is_online: None,
            is_refreshing: None,
            mode: "browse".into(),
            sync_target: None,
        }];
        let mut config = load_app_config()?;
        let discovered_peers = discovered_peers_by_endpoint(&_app).await;
        if sync_persisted_peer_names(&mut config, &discovered_peers) {
            save_app_config(&config)?;
        }
        for library in &config.libraries {
            if let shade_io::LibraryConfig::Peer(config) = library {
                let discovered = discovered_peers.get(&config.peer_id);
                libraries.push(peer_library_for_endpoint(
                    &config.peer_id,
                    discovered
                        .map(|peer| peer.name.as_str())
                        .or(config.name.as_deref())
                        .unwrap_or(config.peer_id.as_str()),
                    discovered.is_some(),
                ));
            }
        }
        return Ok(ordered_library_entries(libraries, &config.library_order));
    }

    #[cfg(not(any(target_os = "ios", target_os = "android")))]
    {
        list_desktop_media_libraries(&_app).await
    }
}

async fn enrich_listing_metadata(
    listing: &mut LibraryImageListing,
) -> Result<(), String> {
    let mut snapshot_ids: HashMap<String, String> = HashMap::new();
    let mut file_hashes_by_source: HashMap<String, String> = HashMap::new();
    {
        let conn = library_db_conn().await;
        let mut rows = conn
            .query(
                "SELECT i.source_name, i.file_hash, ev.id
                 FROM images i
                 JOIN edit_versions ev ON ev.file_hash = i.file_hash
                 WHERE i.source_name IS NOT NULL
                 AND ev.created_at = (
                     SELECT MAX(ev2.created_at)
                     FROM edit_versions ev2
                     WHERE ev2.file_hash = i.file_hash
                 )",
                (),
            )
            .await
            .map_err(|e| e.to_string())?;
        while let Some(row) = rows.next().await.map_err(|e| e.to_string())? {
            let source_name = row.get::<String>(0).map_err(|e| e.to_string())?;
            let file_hash = row.get::<String>(1).map_err(|e| e.to_string())?;
            let id = row.get::<String>(2).map_err(|e| e.to_string())?;
            file_hashes_by_source.insert(source_name.clone(), file_hash);
            snapshot_ids.insert(source_name, id);
        }
        if listing
            .items
            .iter()
            .any(|item| !file_hashes_by_source.contains_key(&item.path))
        {
            let mut hash_rows = conn
                .query(
                    "SELECT source_name, file_hash
                     FROM images
                     WHERE source_name IS NOT NULL",
                    (),
                )
                .await
                .map_err(|e| e.to_string())?;
            while let Some(row) = hash_rows.next().await.map_err(|e| e.to_string())? {
                let source_name = row.get::<String>(0).map_err(|e| e.to_string())?;
                let file_hash = row.get::<String>(1).map_err(|e| e.to_string())?;
                file_hashes_by_source
                    .entry(source_name)
                    .or_insert(file_hash);
            }
        }
    }
    let tags = load_media_tags_map(
        &listing
            .items
            .iter()
            .filter_map(|item| file_hashes_by_source.get(&item.path).cloned())
            .collect::<Vec<_>>(),
    )
    .await?;
    for item in &mut listing.items {
        item.file_hash = file_hashes_by_source.get(&item.path).cloned();
        item.metadata.latest_snapshot_id = snapshot_ids.get(&item.path).cloned();
        item.metadata.has_snapshots = item.metadata.latest_snapshot_id.is_some();
        item.metadata.tags = item
            .file_hash
            .as_ref()
            .and_then(|file_hash| tags.get(file_hash))
            .cloned()
            .unwrap_or_default();
    }
    Ok(())
}

#[tauri::command]
pub async fn list_library_images<R: tauri::Runtime>(
    _app: tauri::AppHandle<R>,
    library_id: String,
) -> Result<LibraryImageListing, String> {
    let mut listing = build_library_listing(&_app, library_id).await?;
    enrich_listing_metadata(&mut listing).await?;
    Ok(listing)
}

#[tauri::command]
pub async fn list_media_ratings(
    file_hashes: Vec<String>,
) -> Result<HashMap<String, u8>, String> {
    load_media_ratings_map(&file_hashes).await
}

#[tauri::command]
pub async fn set_media_rating(params: MediaRatingParams) -> Result<(), String> {
    if params.file_hash.trim().is_empty() {
        return Err("file hash cannot be empty".to_string());
    }
    persist_media_rating(&params.file_hash, params.rating).await
}

#[tauri::command]
pub async fn set_media_tags(params: MediaTagsParams) -> Result<(), String> {
    if params.file_hash.trim().is_empty() {
        return Err("file hash cannot be empty".to_string());
    }
    persist_media_tags(&params.file_hash, &params.tags).await
}

async fn build_library_listing<R: tauri::Runtime>(
    _app: &tauri::AppHandle<R>,
    library_id: String,
) -> Result<LibraryImageListing, String> {
    #[cfg(target_os = "android")]
    {
        if library_id != "photos" {
            return Err(format!("unknown media library: {library_id}"));
        }
        return _app
            .state::<crate::photos::PhotosHandle<R>>()
            .list_photos()
            .await
            .map(|photos| LibraryImageListing {
                items: photos
                    .into_iter()
                    .map(|photo| LibraryImage {
                        name: picture_display_name(&photo.uri),
                        path: photo.uri,
                        modified_at: photo.modified_at,
                        file_hash: None,
                        metadata: Default::default(),
                    })
                    .collect(),
                is_complete: true,
            });
    }

    #[cfg(target_os = "ios")]
    {
        if library_id != "photos" {
            return Err(format!("unknown media library: {library_id}"));
        }
        return tokio::task::spawn_blocking(|| {
            let ptr = unsafe { ios_list_photos() };
            if ptr.is_null() {
                return Ok(LibraryImageListing {
                    items: vec![],
                    is_complete: true,
                });
            }
            let json = unsafe {
                let s = std::ffi::CStr::from_ptr(ptr).to_string_lossy().into_owned();
                ios_free_string(ptr);
                s
            };
            serde_json::from_str::<Vec<IosPhotoEntry>>(&json)
                .map(|photos| LibraryImageListing {
                    items: photos
                        .into_iter()
                        .map(|photo| LibraryImage {
                            name: picture_display_name(&photo.id),
                            path: photo.id,
                            modified_at: photo.modified_at,
                            file_hash: None,
                            metadata: Default::default(),
                        })
                        .collect(),
                    is_complete: true,
                })
                .map_err(|e| e.to_string())
        })
        .await
        .map_err(|e| e.to_string())?;
    }

    #[cfg(not(any(target_os = "ios", target_os = "android")))]
    {
        if library_id.starts_with("ccapi:") {
            return list_ccapi_library_images(&resolve_ccapi_library_host(&library_id)?)
                .await;
        }
        if library_id.starts_with("s3:") {
            return list_s3_library_images(
                _app,
                &resolve_s3_library_config(&library_id)?,
            )
            .await;
        }
        let library_path =
            require_local_library_path(resolve_desktop_library_path(&library_id)?)?;
        let snapshot = _app
            .state::<crate::LibraryScanService>()
            .0
            .snapshot_for_library(&library_id, library_path)
            .await?;
        Ok(LibraryImageListing {
            items: snapshot
                .items
                .into_iter()
                .map(local_library_image)
                .collect(),
            is_complete: snapshot.is_complete,
        })
    }
}

#[tauri::command]
pub async fn refresh_library_index<R: tauri::Runtime>(
    _app: tauri::AppHandle<R>,
    library_id: String,
) -> Result<(), String> {
    #[cfg(any(target_os = "ios", target_os = "android"))]
    {
        let _ = _app;
        return Err(format!(
            "library indexing is not supported on this platform: {library_id}"
        ));
    }

    #[cfg(not(any(target_os = "ios", target_os = "android")))]
    {
        if library_id.starts_with("ccapi:") {
            return Err(format!(
                "library indexing is not supported for camera libraries: {library_id}"
            ));
        }
        if library_id.starts_with("s3:") {
            _app.state::<crate::S3LibraryScanService>()
                .0
                .refresh_library(
                    &resolve_s3_library_config(&library_id)?,
                )
                .await?;
            crate::tagging_worker::enqueue_existing_thumbnails_for_tagging(&_app).await?;
            return Ok(());
        }
        let library_path =
            require_local_library_path(resolve_desktop_library_path(&library_id)?)?;
        _app.state::<crate::LibraryScanService>()
            .0
            .refresh_library(&library_id, library_path)
            .await?;
        crate::tagging_worker::enqueue_existing_thumbnails_for_tagging(&_app).await?;
        Ok(())
    }
}

#[tauri::command]
pub async fn add_media_library<R: tauri::Runtime>(
    _app: tauri::AppHandle<R>,
    path: String,
) -> Result<MediaLibrary, String> {
    let canonical = std::fs::canonicalize(Path::new(&path)).map_err(|e| e.to_string())?;
    if !canonical.is_dir() {
        return Err(format!("not a directory: {}", canonical.display()));
    }
    let mut config = load_app_config()?;
    let canonical_string = canonical
        .to_str()
        .ok_or_else(|| format!("non-utf8 path: {}", canonical.display()))?
        .to_string();
    shade_io::upsert_library_config(
        &mut config.libraries,
        shade_io::LibraryConfig::Local(shade_io::LocalLibraryConfig {
            path: canonical_string,
        }),
    );
    let library = library_for_directory(canonical.clone(), true);
    shade_io::append_library_order_id(&mut config.library_order, library.id.clone());
    save_app_config(&config)?;
    #[cfg(not(any(target_os = "ios", target_os = "android")))]
    {
        _app.state::<crate::LibraryScanService>()
            .0
            .refresh_library(&library.id, canonical)
            .await?;
    }
    Ok(library)
}

#[tauri::command]
pub async fn add_s3_media_library<R: tauri::Runtime>(
    _app: tauri::AppHandle<R>,
    params: shade_io::AddS3LibraryParams,
) -> Result<MediaLibrary, String> {
    let library = shade_io::normalize_s3_library_input(params)?;
    let mut config = load_app_config()?;
    let persisted_library = library_for_s3(&library);
    shade_io::upsert_library_config(
        &mut config.libraries,
        shade_io::LibraryConfig::S3(library.clone()),
    );
    shade_io::append_library_order_id(
        &mut config.library_order,
        persisted_library.id.clone(),
    );
    save_app_config(&config)?;
    #[cfg(not(any(target_os = "ios", target_os = "android")))]
    {
        _app.state::<crate::S3LibraryScanService>()
            .0
            .refresh_library(&library)
            .await?;
    }
    Ok(persisted_library)
}

#[tauri::command]
pub async fn upload_media_library_file<R: tauri::Runtime>(
    _app: tauri::AppHandle<R>,
    library_id: String,
    file_name: String,
    bytes: Vec<u8>,
    append_timestamp_on_conflict: bool,
) -> Result<(), String> {
    if bytes.is_empty() {
        return Err(format!("upload file is empty: {file_name}"));
    }
    let file_name = normalize_upload_file_name(&file_name)?;
    if !shade_io::is_supported_library_image(Path::new(&file_name)) {
        return Err(format!("unsupported image upload: {file_name}"));
    }
    #[cfg(any(target_os = "ios", target_os = "android"))]
    {
        let _ = _app;
        return Err(format!(
            "image uploads are not supported for media library: {library_id}"
        ));
    }

    #[cfg(not(any(target_os = "ios", target_os = "android")))]
    if library_id.starts_with("s3:") {
        let config = resolve_s3_library_config(&library_id)?;
        return shade_io::put_s3_object_bytes(
            &config,
            &s3_upload_object_key(&config, &file_name),
            &bytes,
        )
        .await;
    }

    #[cfg(not(any(target_os = "ios", target_os = "android")))]
    {
        let library_root =
            require_local_library_path(resolve_desktop_library_path(&library_id)?)?;
        let target_path = local_upload_target_path_with_conflict_policy(
            &library_root,
            &file_name,
            append_timestamp_on_conflict,
        )?;
        let mut file = std::fs::File::options()
            .create_new(true)
            .write(true)
            .open(&target_path)
            .map_err(|error| error.to_string())?;
        if let Err(error) = file.write_all(&bytes) {
            let _ = std::fs::remove_file(&target_path);
            return Err(error.to_string());
        }
        refresh_desktop_local_library(&_app, &library_id, library_root).await
    }
}

#[tauri::command]
pub async fn upload_media_library_path<R: tauri::Runtime>(
    _app: tauri::AppHandle<R>,
    library_id: String,
    path: String,
) -> Result<(), String> {
    let file_path = PathBuf::from(&path);
    if !file_path.is_file() {
        return Err(format!("upload path is not a file: {path}"));
    }
    if !shade_io::is_supported_library_image(&file_path) {
        return Err(format!("unsupported image upload: {path}"));
    }
    let file_name = file_path
        .file_name()
        .and_then(|segment| segment.to_str())
        .ok_or_else(|| format!("invalid upload path: {path}"))?;
    let bytes = std::fs::read(&file_path).map_err(|error| error.to_string())?;
    if bytes.is_empty() {
        return Err(format!("upload file is empty: {path}"));
    }
    #[cfg(any(target_os = "ios", target_os = "android"))]
    {
        let _ = _app;
        return Err(format!(
            "image uploads are not supported for media library: {library_id}"
        ));
    }

    #[cfg(not(any(target_os = "ios", target_os = "android")))]
    if library_id.starts_with("s3:") {
        let config = resolve_s3_library_config(&library_id)?;
        return shade_io::put_s3_object_bytes(
            &config,
            &s3_upload_object_key(&config, &normalize_upload_file_name(file_name)?),
            &bytes,
        )
        .await;
    }

    #[cfg(not(any(target_os = "ios", target_os = "android")))]
    {
        let library_root =
            require_local_library_path(resolve_desktop_library_path(&library_id)?)?;
        let target_path = local_upload_target_path(&library_root, file_name)?;
        std::fs::copy(&file_path, &target_path).map_err(|error| error.to_string())?;
        refresh_desktop_local_library(&_app, &library_id, library_root).await
    }
}

#[tauri::command]
pub async fn delete_media_library_item<R: tauri::Runtime>(
    _app: tauri::AppHandle<R>,
    path: String,
) -> Result<(), String> {
    if path.starts_with("s3://") {
        let (config, key) = resolve_s3_library_for_media_path(&path)?;
        return shade_io::delete_s3_object(&config, &key).await;
    }
    #[cfg(any(target_os = "ios", target_os = "android"))]
    {
        let _ = _app;
        return Err(format!(
            "media item deletion is not supported for path: {path}"
        ));
    }

    #[cfg(not(any(target_os = "ios", target_os = "android")))]
    {
        let (library_id, canonical_item_path) = resolve_local_library_item(&path)?;
        let library_root =
            require_local_library_path(resolve_desktop_library_path(&library_id)?)?;
        std::fs::remove_file(&canonical_item_path).map_err(|error| error.to_string())?;
        refresh_desktop_local_library(&_app, &library_id, library_root).await
    }
}

#[tauri::command]
pub async fn remove_media_library<R: tauri::Runtime>(
    _app: tauri::AppHandle<R>,
    id: String,
) -> Result<(), String> {
    if id == "pictures" || id == "photos" {
        return Err(format!("media library is not removable: {id}"));
    }
    let mut config = load_app_config()?;
    let removed = config
        .libraries
        .iter()
        .find(|library| shade_io::library_config_id(library) == id)
        .cloned();
    let Some(removed) = removed else {
        return Err(format!("unknown media library: {id}"));
    };
    config
        .libraries
        .retain(|library| shade_io::library_config_id(library) != id);
    shade_io::remove_library_order_id(&mut config.library_order, &id);
    save_app_config(&config)?;
    #[cfg(not(any(target_os = "ios", target_os = "android")))]
    {
        if matches!(
            removed,
            shade_io::LibraryConfig::Local(_) | shade_io::LibraryConfig::S3(_)
        ) {
            delete_persisted_library_index(library_index_db(), &id).await?;
        }
        if matches!(removed, shade_io::LibraryConfig::Local(_)) {
            _app.state::<crate::LibraryScanService>()
                .0
                .remove_library(&id)?;
        }
        if matches!(removed, shade_io::LibraryConfig::S3(_)) {
            _app.state::<crate::S3LibraryScanService>()
                .0
                .remove_library(&id)?;
        }
    }
    Ok(())
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
        presets.push(PresetInfo {
            name: stem.to_string(),
        });
    }
    presets.sort_by(|a, b| a.name.cmp(&b.name));
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
    Ok(PresetInfo {
        name: name.trim().to_string(),
    })
}

#[tauri::command]
pub async fn rename_preset(
    old_name: String,
    new_name: String,
) -> Result<PresetInfo, String> {
    let old_path = preset_file_path(&old_name)?;
    let new_path = preset_file_path(&new_name)?;
    if old_path == new_path {
        return Ok(PresetInfo {
            name: new_name.trim().to_string(),
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
    })
}

#[tauri::command]
pub async fn load_preset(
    name: String,
    state: tauri::State<'_, Mutex<EditorState>>,
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
            .filter(|entry| matches!(entry.layer, shade_core::Layer::Image { .. }))
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
    persist_current_edit_version(&state).await?;
    Ok(())
}

#[derive(Serialize, Deserialize)]
struct StackSnapshot {
    layers: Vec<shade_core::LayerEntry>,
    mask_params: HashMap<shade_core::MaskId, shade_core::MaskParams>,
}

#[tauri::command]
pub fn get_stack_snapshot(
    state: tauri::State<'_, Mutex<EditorState>>,
) -> Result<String, String> {
    let st = lock_editor_state(&state)?;
    let non_image: Vec<_> = st
        .stack
        .layers
        .iter()
        .filter(|l| !matches!(l.layer, shade_core::Layer::Image { .. }))
        .cloned()
        .collect();
    let mut mp = HashMap::new();
    for layer in &non_image {
        if let Some(mask_id) = layer.mask {
            if let Some(params) = st.stack.mask_params.get(&mask_id) {
                mp.insert(mask_id, params.clone());
            }
        }
    }
    serde_json::to_string(&StackSnapshot {
        layers: non_image,
        mask_params: mp,
    })
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn replace_stack(
    layers_json: String,
    state: tauri::State<'_, Mutex<EditorState>>,
) -> Result<(), String> {
    let snap: StackSnapshot =
        serde_json::from_str(&layers_json).map_err(|e| e.to_string())?;
    let mut st = lock_editor_state(&state)?;
    let image_layers: Vec<_> = st
        .stack
        .layers
        .iter()
        .filter(|entry| matches!(entry.layer, shade_core::Layer::Image { .. }))
        .cloned()
        .collect();
    if image_layers.is_empty() {
        return Err("no image layers to preserve".into());
    }
    st.stack.layers = image_layers;
    st.stack.masks.clear();
    st.stack.mask_params.clear();
    let base_idx = st.stack.layers.len();
    st.stack.layers.extend(snap.layers);
    let w = st.canvas_width;
    let h = st.canvas_height;
    restore_masks_from_params(&mut st.stack, base_idx, &snap.mask_params, w, h);
    st.stack.generation += 1;
    Ok(())
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
    let (file_hash, current_snapshot_id) = {
        let st = lock_editor_state(&state)?;
        (
            st.current_image_hash.clone(),
            st.current_snapshot_id.clone(),
        )
    };
    let Some(file_hash) = file_hash else {
        return Ok(Vec::new());
    };
    list_snapshots_for_file(&file_hash, current_snapshot_id.as_deref()).await
}

#[tauri::command]
pub async fn load_snapshot(
    params: LoadSnapshotParams,
    state: tauri::State<'_, Mutex<EditorState>>,
) -> Result<(), String> {
    let file_hash = {
        let st = lock_editor_state(&state)?;
        st.current_image_hash
            .clone()
            .ok_or_else(|| "cannot load a snapshot without a loaded image".to_string())?
    };
    let snapshot = load_snapshot_by_id(&file_hash, &params.id).await?;
    {
        let mut st = lock_editor_state(&state)?;
        let image_layers: Vec<_> = st
            .stack
            .layers
            .iter()
            .filter(|entry| matches!(entry.layer, shade_core::Layer::Image { .. }))
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
    Ok(())
}

pub struct AppPeerProvider<R: tauri::Runtime = tauri::Wry> {
    app: tauri::AppHandle<R>,
    prompt_lock: Arc<TokioMutex<()>>,
    awareness: Arc<tokio::sync::Mutex<shade_p2p::AwarenessState>>,
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
        file_hash: &str,
    ) -> anyhow::Result<Vec<shade_p2p::SyncSnapshotInfo>> {
        let conn = library_db_conn().await;
        let mut rows = conn
            .query(
                "SELECT id, created_at FROM edit_versions WHERE file_hash = ?1 ORDER BY created_at DESC",
                [file_hash],
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
        file_hashes: &[String],
    ) -> anyhow::Result<Vec<shade_p2p::PictureMetadata>> {
        if file_hashes.is_empty() {
            return Ok(Vec::new());
        }
        let conn = library_db_conn().await;
        let mut result = Vec::new();
        for file_hash in file_hashes {
            let mut rating_rows = conn
                .query(
                    "SELECT rating, updated_at FROM media_ratings WHERE file_hash = ?1 LIMIT 1",
                    [file_hash.as_str()],
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
                    "SELECT tag, updated_at FROM media_tags WHERE file_hash = ?1",
                    [file_hash.as_str()],
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
                file_hash: file_hash.clone(),
                rating,
                tags,
                rating_updated_at,
                tags_updated_at,
            });
        }
        Ok(result)
    }
}

#[tauri::command]
pub async fn get_layer_stack(
    state: tauri::State<'_, Mutex<EditorState>>,
) -> Result<LayerStackInfo, String> {
    let st = lock_editor_state(&state)?;
    let layers = st
        .stack
        .layers
        .iter()
        .map(|l| LayerEntryInfo {
            kind: match &l.layer {
                shade_core::Layer::Image { .. } => "image".into(),
                shade_core::Layer::Crop { .. } => "crop".into(),
                shade_core::Layer::Adjustment { .. } => "adjustment".into(),
            },
            name: l.name.clone(),
            visible: l.visible,
            opacity: l.opacity,
            blend_mode: format!("{:?}", l.blend_mode),
            has_mask: l.mask.is_some(),
            mask_params: l
                .mask
                .and_then(|id| st.stack.mask_params.get(&id))
                .map(MaskParamsInfo::from),
            crop: match &l.layer {
                shade_core::Layer::Crop { rect } => Some(CropValues {
                    x: rect.x,
                    y: rect.y,
                    width: rect.width,
                    height: rect.height,
                    rotation: rect.rotation,
                }),
                _ => None,
            },
            adjustments: match &l.layer {
                shade_core::Layer::Image { .. } => None,
                shade_core::Layer::Crop { .. } => None,
                shade_core::Layer::Adjustment { ops } => {
                    let mut adjustments = AdjustmentValues::default();
                    for op in ops {
                        match op {
                            AdjustmentOp::Tone {
                                exposure,
                                contrast,
                                blacks,
                                whites,
                                highlights,
                                shadows,
                                gamma,
                            } => {
                                adjustments.tone = Some(ToneValues {
                                    exposure: *exposure,
                                    contrast: *contrast,
                                    blacks: *blacks,
                                    whites: *whites,
                                    highlights: *highlights,
                                    shadows: *shadows,
                                    gamma: *gamma,
                                });
                            }
                            AdjustmentOp::Color(params) => {
                                adjustments.color = Some(ColorValues {
                                    saturation: params.saturation,
                                    temperature: params.temperature,
                                    tint: params.tint,
                                });
                            }
                            AdjustmentOp::Curves {
                                lut_r,
                                lut_g,
                                lut_b,
                                lut_master,
                                per_channel,
                                control_points,
                            } => {
                                adjustments.curves = Some(CurvesValues {
                                    lut_r: lut_r.clone(),
                                    lut_g: lut_g.clone(),
                                    lut_b: lut_b.clone(),
                                    lut_master: lut_master.clone(),
                                    per_channel: *per_channel,
                                    control_points: control_points.clone(),
                                });
                            }
                            AdjustmentOp::LsCurve {
                                lut,
                                control_points,
                            } => {
                                adjustments.ls_curve = Some(LsCurveValues {
                                    lut: lut.clone(),
                                    control_points: control_points.clone(),
                                });
                            }
                            AdjustmentOp::Vignette(params) => {
                                adjustments.vignette = Some(VignetteValues {
                                    amount: params.amount,
                                });
                            }
                            AdjustmentOp::Sharpen(params) => {
                                adjustments.sharpen = Some(SharpenValues {
                                    amount: params.amount,
                                });
                            }
                            AdjustmentOp::Grain(params) => {
                                adjustments.grain = Some(GrainValues {
                                    amount: params.amount,
                                    size: params.size,
                                });
                            }
                            AdjustmentOp::Glow(params) => {
                                adjustments.glow = Some(GlowValues {
                                    amount: params.amount,
                                });
                            }
                            AdjustmentOp::Hsl(params) => {
                                adjustments.hsl = Some(HslValues {
                                    red_hue: params.red_hue,
                                    red_sat: params.red_sat,
                                    red_lum: params.red_lum,
                                    green_hue: params.green_hue,
                                    green_sat: params.green_sat,
                                    green_lum: params.green_lum,
                                    blue_hue: params.blue_hue,
                                    blue_sat: params.blue_sat,
                                    blue_lum: params.blue_lum,
                                });
                            }
                            AdjustmentOp::Denoise(params) => {
                                adjustments.denoise = Some(DenoiseValues {
                                    luma_strength: params.luma_strength,
                                    chroma_strength: params.chroma_strength,
                                    mode: params.mode,
                                });
                            }
                        }
                    }
                    Some(adjustments)
                }
            },
        })
        .collect();
    Ok(LayerStackInfo {
        layers,
        canvas_width: st.canvas_width,
        canvas_height: st.canvas_height,
        generation: st.stack.generation,
    })
}

#[derive(Serialize, Deserialize, Debug)]
pub struct GradientMaskParams {
    pub layer_idx: usize,
    pub kind: String,
    // linear: x1, y1, x2, y2
    pub x1: Option<f32>,
    pub y1: Option<f32>,
    pub x2: Option<f32>,
    pub y2: Option<f32>,
    // radial: cx, cy, radius
    pub cx: Option<f32>,
    pub cy: Option<f32>,
    pub radius: Option<f32>,
}

#[tauri::command]
pub async fn apply_gradient_mask(
    params: GradientMaskParams,
    state: tauri::State<'_, Mutex<EditorState>>,
) -> Result<(), String> {
    {
        let mut st = lock_editor_state(&state)?;
        if params.layer_idx >= st.stack.layers.len() {
            return Err("index out of bounds".into());
        }
        let w = st.canvas_width;
        let h = st.canvas_height;
        let mut mask = MaskData::new_empty(w, h);
        let mp = match params.kind.as_str() {
            "linear" => {
                let x1 = params.x1.ok_or("linear gradient requires x1")?;
                let y1 = params.y1.ok_or("linear gradient requires y1")?;
                let x2 = params.x2.ok_or("linear gradient requires x2")?;
                let y2 = params.y2.ok_or("linear gradient requires y2")?;
                mask.fill_linear_gradient(x1, y1, x2, y2);
                MaskParams::Linear { x1, y1, x2, y2 }
            }
            "radial" => {
                let cx = params.cx.ok_or("radial gradient requires cx")?;
                let cy = params.cy.ok_or("radial gradient requires cy")?;
                let radius = params.radius.ok_or("radial gradient requires radius")?;
                mask.fill_radial_gradient(cx, cy, radius);
                MaskParams::Radial { cx, cy, radius }
            }
            other => return Err(format!("unknown gradient kind: {other}")),
        };
        st.stack.set_mask_with_params(params.layer_idx, mask, mp);
    }
    persist_current_edit_version(&state).await?;
    Ok(())
}

#[derive(Serialize, Deserialize, Debug)]
pub struct RemoveMaskParams {
    pub layer_idx: usize,
}

#[tauri::command]
pub async fn remove_mask(
    params: RemoveMaskParams,
    state: tauri::State<'_, Mutex<EditorState>>,
) -> Result<(), String> {
    {
        let mut st = lock_editor_state(&state)?;
        if params.layer_idx >= st.stack.layers.len() {
            return Err("index out of bounds".into());
        }
        st.stack.remove_mask(params.layer_idx);
    }
    persist_current_edit_version(&state).await?;
    Ok(())
}

#[derive(Serialize, Deserialize, Debug)]
pub struct CreateBrushMaskParams {
    pub layer_idx: usize,
}

#[tauri::command]
pub async fn create_brush_mask(
    params: CreateBrushMaskParams,
    state: tauri::State<'_, Mutex<EditorState>>,
) -> Result<(), String> {
    {
        let mut st = lock_editor_state(&state)?;
        if params.layer_idx >= st.stack.layers.len() {
            return Err("index out of bounds".into());
        }
        let w = st.canvas_width;
        let h = st.canvas_height;
        let mask = shade_core::MaskData::new_empty(w, h);
        let mp = shade_core::MaskParams::Brush {
            width: w,
            height: h,
            pixels: vec![0u8; (w * h) as usize],
        };
        st.stack.set_mask_with_params(params.layer_idx, mask, mp);
    }
    persist_current_edit_version(&state).await?;
    Ok(())
}

#[derive(Serialize, Deserialize, Debug)]
pub struct StampBrushMaskParams {
    pub layer_idx: usize,
    pub cx: f32,
    pub cy: f32,
    pub radius: f32,
    pub softness: f32,
    pub erase: bool,
}

#[tauri::command]
pub async fn stamp_brush_mask(
    params: StampBrushMaskParams,
    state: tauri::State<'_, Mutex<EditorState>>,
) -> Result<(), String> {
    {
        let mut st = lock_editor_state(&state)?;
        if params.layer_idx >= st.stack.layers.len() {
            return Err("index out of bounds".into());
        }
        let mask_id = st.stack.layers[params.layer_idx]
            .mask
            .ok_or("layer has no mask")?;
        let data = st
            .stack
            .masks
            .get_mut(&mask_id)
            .ok_or("mask data missing")?;
        data.stamp_brush(
            params.cx,
            params.cy,
            params.radius,
            params.softness,
            params.erase,
        );
        st.stack.generation += 1;
    }
    Ok(())
}

#[derive(Serialize, Deserialize, Debug)]
pub struct GetMaskThumbnailParams {
    pub layer_idx: usize,
    pub max_w: u32,
    pub max_h: u32,
}

#[derive(Serialize, Deserialize, Debug)]
pub struct MaskThumbnail {
    pub pixels: Vec<u8>,
    pub width: u32,
    pub height: u32,
}

#[tauri::command]
pub async fn get_mask_thumbnail(
    params: GetMaskThumbnailParams,
    state: tauri::State<'_, Mutex<EditorState>>,
) -> Result<MaskThumbnail, String> {
    let st = lock_editor_state(&state)?;
    if params.layer_idx >= st.stack.layers.len() {
        return Err("index out of bounds".into());
    }
    let mask_id = st.stack.layers[params.layer_idx]
        .mask
        .ok_or("layer has no mask")?;
    let data = st.stack.masks.get(&mask_id).ok_or("mask data missing")?;
    let (pixels, width, height) = data.get_thumbnail(params.max_w, params.max_h);
    Ok(MaskThumbnail {
        pixels,
        width,
        height,
    })
}

fn normalize_crop_rect(
    rect: CropRect,
    canvas_width: u32,
    canvas_height: u32,
) -> Result<CropRect, String> {
    if canvas_width == 0 || canvas_height == 0 {
        return Err("cannot edit crop without a loaded image".into());
    }
    let max_width = canvas_width as f32;
    let max_height = canvas_height as f32;
    let width = rect.width.clamp(1.0, max_width);
    let height = rect.height.clamp(1.0, max_height);
    let x = rect.x.clamp(0.0, max_width - width);
    let y = rect.y.clamp(0.0, max_height - height);
    Ok(CropRect {
        x,
        y,
        width,
        height,
        rotation: rect.rotation,
    })
}

// ── Collections ──────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn list_collections(
    library_id: String,
) -> Result<Vec<shade_io::Collection>, String> {
    let conn = library_db_conn().await;
    shade_io::list_collections(&conn, &library_id).await
}

#[tauri::command]
pub async fn create_collection(
    library_id: String,
    name: String,
) -> Result<shade_io::Collection, String> {
    let conn = library_db_conn().await;
    shade_io::create_collection(&conn, &library_id, &name).await
}

#[tauri::command]
pub async fn rename_collection(
    collection_id: String,
    name: String,
) -> Result<(), String> {
    let conn = library_db_conn().await;
    shade_io::rename_collection(&conn, &collection_id, &name).await
}

#[tauri::command]
pub async fn delete_collection(collection_id: String) -> Result<(), String> {
    let conn = library_db_conn().await;
    shade_io::delete_collection(&conn, &collection_id).await
}

#[tauri::command]
pub async fn reorder_collection(
    collection_id: String,
    new_position: i64,
) -> Result<(), String> {
    let conn = library_db_conn().await;
    shade_io::reorder_collection(&conn, &collection_id, new_position).await
}

#[tauri::command]
pub async fn list_collection_items(
    collection_id: String,
) -> Result<Vec<shade_io::CollectionItem>, String> {
    let conn = library_db_conn().await;
    shade_io::list_collection_items(&conn, &collection_id).await
}

#[tauri::command]
pub async fn add_to_collection(
    collection_id: String,
    file_hashes: Vec<String>,
) -> Result<(), String> {
    let conn = library_db_conn().await;
    shade_io::add_collection_items(&conn, &collection_id, file_hashes).await
}

#[tauri::command]
pub async fn remove_from_collection(
    collection_id: String,
    file_hashes: Vec<String>,
) -> Result<(), String> {
    let conn = library_db_conn().await;
    shade_io::remove_collection_items(&conn, &collection_id, file_hashes).await
}

#[cfg(test)]
mod tests {
    use super::{export_render_request, normalize_media_tags};
    use shade_core::{CropRect, LayerStack};

    #[test]
    fn export_render_request_uses_canvas_when_crop_is_absent() {
        let mut stack = LayerStack::new();
        stack.add_adjustment_layer(vec![]);
        let request = export_render_request(&stack, 400, 300).expect("export request");
        assert_eq!(request.target_width, 400);
        assert_eq!(request.target_height, 300);
        assert!(request.crop.is_none());
    }

    #[test]
    fn export_render_request_uses_visible_crop_dimensions() {
        let mut stack = LayerStack::new();
        stack.add_crop_layer(CropRect {
            x: 10.0,
            y: 20.0,
            width: 123.0,
            height: 77.0,
            rotation: 0.25,
        });
        let request = export_render_request(&stack, 400, 300).expect("export request");
        let crop = request.crop.expect("crop request");
        assert_eq!(request.target_width, 123);
        assert_eq!(request.target_height, 77);
        assert_eq!(crop.x, 10.0);
        assert_eq!(crop.y, 20.0);
        assert_eq!(crop.width, 123.0);
        assert_eq!(crop.height, 77.0);
    }

    #[test]
    fn normalizes_media_tags() {
        assert_eq!(
            normalize_media_tags(&[
                " portrait ".to_string(),
                "".to_string(),
                "portrait".to_string(),
                "client".to_string(),
            ]),
            vec!["client".to_string(), "portrait".to_string()]
        );
    }
}
