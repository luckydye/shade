#[cfg(not(any(target_os = "ios", target_os = "android")))]
use crate::thumbnail_cache::ThumbnailCacheEntry;
#[cfg(not(any(target_os = "ios", target_os = "android")))]
use tauri::Manager;

#[cfg(not(any(target_os = "ios", target_os = "android")))]
#[derive(Clone)]
pub struct ThumbnailTaggingService {
    pub sender: Option<crossbeam_channel::Sender<ThumbnailCacheEntry>>,
    pub pending_file_hashes:
        std::sync::Arc<std::sync::Mutex<std::collections::HashSet<String>>>,
    pub _lock_file: std::sync::Arc<Option<std::fs::File>>,
}

#[cfg(not(any(target_os = "ios", target_os = "android")))]
impl ThumbnailTaggingService {
    pub fn enqueue(&self, entry: ThumbnailCacheEntry) -> Result<(), String> {
        let Some(sender) = &self.sender else {
            return Ok(());
        };
        {
            let mut pending = self
                .pending_file_hashes
                .lock()
                .map_err(|_| "thumbnail tagging pending set lock poisoned".to_string())?;
            if !pending.insert(entry.file_hash.clone()) {
                return Ok(());
            }
        }
        if let Err(error) = sender.send(entry.clone()) {
            self.pending_file_hashes
                .lock()
                .map_err(|_| "thumbnail tagging pending set lock poisoned".to_string())?
                .remove(&entry.file_hash);
            return Err(error.to_string());
        }
        Ok(())
    }

    pub fn finish(&self, file_hash: &str) -> Result<(), String> {
        self.pending_file_hashes
            .lock()
            .map_err(|_| "thumbnail tagging pending set lock poisoned".to_string())?
            .remove(file_hash);
        Ok(())
    }
}

#[cfg(not(any(target_os = "ios", target_os = "android")))]
static THUMBNAIL_TAGGING_SERVICE: std::sync::OnceLock<ThumbnailTaggingService> =
    std::sync::OnceLock::new();

