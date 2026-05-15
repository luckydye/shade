use shade_io::{
    has_persisted_library_index,
    has_persisted_library_index_by_root, is_supported_library_image, picture_display_name,
    replace_persisted_library_index_by_root,
};
use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, Mutex};
use tauri::{Emitter, Manager};
use crate::config::load_app_config;
use crate::db::library_index_db;
use crate::media_libraries::{desktop_local_library_roots, local_library_is_available, s3_library_id};


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

    pub async fn snapshot_for_library<R: tauri::Runtime>(
        self: &Arc<Self>,
        app: tauri::AppHandle<R>,
        config: &shade_io::S3LibraryConfig,
    ) -> Result<shade_io::LibraryScanSnapshot, String> {
        let (snapshot, should_scan) =
            self.ensure_snapshot_for_library(config).await?;
        if should_scan {
            start_s3_library_scan(
                app,
                snapshot.clone(),
                self.index_db.clone(),
                config.clone(),
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

    pub async fn request_refresh<R: tauri::Runtime>(
        self: &Arc<Self>,
        app: tauri::AppHandle<R>,
        config: &shade_io::S3LibraryConfig,
    ) -> Result<bool, String> {
        let (snapshot, _) = self.ensure_snapshot_for_library(config).await?;
        {
            let guard = snapshot
                .lock()
                .map_err(|_| "S3 library scan snapshot lock poisoned".to_string())?;
            if guard.is_scanning {
                return Ok(false);
            }
        }
        start_s3_library_scan(
            app,
            snapshot,
            self.index_db.clone(),
            config.clone(),
        )?;
        Ok(true)
    }

    pub async fn refresh_library<R: tauri::Runtime>(
        self: &Arc<Self>,
        app: tauri::AppHandle<R>,
        config: &shade_io::S3LibraryConfig,
    ) -> Result<(), String> {
        if self.request_refresh(app, config).await? {
            return Ok(());
        }
        Err(format!(
            "library index refresh already running: {}",
            s3_library_id(&config.id)
        ))
    }

    pub async fn remove_item(&self, library_id: &str, path: &str) -> Result<(), String> {
        shade_io::delete_persisted_library_index_item(&self.index_db, library_id, path).await?;
        if let Ok(scans) = self.scans.lock() {
            if let Some(snapshot) = scans.get(library_id) {
                if let Ok(mut guard) = snapshot.lock() {
                    guard.items.retain(|item| item.path != path);
                }
            }
        }
        Ok(())
    }

    pub fn remove_library(&self, library_id: &str) -> Result<(), String> {
        self.scans
            .lock()
            .map_err(|_| "S3 library scan lock poisoned".to_string())?
            .remove(library_id);
        Ok(())
    }
}
pub(crate) fn start_s3_library_scan<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    snapshot: Arc<Mutex<shade_io::LibraryScanSnapshot>>,
    index_db: Arc<shade_io::LibraryIndexDb>,
    config: shade_io::S3LibraryConfig,
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
        guard.items.clear();
        guard.completed_at = None;
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
                            &app,
                            &library_id,
                            &config,
                            &snapshot,
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
                Ok((_, indexed_at)) => {
                    guard.completed_at = Some(indexed_at);
                }
                Err(error) => {
                    guard.error = Some(error);
                }
            }
            guard.is_scanning = false;
            guard.is_complete = true;
            drop(guard);
            crate::channel_server::channel_from_app(&app).send_blocking(
                crate::ChannelMessage::LibraryScanComplete { library_id },
            );
        })
        .map_err(|error| error.to_string())?;
    Ok(())
}
pub(crate) async fn scan_s3_library_into_snapshot<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    library_id: &str,
    config: &shade_io::S3LibraryConfig,
    snapshot: &Arc<Mutex<shade_io::LibraryScanSnapshot>>,
) -> Result<Vec<shade_io::IndexedLibraryImage>, String> {
    // Collect all image objects across all pages first (listing is fast).
    let mut image_objects = Vec::new();
    let mut continuation_token: Option<String> = None;
    loop {
        let page =
            shade_io::list_s3_objects_page(config, continuation_token.as_deref()).await?;
        for object in page.objects {
            if is_supported_library_image(Path::new(&object.key)) {
                image_objects.push(object);
            }
        }
        continuation_token = page.next_continuation_token;
        if continuation_token.is_none() {
            break;
        }
    }

    // Fire HEAD requests with bounded concurrency, draining incrementally so the UI
    // can show results as they arrive rather than waiting for all 40k objects.
    const MAX_CONCURRENT: usize = 8;
    const BATCH_SIZE: usize = 100;

    let mut join_set = tokio::task::JoinSet::new();
    let mut pending = image_objects.into_iter();

    // Seed initial tasks up to MAX_CONCURRENT.
    for object in pending.by_ref().take(MAX_CONCURRENT) {
        let config = config.clone();
        join_set.spawn(async move {
            let atime = shade_io::head_s3_object_modified_at(&config, &object.key).await;
            (object, atime)
        });
    }

    let mut batch: Vec<shade_io::IndexedLibraryImage> = Vec::with_capacity(BATCH_SIZE);
    let mut all_items = Vec::new();

    while let Some(result) = join_set.join_next().await {
        let (object, atime) = result.map_err(|e| e.to_string())?;
        let item = shade_io::IndexedLibraryImage {
            name: picture_display_name(&object.key),
            path: shade_io::media_path_for_s3_object(&config.id, &object.key),
            modified_at: atime?.or(object.modified_at),
            rating: None,
        };
        batch.push(item.clone());
        all_items.push(item);

        // Keep the pipeline full.
        if let Some(next_object) = pending.next() {
            let config = config.clone();
            join_set.spawn(async move {
                let atime =
                    shade_io::head_s3_object_modified_at(&config, &next_object.key).await;
                (next_object, atime)
            });
        }

        if batch.len() >= BATCH_SIZE {
            shade_io::flush_library_scan_batch(snapshot, &mut batch)?;
            crate::channel_server::channel_from_app(app).send_blocking(
                crate::ChannelMessage::LibraryScanProgress {
                    library_id: library_id.to_owned(),
                    scanned: 0,
                    total: 0,
                },
            );
        }
    }

    if !batch.is_empty() {
        shade_io::flush_library_scan_batch(snapshot, &mut batch)?;
        let _ = app.emit("library-scan-progress", library_id);
    }

    shade_io::sort_indexed_library_items(&mut all_items);
    Ok(all_items)
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
                s3_scan_service.refresh_library(app.clone(), &config),
            )?;
        }
        Ok(())
    }
}
