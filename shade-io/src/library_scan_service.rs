use crate::{
    indexed_library_image_for_path, is_supported_library_image, load_persisted_library_index,
    replace_persisted_library_index, sort_indexed_library_items, IndexedLibraryImage,
};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

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
}

impl LibraryScanService {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            scans: Mutex::new(HashMap::new()),
        })
    }

    pub async fn ensure_snapshot_for_library(
        &self,
        db_path: &Path,
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
        let persisted = load_persisted_library_index(db_path, library_id, &root).await?;
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

    pub async fn snapshot_for_library(
        &self,
        db_path: &Path,
        library_id: &str,
        root: PathBuf,
    ) -> Result<LibraryScanSnapshot, String> {
        let (snapshot, should_scan) =
            self.ensure_snapshot_for_library(db_path, library_id, root.clone()).await?;
        if should_scan {
            start_library_scan(
                snapshot.clone(),
                db_path.to_path_buf(),
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
        &self,
        db_path: &Path,
        library_id: &str,
        root: PathBuf,
    ) -> Result<(), String> {
        let (snapshot, _) =
            self.ensure_snapshot_for_library(db_path, library_id, root.clone()).await?;
        start_library_scan(
            snapshot,
            db_path.to_path_buf(),
            library_id.to_string(),
            root,
            false,
        )
    }

    pub fn remove_library(&self, library_id: &str) -> Result<(), String> {
        self.scans
            .lock()
            .map_err(|_| "library scan lock poisoned".to_string())?
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

pub fn start_library_scan(
    snapshot: Arc<Mutex<LibraryScanSnapshot>>,
    db_path: PathBuf,
    library_id: String,
    root: PathBuf,
    publish_progress: bool,
) -> Result<(), String> {
    {
        let mut guard = snapshot
            .lock()
            .map_err(|_| "library scan snapshot lock poisoned".to_string())?;
        if guard.is_scanning {
            return Err(format!("library index refresh already running: {library_id}"));
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
            let result = scan_library_into_snapshot(&root, &snapshot, publish_progress).and_then(
                |items| {
                    let runtime = tokio::runtime::Builder::new_current_thread()
                        .enable_all()
                        .build()
                        .map_err(|error| error.to_string())?;
                    runtime
                        .block_on(replace_persisted_library_index(
                            &db_path,
                            &library_id,
                            &root,
                            &items,
                        ))
                        .map(|indexed_at| (items, indexed_at))
                },
            );
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
        let entries = std::fs::read_dir(&current_dir).map_err(|error| error.to_string())?;
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