#[cfg(not(any(target_os = "ios", target_os = "android")))]
pub fn spawn_thumbnail_tagging_worker(
    thumbnail_cache: std::sync::Arc<crate::thumbnail_cache::ThumbnailCacheDb>,
) -> Result<ThumbnailTaggingService, String> {
    if let Some(service) = THUMBNAIL_TAGGING_SERVICE.get() {
        return Ok(service.clone());
    }
    let pid = std::process::id();
    let Some(lock_file) = try_acquire_thumbnail_tagging_lock()? else {
        log::info!("thumbnail tagging worker passive pid={pid}");
        let service = ThumbnailTaggingService {
            sender: None,
            pending_file_hashes: std::sync::Arc::new(std::sync::Mutex::new(
                std::collections::HashSet::new(),
            )),
            _lock_file: std::sync::Arc::new(None),
        };
        THUMBNAIL_TAGGING_SERVICE
            .set(service.clone())
            .map_err(|_| "thumbnail tagging worker already initialized".to_string())?;
        return Ok(service);
    };
    let model_dir = match thumbnail_tagging_model_dir() {
        Ok(model_dir) => model_dir,
        Err(error) => {
            log::warn!("thumbnail tagging disabled pid={pid}: {error}");
            let service = ThumbnailTaggingService {
                sender: None,
                pending_file_hashes: std::sync::Arc::new(std::sync::Mutex::new(
                    std::collections::HashSet::new(),
                )),
                _lock_file: std::sync::Arc::new(None),
            };
            THUMBNAIL_TAGGING_SERVICE
                .set(service.clone())
                .map_err(|_| {
                    "thumbnail tagging worker already initialized".to_string()
                })?;
            return Ok(service);
        }
    };
    let vocabulary =
        shade_tagging::photo_auto_tag_vocabulary().map_err(|e| e.to_string())?;
    let last_tagged_at =
        tauri::async_runtime::block_on(crate::commands::max_media_tag_updated_at())
            .map_err(|e| e.to_string())?;
    let startup_entries = tauri::async_runtime::block_on(
        thumbnail_cache.list_entries_after(last_tagged_at),
    )
    .map_err(|e| e.to_string())?;
    let (sender, receiver) = crossbeam_channel::unbounded::<ThumbnailCacheEntry>();
    log::info!(
        "thumbnail tagging worker active pid={pid} startup_entries={}",
        startup_entries.len()
    );
    let service = ThumbnailTaggingService {
        sender: Some(sender),
        pending_file_hashes: std::sync::Arc::new(std::sync::Mutex::new(
            std::collections::HashSet::new(),
        )),
        _lock_file: std::sync::Arc::new(Some(lock_file)),
    };
    let worker_service = service.clone();
    std::thread::Builder::new()
        .name("shade-thumbnail-tagging".into())
        .spawn(move || {
            let runtime = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .expect("failed to create thumbnail tagging runtime");
            let mut config =
                shade_tagging::Siglip2TaggerConfig::base_patch16_224(&model_dir);
            config.acceptance_threshold = 0.03;
            log::info!("thumbnail tagging constructing tagger pid={pid}");
            let mut tagger = match shade_tagging::Siglip2Tagger::new(config) {
                Ok(tagger) => tagger,
                Err(error) => {
                    log::error!(
                        "failed to initialize SigLIP2 thumbnail tagging model pid={pid}: {error}"
                    );
                    return;
                }
            };
            log::info!("thumbnail tagging constructed tagger pid={pid}");
            while let Ok(entry) = receiver.recv() {
                let file_hash = entry.file_hash.clone();
                if let Err(error) =
                    process_thumbnail_tagging_entry(&runtime, &mut tagger, &vocabulary, entry)
                {
                    eprintln!("thumbnail tagging failed for {file_hash}: {error}");
                }
                worker_service
                    .finish(&file_hash)
                    .expect("failed to mark thumbnail tagging job as finished");
            }
        })
        .map_err(|e| e.to_string())?;
    THUMBNAIL_TAGGING_SERVICE
        .set(service.clone())
        .map_err(|_| "thumbnail tagging worker already initialized".to_string())?;
    for entry in startup_entries {
        service.enqueue(entry)?;
    }
    Ok(service)
}

#[cfg(not(any(target_os = "ios", target_os = "android")))]
pub fn process_thumbnail_tagging_entry(
    runtime: &tokio::runtime::Runtime,
    tagger: &mut shade_tagging::Siglip2Tagger,
    vocabulary: &[shade_tagging::TagVocabularyEntry],
    entry: ThumbnailCacheEntry,
) -> Result<(), String> {
    log::info!("thumbnail tagging processing file_hash={}", entry.file_hash);
    if runtime.block_on(crate::commands::media_tags_exist(&entry.file_hash))? {
        log::info!(
            "thumbnail tagging skipped existing tags file_hash={}",
            entry.file_hash
        );
        return Ok(());
    }
    let image = image::load_from_memory(&entry.data).map_err(|e| e.to_string())?;
    let result = tagger
        .tag_image_with_vocabulary(
            &shade_tagging::TagImage::from_dynamic_image(image),
            vocabulary,
        )
        .map_err(|e| e.to_string())?;
    if result.tags.is_empty() {
        runtime.block_on(crate::commands::persist_media_tags_empty(&entry.file_hash))?;
        log::info!("thumbnail tagging no tags file_hash={}", entry.file_hash);
        return Ok(());
    }
    let tags = result
        .tags
        .iter()
        .map(|tag| tag.label.clone())
        .collect::<Vec<_>>();
    runtime.block_on(crate::commands::persist_media_tags(&entry.file_hash, &tags))?;
    log::info!(
        "thumbnail tagging persisted file_hash={} tags={}",
        entry.file_hash,
        tags.join(",")
    );
    Ok(())
}

