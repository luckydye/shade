use serde::{Deserialize, Serialize};
use shade_core::{
    build_curve_lut_from_points, linear_lut, AdjustmentOp, ColorParams, CropRect,
    CurveControlPoint, FloatImage, GrainParams, HslParams, LayerStack, SharpenParams,
    VignetteParams,
};
use shade_io::SourceImageInfo;
use shade_io::{load_image_bytes_f32_with_info, load_image_f32_with_info, to_linear_srgb_f32};
use std::collections::{HashMap, VecDeque};
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::sync::{Arc, Condvar, Mutex};
use tauri::Manager;
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
    fn ios_get_image_data(identifier: *const std::os::raw::c_char, out_size: *mut i32) -> *mut u8;
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
    pub image_sources: std::collections::HashMap<shade_core::TextureId, FloatImage>,
    pub canvas_width: u32,
    pub canvas_height: u32,
    pub next_texture_id: u64,
    pub source_bit_depth: String,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct MediaLibrary {
    pub id: String,
    pub name: String,
    pub kind: String,
    pub path: Option<String>,
    pub removable: bool,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct LibraryImage {
    pub path: String,
    pub name: String,
    pub modified_at: Option<u64>,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct LibraryImageListing {
    pub items: Vec<LibraryImage>,
    pub is_complete: bool,
}

#[derive(Serialize, Deserialize, Debug, Default)]
#[serde(default)]
struct AppConfig {
    directories: Vec<String>,
    paired_peers: Vec<String>,
    p2p_secret_key: Option<[u8; 32]>,
}

const IMAGE_EXTENSIONS: &[&str] = &[
    "jpg", "jpeg", "png", "tiff", "tif", "webp", "avif", "exr", "dng", "cr2", "cr3", "arw", "nef",
    "orf", "raf", "rw2", "3fr",
];

static APP_CONFIG_DIR: OnceLock<PathBuf> = OnceLock::new();

pub fn init_app_paths<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Result<(), String> {
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
    .map_err(|payload| format!("image decode panicked: {}", panic_payload_message(payload)))?
    .map_err(|e| e.to_string())
}

fn decode_image_path_with_info(path: &Path) -> Result<(FloatImage, SourceImageInfo), String> {
    catch_unwind(AssertUnwindSafe(|| load_image_f32_with_info(path)))
        .map_err(|payload| format!("image decode panicked: {}", panic_payload_message(payload)))?
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

fn app_config_path() -> Result<PathBuf, String> {
    Ok(app_config_dir()?.join("config.json"))
}

fn presets_dir_path() -> Result<PathBuf, String> {
    Ok(app_config_dir()?.join("presets"))
}

fn app_config_dir() -> Result<PathBuf, String> {
    #[cfg(target_os = "android")]
    {
        return APP_CONFIG_DIR
            .get()
            .cloned()
            .ok_or_else(|| "app config path is not initialized".to_string());
    }

    #[cfg(not(target_os = "android"))]
    {
        let home = std::env::var("HOME").map_err(|_| "HOME is not set".to_string())?;
        Ok(PathBuf::from(home).join(".config/shade"))
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

#[derive(Serialize, Deserialize, Debug)]
struct PresetFile {
    version: u32,
    layers: Vec<shade_core::LayerEntry>,
}

#[derive(Serialize, Deserialize, Debug)]
pub struct PresetInfo {
    pub name: String,
}

fn load_app_config() -> Result<AppConfig, String> {
    let path = app_config_path()?;
    if !path.exists() {
        return Ok(AppConfig::default());
    }
    let json = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    serde_json::from_str(&json)
        .map_err(|e| format!("invalid app config at {}: {e}", path.display()))
}

fn save_app_config(config: &AppConfig) -> Result<(), String> {
    let path = app_config_path()?;
    let parent = path
        .parent()
        .ok_or_else(|| format!("invalid config path: {}", path.display()))?;
    std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let json = serde_json::to_string_pretty(config).map_err(|e| e.to_string())?;
    std::fs::write(&path, json).map_err(|e| e.to_string())
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
    Ok(load_app_config()?
        .paired_peers
        .iter()
        .any(|peer| peer == peer_endpoint_id))
}

fn pair_peer(peer_endpoint_id: &str) -> Result<(), String> {
    let mut config = load_app_config()?;
    if config
        .paired_peers
        .iter()
        .any(|peer| peer == peer_endpoint_id)
    {
        return Ok(());
    }
    config.paired_peers.push(peer_endpoint_id.to_owned());
    config.paired_peers.sort();
    save_app_config(&config)
}

fn default_pictures_dir() -> Result<PathBuf, String> {
    let home = std::env::var("HOME").map_err(|_| "HOME is not set".to_string())?;
    Ok(PathBuf::from(home).join("Pictures"))
}

fn custom_library_id(path: &Path) -> String {
    format!("dir:{}", path.display())
}

fn library_for_directory(path: PathBuf) -> MediaLibrary {
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
    }
}

fn list_desktop_media_libraries() -> Result<Vec<MediaLibrary>, String> {
    let pictures_dir = default_pictures_dir()?;
    let mut libraries = vec![MediaLibrary {
        id: "pictures".into(),
        name: "Pictures".into(),
        kind: "directory".into(),
        path: Some(pictures_dir.display().to_string()),
        removable: false,
    }];
    let config = load_app_config()?;
    for directory in config.directories {
        let path = PathBuf::from(directory);
        libraries.push(library_for_directory(path));
    }
    Ok(libraries)
}

fn resolve_desktop_library_path(library_id: &str) -> Result<PathBuf, String> {
    if library_id == "pictures" {
        return default_pictures_dir();
    }
    let config = load_app_config()?;
    for directory in config.directories {
        let path = PathBuf::from(&directory);
        if custom_library_id(&path) == library_id {
            return Ok(path);
        }
    }
    Err(format!("unknown media library: {library_id}"))
}

fn modified_at_millis(mtime: std::time::SystemTime) -> Result<u64, String> {
    let duration = mtime
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| e.to_string())?;
    u64::try_from(duration.as_millis()).map_err(|e| e.to_string())
}

fn collect_images_in_directory(dir: &Path) -> Result<Vec<LibraryImage>, String> {
    let mut entries_with_mtime: Vec<(std::time::SystemTime, LibraryImage)> = Vec::new();
    let mut dirs = vec![dir.to_path_buf()];
    while let Some(current_dir) = dirs.pop() {
        let entries = std::fs::read_dir(&current_dir).map_err(|e| e.to_string())?;
        for entry in entries {
            let entry = entry.map_err(|e| e.to_string())?;
            let path = entry.path();
            if path.is_dir() {
                dirs.push(path);
                continue;
            }
            if !path.is_file() {
                continue;
            }
            let Some(ext) = path.extension().and_then(|e| e.to_str()) else {
                continue;
            };
            if !IMAGE_EXTENSIONS.contains(&ext.to_lowercase().as_str()) {
                continue;
            }
            let path_string = path
                .to_str()
                .ok_or_else(|| format!("non-utf8 path: {}", path.display()))?
                .to_string();
            let mtime = path
                .metadata()
                .map_err(|e| e.to_string())?
                .modified()
                .map_err(|e| e.to_string())?;
            entries_with_mtime.push((
                mtime,
                LibraryImage {
                    name: picture_display_name(&path_string),
                    path: path_string,
                    modified_at: Some(modified_at_millis(mtime)?),
                },
            ));
        }
    }
    entries_with_mtime.sort_by(|a, b| b.0.cmp(&a.0));
    Ok(entries_with_mtime
        .into_iter()
        .map(|(_, entry)| entry)
        .collect())
}

pub struct LibraryScanEntry {
    pub modified_at: u64,
    pub image: LibraryImage,
}

pub struct LibraryScanSnapshot {
    pub items: Vec<LibraryScanEntry>,
    pub is_complete: bool,
    pub error: Option<String>,
    pub completed_at: Option<u64>,
}

pub struct LibraryScanService {
    pub scans: Mutex<HashMap<String, Arc<Mutex<LibraryScanSnapshot>>>>,
}

impl LibraryScanService {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            scans: Mutex::new(HashMap::new()),
        })
    }

    pub fn snapshot_for_library(
        &self,
        library_id: &str,
        root: PathBuf,
    ) -> Result<LibraryImageListing, String> {
        let snapshot = {
            let mut scans = self
                .scans
                .lock()
                .map_err(|_| "library scan lock poisoned".to_string())?;
            let should_restart = scans
                .get(library_id)
                .map(|snapshot| library_scan_should_restart(snapshot))
                .transpose()?
                .unwrap_or(true);
            if should_restart {
                let snapshot = Arc::new(Mutex::new(LibraryScanSnapshot {
                    items: Vec::new(),
                    is_complete: false,
                    error: None,
                    completed_at: None,
                }));
                scans.insert(library_id.to_string(), snapshot.clone());
                spawn_library_scan(snapshot.clone(), root);
                snapshot
            } else {
                scans
                    .get(library_id)
                    .expect("library scan snapshot must exist")
                    .clone()
            }
        };
        let snapshot = snapshot
            .lock()
            .map_err(|_| "library scan snapshot lock poisoned".to_string())?;
        if let Some(error) = &snapshot.error {
            return Err(error.clone());
        }
        Ok(LibraryImageListing {
            items: snapshot
                .items
                .iter()
                .map(|entry| entry.image.clone())
                .collect(),
            is_complete: snapshot.is_complete,
        })
    }
}

