use crate::{
    indexed_library_image_for_path, is_supported_library_image,
    load_persisted_library_index, replace_persisted_library_index,
    sort_indexed_library_items, IndexedLibraryImage, LibraryIndexDb,
};
use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

const LIBRARY_WATCH_DEBOUNCE: Duration = Duration::from_millis(750);

#[derive(Clone, Debug, Default)]
pub struct LibraryScanSnapshot {
    pub items: Vec<IndexedLibraryImage>,
    pub is_scanning: bool,
    pub is_complete: bool,
    pub error: Option<String>,
    pub completed_at: Option<u64>,
}

pub struct LibraryScanService {
    pub scans: Mutex<HashMap<String, Arc<Mutex<LibraryScanSnapshot>>>>,
    pub watches: Mutex<HashMap<String, LibraryWatchHandle>>,
    pub index_db: Arc<LibraryIndexDb>,
}

pub struct LibraryWatchHandle {
    pub _watcher: RecommendedWatcher,
}

impl LibraryScanService {
    pub fn new(index_db: Arc<LibraryIndexDb>) -> Arc<Self> {
        Arc::new(Self {
            scans: Mutex::new(HashMap::new()),
            watches: Mutex::new(HashMap::new()),
            index_db,
        })
    }

    pub async fn ensure_snapshot_for_library(
        &self,
        library_id: &str,
        root: PathBuf,
    ) -> Result<(Arc<Mutex<LibraryScanSnapshot>>, bool), String> {
        if let Some(snapshot) = self
            .scans
            .lock()
            .map_err(|_| "library scan lock poisoned".to_string())?
            .get(library_id)
            .cloned()
        {
            return Ok((snapshot, false));
        }
        let persisted = load_persisted_library_index(&self.index_db, library_id, &root).await?;
        let should_scan = persisted.is_none();
        let completed_at = persisted.as_ref().map(|listing| listing.indexed_at);
        let snapshot = Arc::new(Mutex::new(LibraryScanSnapshot {
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
                .map_err(|_| "library scan lock poisoned".to_string())?;
            scans
                .entry(library_id.to_string())
                .or_insert_with(|| snapshot.clone())
                .clone()
        };
        Ok((snapshot, should_scan))
    }

    pub fn watch_library(
        self: &Arc<Self>,
        library_id: &str,
        root: PathBuf,
    ) -> Result<(), String> {
        let mut watches = self
            .watches
            .lock()
            .map_err(|_| "library watch lock poisoned".to_string())?;
        if watches.contains_key(library_id) {
            return Ok(());
        }
        let (tx, rx) = std::sync::mpsc::channel();
        let mut watcher = notify::recommended_watcher(move |result| {
            let _ = tx.send(result);
        })
        .map_err(|error| error.to_string())?;
        watcher
            .watch(&root, RecursiveMode::Recursive)
            .map_err(|error| error.to_string())?;
        spawn_library_watch_loop(
            self.clone(),
            library_id.to_string(),
            root,
            rx,
        )?;
        watches.insert(
            library_id.to_string(),
            LibraryWatchHandle { _watcher: watcher },
        );
        Ok(())
    }

    pub async fn request_refresh(
        &self,
        library_id: &str,
        root: PathBuf,
    ) -> Result<bool, String> {
        let (snapshot, _) = self
            .ensure_snapshot_for_library(library_id, root.clone())
            .await?;
        {
            let guard = snapshot
                .lock()
                .map_err(|_| "library scan snapshot lock poisoned".to_string())?;
            if guard.is_scanning {
                return Ok(false);
            }
        }
        start_library_scan(
            snapshot,
            self.index_db.clone(),
            library_id.to_string(),
            root,
            false,
        )?;
        Ok(true)
    }

    pub async fn snapshot_for_library(
        self: &Arc<Self>,
        library_id: &str,
        root: PathBuf,
    ) -> Result<LibraryScanSnapshot, String> {
        self.watch_library(library_id, root.clone())?;
        let (snapshot, should_scan) = self
            .ensure_snapshot_for_library(library_id, root.clone())
            .await?;
        if should_scan {
            start_library_scan(
                snapshot.clone(),
                self.index_db.clone(),
                library_id.to_string(),
                root,
                true,
            )?;
        }
        let snapshot = snapshot
            .lock()
            .map_err(|_| "library scan snapshot lock poisoned".to_string())?
            .clone();
        if let Some(error) = &snapshot.error {
            return Err(error.clone());
        }
        Ok(snapshot)
    }

    pub async fn refresh_library(
        self: &Arc<Self>,
        library_id: &str,
        root: PathBuf,
    ) -> Result<(), String> {
        self.watch_library(library_id, root.clone())?;
        if self.request_refresh(library_id, root).await? {
            return Ok(());
        }
        Err(format!(
            "library index refresh already running: {library_id}"
        ))
    }

    pub fn remove_library(&self, library_id: &str) -> Result<(), String> {
        self.scans
            .lock()
            .map_err(|_| "library scan lock poisoned".to_string())?
            .remove(library_id);
        self.watches
            .lock()
            .map_err(|_| "library watch lock poisoned".to_string())?
            .remove(library_id);
        Ok(())
    }

    pub fn is_refreshing(&self, library_id: &str) -> Result<bool, String> {
        let snapshot = self
            .scans
            .lock()
            .map_err(|_| "library scan lock poisoned".to_string())?
            .get(library_id)
            .cloned();
        let Some(snapshot) = snapshot else {
            return Ok(false);
        };
        let is_refreshing = snapshot
            .lock()
            .map_err(|_| "library scan snapshot lock poisoned".to_string())?
            .is_scanning;
        Ok(is_refreshing)
    }
}

fn spawn_library_watch_loop(
    service: Arc<LibraryScanService>,
    library_id: String,
    root: PathBuf,
    rx: std::sync::mpsc::Receiver<Result<notify::Event, notify::Error>>,
) -> Result<(), String> {
    std::thread::Builder::new()
        .name("shade-library-watch".into())
        .spawn(move || {
            let runtime = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .expect("failed to create library watch runtime");
            loop {
                let mut has_refreshable_event = match rx.recv() {
                    Ok(Ok(event)) => library_watch_event_requires_refresh(&event),
                    Ok(Err(_)) => true,
                    Err(_) => return,
                };
                loop {
                    match rx.recv_timeout(LIBRARY_WATCH_DEBOUNCE) {
                        Ok(Ok(event)) => {
                            has_refreshable_event |=
                                library_watch_event_requires_refresh(&event);
                        }
                        Ok(Err(_)) => {
                            has_refreshable_event = true;
                        }
                        Err(std::sync::mpsc::RecvTimeoutError::Timeout) => break,
                        Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => return,
                    }
                }
                if !has_refreshable_event {
                    continue;
                }
                loop {
                    match runtime.block_on(service.request_refresh(
                        &library_id,
                        root.clone(),
                    )) {
                        Ok(true) => break,
                        Ok(false) => std::thread::sleep(LIBRARY_WATCH_DEBOUNCE),
                        Err(_) => break,
                    }
                }
            }
        })
        .map_err(|error| error.to_string())?;
    Ok(())
}

fn library_watch_event_requires_refresh(event: &notify::Event) -> bool {
    !matches!(event.kind, notify::EventKind::Access(_))
}

pub fn start_library_scan(
    snapshot: Arc<Mutex<LibraryScanSnapshot>>,
    index_db: Arc<LibraryIndexDb>,
    library_id: String,
    root: PathBuf,
    publish_progress: bool,
) -> Result<(), String> {
    {
        let mut guard = snapshot
            .lock()
            .map_err(|_| "library scan snapshot lock poisoned".to_string())?;
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
        .name("shade-library-scan".into())
        .spawn(move || {
            let result = scan_library_into_snapshot(&root, &snapshot, publish_progress)
                .and_then(|items| {
                    let runtime = tokio::runtime::Builder::new_current_thread()
                        .enable_all()
                        .build()
                        .map_err(|error| error.to_string())?;
                    runtime
                        .block_on(replace_persisted_library_index(
                            &index_db,
                            &library_id,
                            &root,
                            &items,
                        ))
                        .map(|indexed_at| (items, indexed_at))
                });
            let mut guard = snapshot
                .lock()
                .expect("library scan snapshot lock poisoned");
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
        .expect("failed to spawn library scan thread");
    Ok(())
}

pub fn scan_library_into_snapshot(
    dir: &Path,
    snapshot: &Arc<Mutex<LibraryScanSnapshot>>,
    publish_progress: bool,
) -> Result<Vec<IndexedLibraryImage>, String> {
    let mut dirs = vec![dir.to_path_buf()];
    let mut batch = Vec::new();
    let mut items = Vec::new();
    while let Some(current_dir) = dirs.pop() {
        let entries =
            std::fs::read_dir(&current_dir).map_err(|error| error.to_string())?;
        for entry in entries {
            let entry = entry.map_err(|error| error.to_string())?;
            let path = entry.path();
            if path.is_dir() {
                dirs.push(path);
                continue;
            }
            if !path.is_file() || !is_supported_library_image(&path) {
                continue;
            }
            let item = indexed_library_image_for_path(&path)?;
            items.push(item.clone());
            if publish_progress {
                batch.push(item);
            }
            if publish_progress && batch.len() >= 64 {
                flush_library_scan_batch(snapshot, &mut batch)?;
            }
        }
    }
    if publish_progress {
        flush_library_scan_batch(snapshot, &mut batch)?;
    }
    sort_indexed_library_items(&mut items);
    Ok(items)
}

pub fn flush_library_scan_batch(
    snapshot: &Arc<Mutex<LibraryScanSnapshot>>,
    batch: &mut Vec<IndexedLibraryImage>,
) -> Result<(), String> {
    if batch.is_empty() {
        return Ok(());
    }
    let mut guard = snapshot
        .lock()
        .map_err(|_| "library scan snapshot lock poisoned".to_string())?;
    guard.items.extend(batch.drain(..));
    sort_indexed_library_items(&mut guard.items);
    Ok(())
}