#[cfg(not(any(target_os = "ios", target_os = "android")))]
pub fn enqueue_thumbnail_for_tagging<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    entry: ThumbnailCacheEntry,
) -> Result<(), String> {
    app.state::<ThumbnailTaggingService>().enqueue(entry)
}

#[cfg(not(any(target_os = "ios", target_os = "android")))]
pub async fn enqueue_existing_thumbnails_for_tagging<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
) -> Result<(), String> {
    let last_tagged_at = crate::commands::max_media_tag_updated_at().await?;
    let entries = app
        .state::<crate::ThumbnailCacheDb>()
        .0
        .list_entries_after(last_tagged_at)
        .await?;
    for entry in entries {
        enqueue_thumbnail_for_tagging(app, entry)?;
    }
    Ok(())
}

#[cfg(not(any(target_os = "ios", target_os = "android")))]
pub fn thumbnail_tagging_model_dir() -> Result<std::path::PathBuf, String> {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .ok_or("failed to resolve workspace root")?;
    let model_dir = root.join("models/siglip2-base-patch16-224-onnx");
    if !model_dir.is_dir() {
        return Err(format!(
            "thumbnail tagging model directory does not exist: {}",
            model_dir.display()
        ));
    }
    Ok(model_dir)
}

#[cfg(target_os = "windows")]
pub fn try_acquire_thumbnail_tagging_lock() -> Result<Option<std::fs::File>, String> {
    let config_dir = std::path::PathBuf::from(
        std::env::var("APPDATA").map_err(|_| "APPDATA is not set".to_string())?,
    )
    .join("shade");
    std::fs::create_dir_all(&config_dir).map_err(|e| e.to_string())?;
    let lock_path = config_dir.join("thumbnail-tagging.lock");
    let lock_file = std::fs::OpenOptions::new()
        .create(true)
        .read(true)
        .write(true)
        .truncate(false)
        .open(lock_path)
        .map_err(|e| e.to_string())?;
    Ok(Some(lock_file))
}

#[cfg(not(any(target_os = "ios", target_os = "android", target_os = "windows")))]
pub fn try_acquire_thumbnail_tagging_lock() -> Result<Option<std::fs::File>, String> {
    let home = std::env::var("HOME").map_err(|_| "HOME is not set".to_string())?;
    let config_dir = std::path::PathBuf::from(home).join(".config/shade");
    std::fs::create_dir_all(&config_dir).map_err(|e| e.to_string())?;
    let lock_path = config_dir.join("thumbnail-tagging.lock");
    let lock_file = std::fs::OpenOptions::new()
        .create(true)
        .read(true)
        .write(true)
        .truncate(false)
        .open(lock_path)
        .map_err(|e| e.to_string())?;
    let status = unsafe { flock_nonblocking_exclusive(lock_file.as_raw_fd()) };
    if status == 0 {
        return Ok(Some(lock_file));
    }
    let error = std::io::Error::last_os_error();
    let code = error.raw_os_error().unwrap_or_default();
    if code == 35 || code == 11 {
        return Ok(None);
    }
    Err(error.to_string())
}

#[cfg(not(any(target_os = "ios", target_os = "android", target_os = "windows")))]
use std::os::fd::AsRawFd;

#[cfg(not(any(target_os = "ios", target_os = "android", target_os = "windows")))]
unsafe fn flock_nonblocking_exclusive(fd: std::os::raw::c_int) -> std::os::raw::c_int {
    unsafe extern "C" {
        fn flock(
            fd: std::os::raw::c_int,
            operation: std::os::raw::c_int,
        ) -> std::os::raw::c_int;
    }
    const LOCK_EX: std::os::raw::c_int = 2;
    const LOCK_NB: std::os::raw::c_int = 4;
    unsafe { flock(fd, LOCK_EX | LOCK_NB) }
}