pub fn library_scan_should_restart(
    snapshot: &Arc<Mutex<LibraryScanSnapshot>>,
) -> Result<bool, String> {
    let snapshot = snapshot
        .lock()
        .map_err(|_| "library scan snapshot lock poisoned".to_string())?;
    if !snapshot.is_complete {
        return Ok(false);
    }
    let Some(completed_at) = snapshot.completed_at else {
        return Ok(true);
    };
    let now = modified_at_millis(std::time::SystemTime::now())?;
    Ok(now.saturating_sub(completed_at) > 5_000)
}

pub fn spawn_library_scan(snapshot: Arc<Mutex<LibraryScanSnapshot>>, root: PathBuf) {
    std::thread::Builder::new()
        .name("shade-library-scan".into())
        .spawn(move || {
            let result = scan_library_into_snapshot(&root, &snapshot);
            let mut guard = snapshot
                .lock()
                .expect("library scan snapshot lock poisoned");
            if let Err(error) = result {
                guard.error = Some(error);
            }
            guard.completed_at = Some(
                modified_at_millis(std::time::SystemTime::now())
                    .expect("current time must be valid"),
            );
            guard.is_complete = true;
        })
        .expect("failed to spawn library scan thread");
}

pub fn scan_library_into_snapshot(
    dir: &Path,
    snapshot: &Arc<Mutex<LibraryScanSnapshot>>,
) -> Result<(), String> {
    let mut dirs = vec![dir.to_path_buf()];
    let mut batch = Vec::new();
    while let Some(current_dir) = dirs.pop() {
        let entries = std::fs::read_dir(&current_dir).map_err(|e| e.to_string())?;
        for entry in entries {
            let entry = entry.map_err(|e| e.to_string())?;
            let path = entry.path();
            if path.is_dir() {
                dirs.push(path);
                continue;
            }
            if !path.is_file() {
                continue;
            }
            let Some(ext) = path.extension().and_then(|e| e.to_str()) else {
                continue;
            };
            if !IMAGE_EXTENSIONS.contains(&ext.to_lowercase().as_str()) {
                continue;
            }
            let path_string = path
                .to_str()
                .ok_or_else(|| format!("non-utf8 path: {}", path.display()))?
                .to_string();
            let modified_at = modified_at_millis(
                path.metadata()
                    .map_err(|e| e.to_string())?
                    .modified()
                    .map_err(|e| e.to_string())?,
            )?;
            batch.push(LibraryScanEntry {
                modified_at,
                image: LibraryImage {
                    name: picture_display_name(&path_string),
                    path: path_string,
                    modified_at: Some(modified_at),
                },
            });
            if batch.len() >= 64 {
                flush_library_scan_batch(snapshot, &mut batch)?;
            }
        }
    }
    flush_library_scan_batch(snapshot, &mut batch)?;
    Ok(())
}

pub fn flush_library_scan_batch(
    snapshot: &Arc<Mutex<LibraryScanSnapshot>>,
    batch: &mut Vec<LibraryScanEntry>,
) -> Result<(), String> {
    if batch.is_empty() {
        return Ok(());
    }
    let mut guard = snapshot
        .lock()
        .map_err(|_| "library scan snapshot lock poisoned".to_string())?;
    guard.items.extend(batch.drain(..));
    guard
        .items
        .sort_by(|a, b| b.modified_at.cmp(&a.modified_at));
    Ok(())
}

pub struct ThumbnailJob {
    pub path: String,
    pub response: tokio::sync::oneshot::Sender<Result<Vec<u8>, String>>,
}

type ThumbnailResponse = tokio::sync::oneshot::Sender<Result<Vec<u8>, String>>;
type ThumbnailPending = HashMap<String, Vec<ThumbnailResponse>>;
type ThumbnailState = (VecDeque<String>, ThumbnailPending);

pub struct PendingThumbnailJob {
    pub path: String,
    pub responses: Vec<ThumbnailResponse>,
}

pub struct ThumbnailQueue {
    jobs: Mutex<ThumbnailState>,
    has_jobs: Condvar,
}

impl ThumbnailQueue {
    pub fn new() -> Self {
        Self {
            jobs: Mutex::new((VecDeque::new(), HashMap::new())),
            has_jobs: Condvar::new(),
        }
    }

    pub fn push(&self, job: ThumbnailJob) {
        let mut jobs = self.jobs.lock().unwrap();
        let (order, pending) = &mut *jobs;
        if let Some(responses) = pending.get_mut(&job.path) {
            responses.push(job.response);
            if let Some(existing_idx) = order.iter().position(|path| path == &job.path) {
                order.remove(existing_idx);
            }
            order.push_back(job.path);
        } else {
            pending.insert(job.path.clone(), vec![job.response]);
            order.push_back(job.path);
        }
        self.has_jobs.notify_one();
    }

    pub fn pop_latest(&self) -> PendingThumbnailJob {
        let mut jobs = self.jobs.lock().unwrap();
        loop {
            let (order, pending) = &mut *jobs;
            if let Some(path) = order.pop_back() {
                let responses = pending
                    .remove(&path)
                    .expect("thumbnail queue pending entry must exist");
                return PendingThumbnailJob { path, responses };
            }
            jobs = self.has_jobs.wait(jobs).unwrap();
        }
    }
}

pub enum RenderJob {
    Preview {
        stack: LayerStack,
        sources: std::collections::HashMap<shade_core::TextureId, FloatImage>,
        canvas_width: u32,
        canvas_height: u32,
        request: PreviewRenderRequest,
        response: tokio::sync::oneshot::Sender<Result<PreviewFrameResponse, String>>,
    },
    PreviewFloat16 {
        stack: LayerStack,
        sources: std::collections::HashMap<shade_core::TextureId, FloatImage>,
        canvas_width: u32,
        canvas_height: u32,
        request: PreviewRenderRequest,
        response: tokio::sync::oneshot::Sender<Result<PreviewFrameFloat16Response, String>>,
    },
}

fn generate_desktop_thumbnail(path: &str) -> Result<Vec<u8>, String> {
    let source = std::path::Path::new(path);
    let mut source_file = std::fs::File::open(source).map_err(|e| e.to_string())?;
    let mut hasher = blake3::Hasher::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = std::io::Read::read(&mut source_file, &mut buffer).map_err(|e| e.to_string())?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    let cache_key = hasher.finalize().to_hex().to_string();

    let cache_dir = std::env::temp_dir().join("shade-thumbnails");
    std::fs::create_dir_all(&cache_dir).map_err(|e| e.to_string())?;
    let cache_path = cache_dir.join(format!("v2-{cache_key}.jpg"));

    if cache_path.exists() {
        return std::fs::read(&cache_path).map_err(|e| e.to_string());
    }

    let (pixels, width, height) = shade_io::load_image(source).map_err(|e| e.to_string())?;
    let img = image::RgbaImage::from_raw(width, height, pixels)
        .ok_or("failed to wrap pixels in RgbaImage")?;
    let thumb = image::DynamicImage::ImageRgba8(img).thumbnail(320, 320);
    let mut jpeg: Vec<u8> = Vec::new();
    thumb
        .write_to(
            &mut std::io::Cursor::new(&mut jpeg),
            image::ImageFormat::Jpeg,
        )
        .map_err(|e| e.to_string())?;
    std::fs::write(&cache_path, &jpeg).map_err(|e| e.to_string())?;
    Ok(jpeg)
}

pub fn spawn_thumbnail_workers() -> Arc<ThumbnailQueue> {
    let queue = Arc::new(ThumbnailQueue::new());
    for worker_idx in 0..3 {
        let worker_queue = queue.clone();
        std::thread::Builder::new()
            .name(format!("shade-thumbnail-{worker_idx}"))
            .spawn(move || loop {
                let job = worker_queue.pop_latest();
                let result = generate_desktop_thumbnail(&job.path);
                for response in job.responses {
                    let _ = response.send(result.clone());
                }
            })
            .expect("failed to spawn thumbnail worker thread");
    }
    queue
}

pub fn spawn_render_worker() -> crossbeam_channel::Sender<RenderJob> {
    let (sender, receiver) = crossbeam_channel::unbounded::<RenderJob>();
    std::thread::Builder::new()
        .name("shade-render".into())
        .spawn(move || {
            let runtime = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .expect("failed to create render runtime");
            let renderer = runtime
                .block_on(shade_gpu::Renderer::new())
                .map_err(|e| e.to_string());
            while let Ok(job) = receiver.recv() {
                match job {
                    RenderJob::Preview {
                        stack,
                        sources,
                        canvas_width,
                        canvas_height,
                        request,
                        response,
                    } => {
                        let result = match &renderer {
                            Ok(renderer) => runtime
                                .block_on(renderer.render_stack_preview(
                                    &stack,
                                    &sources,
                                    canvas_width,
                                    canvas_height,
                                    request.target_width,
                                    request.target_height,
                                    request.crop.map(|crop| shade_gpu::PreviewCrop {
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
                                .map_err(|e| e.to_string()),
                            Err(error) => Err(error.clone()),
                        };
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
                        let result = match &renderer {
                            Ok(renderer) => runtime
                                .block_on(renderer.render_stack_preview_f16(
                                    &stack,
                                    &sources,
                                    canvas_width,
                                    canvas_height,
                                    request.target_width,
                                    request.target_height,
                                    request.crop.map(|crop| shade_gpu::PreviewCrop {
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
                                .map_err(|e| e.to_string()),
                            Err(error) => Err(error.clone()),
                        };
                        let _ = response.send(result);
                    }
                }
            }
        })
        .expect("failed to spawn render worker thread");
    sender
}

impl Default for EditorState {
    fn default() -> Self {
        Self {
            stack: LayerStack::new(),
            image_sources: std::collections::HashMap::new(),
            canvas_width: 1920,
            canvas_height: 1080,
            next_texture_id: 1,
            source_bit_depth: "Unknown".into(),
        }
    }
}

impl EditorState {
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
        self.image_sources.insert(
            texture_id,
            FloatImage {
                pixels: pixels.into(),
                width,
                height,
            },
        );
        self.canvas_width = width;
        self.canvas_height = height;
        self.source_bit_depth = source_bit_depth.clone();
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
}

#[tauri::command]
pub async fn get_local_peer_discovery_snapshot(
    p2p: tauri::State<'_, crate::P2pState>,
) -> Result<shade_p2p::LocalPeerDiscoverySnapshot, String> {
    Ok(require_p2p(&p2p).await?.snapshot().await)
}

#[tauri::command]
pub async fn list_peer_pictures(
    peer_endpoint_id: String,
    p2p: tauri::State<'_, crate::P2pState>,
) -> Result<Vec<shade_p2p::SharedPicture>, String> {
    require_p2p(&p2p)
        .await?
        .list_peer_pictures(&peer_endpoint_id)
        .await
        .map_err(|error| error.to_string())
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

#[tauri::command]
pub async fn open_peer_image(
    peer_endpoint_id: String,
    picture_id: String,
    file_name: Option<String>,
    p2p: tauri::State<'_, crate::P2pState>,
    state: tauri::State<'_, Mutex<EditorState>>,
) -> Result<LayerInfoResponse, String> {
    let bytes = require_p2p(&p2p)
        .await?
        .get_peer_image_bytes(&peer_endpoint_id, &picture_id)
        .await
        .map_err(|error| error.to_string())?;
    let (image, info) = decode_image_bytes_with_info(&bytes, file_name.as_deref())?;
    let mut st = state.lock().unwrap();
    Ok(st.replace_with_image(
        image.pixels.to_vec(),
        image.width,
        image.height,
        info.bit_depth,
        info.color_space,
    ))
}

#[tauri::command]
#[allow(unused_variables)]
pub async fn open_image<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    path: String,
    state: tauri::State<'_, Mutex<EditorState>>,
) -> Result<LayerInfoResponse, String> {
    #[cfg(target_os = "android")]
    if path.starts_with("content://") {
        let bytes = app
            .state::<crate::photos::PhotosHandle<R>>()
            .get_image_data(&path)
            .await?;
        let (image, info) = decode_image_bytes_with_info(&bytes, None)?;
        let mut st = state.lock().unwrap();
        return Ok(st.replace_with_image(
            image.pixels.to_vec(),
            image.width,
            image.height,
            info.bit_depth,
            info.color_space,
        ));
    }

    #[cfg(target_os = "ios")]
    if !path.starts_with('/') {
        let bytes = tokio::task::spawn_blocking(move || {
            let c_id = std::ffi::CString::new(path.as_str()).map_err(|e| e.to_string())?;
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
        .map_err(|e| e.to_string())??;

        let (image, info) = decode_image_bytes_with_info(&bytes, None)?;
        let mut st = state.lock().unwrap();
        return Ok(st.replace_with_image(
            image.pixels.to_vec(),
            image.width,
            image.height,
            info.bit_depth,
            info.color_space,
        ));
    }

    let (image, info) = decode_image_path_with_info(std::path::Path::new(&path))?;
    let mut st = state.lock().unwrap();
    Ok(st.replace_with_image(
        image.pixels.to_vec(),
        image.width,
        image.height,
        info.bit_depth,
        info.color_space,
    ))
}

#[tauri::command]
pub async fn open_image_encoded_bytes(
    bytes: Vec<u8>,
    file_name: Option<String>,
    state: tauri::State<'_, Mutex<EditorState>>,
) -> Result<LayerInfoResponse, String> {
    let (image, info) = decode_image_bytes_with_info(&bytes, file_name.as_deref())?;
    let mut st = state.lock().unwrap();
    Ok(st.replace_with_image(
        image.pixels.to_vec(),
        image.width,
        image.height,
        info.bit_depth,
        info.color_space,
    ))
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
    state: tauri::State<'_, Mutex<EditorState>>,
) -> Result<LayerInfoResponse, String> {
    if pixels.len() != (width * height * 4) as usize {
        return Err(format!(
            "pixel buffer size mismatch: expected {}, got {}",
            width * height * 4,
            pixels.len()
        ));
    }
    let mut st = state.lock().unwrap();
    Ok(st.replace_with_image(
        pixels
            .into_iter()
            .map(|channel| channel as f32 / 255.0)
            .collect(),
        width,
        height,
        "8-bit".into(),
        shade_core::ColorSpace::Srgb,
    ))
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
        std::collections::HashMap<shade_core::TextureId, FloatImage>,
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

/// Run the full GPU render pipeline and return raw RGBA8 pixels.
#[tauri::command]
pub async fn render_preview(
    request: Option<PreviewRenderRequest>,
    render_service: tauri::State<'_, crate::RenderService>,
    state: tauri::State<'_, Mutex<EditorState>>,
) -> Result<PreviewFrameResponse, String> {
    let (stack, sources, canvas_width, canvas_height) = snapshot_render_state(&state)?;
    let (stack, request) = apply_preview_request(stack, canvas_width, canvas_height, request);
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
    response_rx.await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn render_preview_float16(
    request: Option<PreviewRenderRequest>,
    render_service: tauri::State<'_, crate::RenderService>,
    state: tauri::State<'_, Mutex<EditorState>>,
) -> Result<PreviewFrameFloat16Response, String> {
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
    let (stack, request) = apply_preview_request(stack, canvas_width, canvas_height, request);
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
    response_rx.await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn export_image(
    _path: String,
    _state: tauri::State<'_, Mutex<EditorState>>,
) -> Result<(), String> {
    // Placeholder — full GPU render would go here.
    // In a real implementation this would call renderer.render_stack()
    Ok(())
}

#[derive(Serialize, Deserialize, Debug)]
pub struct EditParams {
    pub layer_idx: usize,
    pub op: String, // "tone", "curves", "color", "vignette", "sharpen", "grain"
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
}

#[tauri::command]
pub async fn apply_edit(
    params: EditParams,
    state: tauri::State<'_, Mutex<EditorState>>,
) -> Result<(), String> {
    let mut st = state.lock().unwrap();
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
                    let curve_points = params.curve_points.ok_or("missing curve_points")?;
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
                    let next = AdjustmentOp::Grain(GrainParams {
                        amount: params.grain_amount.unwrap_or(0.0),
                        ..Default::default()
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
                    if let Some(op) = ops.iter_mut().find(|op| matches!(op, AdjustmentOp::Hsl(_))) {
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
    Ok(())
}

#[tauri::command]
pub async fn add_layer(
    kind: String,
    state: tauri::State<'_, Mutex<EditorState>>,
) -> Result<usize, String> {
    let mut st = state.lock().unwrap();
    let canvas_width = st.canvas_width;
    let canvas_height = st.canvas_height;
    let idx = match kind.as_str() {
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
        "crop" => st.stack.add_crop_layer(CropRect {
            x: 0.0,
            y: 0.0,
            width: canvas_width as f32,
            height: canvas_height as f32,
        }),
        _ => return Err(format!("unknown layer kind: {kind}")),
    };
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
    let mut st = state.lock().unwrap();
    if params.layer_idx >= st.stack.layers.len() {
        return Err("index out of bounds".into());
    }
    st.stack.layers[params.layer_idx].visible = params.visible;
    st.stack.generation += 1;
    Ok(())
}

#[derive(Serialize, Deserialize, Debug)]
pub struct LayerOpacityParams {
    pub layer_idx: usize,
    pub opacity: f32,
}

#[tauri::command]
pub async fn set_layer_opacity(
    params: LayerOpacityParams,
    state: tauri::State<'_, Mutex<EditorState>>,
) -> Result<(), String> {
    let mut st = state.lock().unwrap();
    if params.layer_idx >= st.stack.layers.len() {
        return Err("index out of bounds".into());
    }
    st.stack.layers[params.layer_idx].opacity = params.opacity.clamp(0.0, 1.0);
    st.stack.generation += 1;
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
    let mut st = state.lock().unwrap();
    if params.layer_idx >= st.stack.layers.len() {
        return Err("index out of bounds".into());
    }
    if let Some(mask_id) = st.stack.layers[params.layer_idx].mask {
        st.stack.masks.remove(&mask_id);
    }
    st.stack.layers.remove(params.layer_idx);
    st.stack.generation += 1;
    Ok(())
}

#[derive(Serialize, Deserialize, Debug)]
pub struct LayerStackInfo {
    pub layers: Vec<LayerEntryInfo>,
    pub canvas_width: u32,
    pub canvas_height: u32,
    pub generation: u64,
}

#[derive(Serialize, Deserialize, Debug)]
pub struct LayerEntryInfo {
    pub kind: String,
    pub visible: bool,
    pub opacity: f32,
    pub blend_mode: String,
    pub adjustments: Option<AdjustmentValues>,
    pub crop: Option<CropValues>,
}

#[derive(Serialize, Deserialize, Debug)]
pub struct CropValues {
    pub x: f32,
    pub y: f32,
    pub width: f32,
    pub height: f32,
}

#[derive(Serialize, Deserialize, Debug, Default)]
pub struct AdjustmentValues {
    pub tone: Option<ToneValues>,
    pub curves: Option<CurvesValues>,
    pub color: Option<ColorValues>,
    pub vignette: Option<VignetteValues>,
    pub sharpen: Option<SharpenValues>,
    pub grain: Option<GrainValues>,
    pub hsl: Option<HslValues>,
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
    #[cfg(target_os = "android")]
    if picture_id.starts_with("content://") {
        return app
            .state::<crate::photos::PhotosHandle<R>>()
            .get_thumbnail(picture_id)
            .await;
    }

    #[cfg(target_os = "ios")]
    if !picture_id.starts_with('/') {
        let picture_id = picture_id.to_owned();
        return tokio::task::spawn_blocking(move || {
            let c_id = std::ffi::CString::new(picture_id.as_str()).map_err(|e| e.to_string())?;
            let mut out_size: i32 = 0;
            let ptr = unsafe { ios_get_thumbnail(c_id.as_ptr(), 320, 320, &mut out_size) };
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
        .map_err(|e| e.to_string())?;
    }

    let (response_tx, response_rx) = tokio::sync::oneshot::channel();
    app.state::<crate::ThumbnailService>().0.push(ThumbnailJob {
        path: picture_id.to_owned(),
        response: response_tx,
    });
    response_rx.await.map_err(|e| e.to_string())?
}

pub async fn load_picture_bytes<R: tauri::Runtime>(
    _app: tauri::AppHandle<R>,
    picture_id: &str,
) -> Result<Vec<u8>, String> {
    #[cfg(target_os = "android")]
    if picture_id.starts_with("content://") {
        return _app
            .state::<crate::photos::PhotosHandle<R>>()
            .get_image_data(picture_id)
            .await;
    }

    #[cfg(target_os = "ios")]
    if !picture_id.starts_with('/') {
        let picture_id = picture_id.to_owned();
        return tokio::task::spawn_blocking(move || {
            let c_id = std::ffi::CString::new(picture_id.as_str()).map_err(|e| e.to_string())?;
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
        .map_err(|e| e.to_string())?;
    }

    std::fs::read(picture_id).map_err(|e| e.to_string())
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
    return _app
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
                .collect()
        });

    #[cfg(target_os = "ios")]
    return tokio::task::spawn_blocking(|| {
        let ptr = unsafe { ios_list_photos() };
        if ptr.is_null() {
            return Ok(vec![]);
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
                    .collect()
            })
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?;

    #[cfg(not(any(target_os = "ios", target_os = "android")))]
    Ok(collect_images_in_directory(&default_pictures_dir()?)?
        .into_iter()
        .map(|picture| shade_p2p::SharedPicture {
            name: picture.name,
            id: picture.path,
            modified_at: picture.modified_at,
        })
        .collect())
}

#[tauri::command]
pub async fn list_media_libraries<R: tauri::Runtime>(
    _app: tauri::AppHandle<R>,
) -> Result<Vec<MediaLibrary>, String> {
    #[cfg(target_os = "android")]
    {
        let _ = _app;
        return Ok(vec![MediaLibrary {
            id: "photos".into(),
            name: "Photos".into(),
            kind: "directory".into(),
            path: None,
            removable: false,
        }]);
    }

    #[cfg(target_os = "ios")]
    {
        let _ = _app;
        return Ok(vec![MediaLibrary {
            id: "photos".into(),
            name: "Photos".into(),
            kind: "directory".into(),
            path: None,
            removable: false,
        }]);
    }

    #[cfg(not(any(target_os = "ios", target_os = "android")))]
    {
        let _ = _app;
        list_desktop_media_libraries()
    }
}

#[tauri::command]
pub async fn list_library_images<R: tauri::Runtime>(
    _app: tauri::AppHandle<R>,
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
                return Ok(vec![]);
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
        let library_path = resolve_desktop_library_path(&library_id)?;
        _app.state::<crate::LibraryScanService>()
            .0
            .snapshot_for_library(&library_id, library_path)
    }
}

#[tauri::command]
pub async fn add_media_library(path: String) -> Result<MediaLibrary, String> {
    let canonical = std::fs::canonicalize(Path::new(&path)).map_err(|e| e.to_string())?;
    if !canonical.is_dir() {
        return Err(format!("not a directory: {}", canonical.display()));
    }
    let mut config = load_app_config()?;
    let canonical_string = canonical
        .to_str()
        .ok_or_else(|| format!("non-utf8 path: {}", canonical.display()))?
        .to_string();
    if !config
        .directories
        .iter()
        .any(|existing| existing == &canonical_string)
    {
        config.directories.push(canonical_string);
        save_app_config(&config)?;
    }
    Ok(library_for_directory(canonical))
}

#[tauri::command]
pub async fn remove_media_library(id: String) -> Result<(), String> {
    if id == "pictures" || id == "photos" {
        return Err(format!("media library is not removable: {id}"));
    }
    let mut config = load_app_config()?;
    let before = config.directories.len();
    config
        .directories
        .retain(|directory| custom_library_id(Path::new(directory)) != id);
    if config.directories.len() == before {
        return Err(format!("unknown media library: {id}"));
    }
    save_app_config(&config)
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
    let layers = st
        .stack
        .layers
        .iter()
        .filter(|entry| !matches!(entry.layer, shade_core::Layer::Image { .. }))
        .cloned()
        .collect();
    let file = PresetFile { version: 1, layers };
    let json = serde_json::to_string_pretty(&file).map_err(|e| e.to_string())?;
    std::fs::write(&path, json).map_err(|e| e.to_string())?;
    Ok(PresetInfo {
        name: name.trim().to_string(),
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
    let mut st = state.lock().unwrap();
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
    st.stack.layers.extend(file.layers);
    st.stack.generation += 1;
    Ok(())
}

fn picture_display_name(picture_id: &str) -> String {
    if let Some(name) = Path::new(picture_id)
        .file_name()
        .and_then(|name| name.to_str())
    {
        return name.to_owned();
    }
    let short = if picture_id.len() <= 20 {
        picture_id.to_owned()
    } else {
        format!(
            "{}...{}",
            &picture_id[..8],
            &picture_id[picture_id.len() - 8..]
        )
    };
    format!("Photo {short}")
}

pub struct AppMediaProvider<R: tauri::Runtime = tauri::Wry> {
    app: tauri::AppHandle<R>,
    prompt_lock: Arc<TokioMutex<()>>,
}

impl<R: tauri::Runtime> AppMediaProvider<R> {
    pub fn new(app: tauri::AppHandle<R>) -> Self {
        Self {
            app,
            prompt_lock: Arc::new(TokioMutex::new(())),
        }
    }
}

#[async_trait::async_trait]
impl<R: tauri::Runtime> shade_p2p::MediaProvider for AppMediaProvider<R> {
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
        pair_peer(&peer_endpoint_id).map_err(anyhow::Error::msg)
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
            visible: l.visible,
            opacity: l.opacity,
            blend_mode: format!("{:?}", l.blend_mode),
            crop: match &l.layer {
                shade_core::Layer::Crop { rect } => Some(CropValues {
                    x: rect.x,
                    y: rect.y,
                    width: rect.width,
                    height: rect.height,
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
    })
}
