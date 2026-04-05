use crate::{
    library_config_id, peer_library_id, LibraryConfig, LibraryMode, LocalLibraryConfig,
    PeerLibraryConfig, S3LibraryConfig,
};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};

#[derive(Serialize, Deserialize, Debug, Default, Clone)]
#[serde(default)]
pub struct AppConfig {
    pub libraries: Vec<LibraryConfig>,
    pub library_order: Vec<String>,
    pub library_modes: HashMap<String, LibraryMode>,
    pub sync_targets: HashMap<String, String>,
    pub p2p_secret_key: Option<[u8; 32]>,
}

const PINNED_LIBRARY_ID: &str = "pictures";

#[derive(Deserialize, Debug, Default)]
#[serde(default)]
struct PersistedAppConfig {
    libraries: Vec<LibraryConfig>,
    library_order: Vec<String>,
    library_modes: HashMap<String, LibraryMode>,
    sync_targets: HashMap<String, String>,
    directories: Vec<String>,
    s3_libraries: Vec<S3LibraryConfig>,
    paired_peers: Vec<String>,
    p2p_secret_key: Option<[u8; 32]>,
}

pub fn app_config_path(config_dir: &Path) -> PathBuf {
    config_dir.join("config.json")
}

pub fn load_app_config(config_dir: &Path) -> Result<AppConfig, String> {
    let path = app_config_path(config_dir);
    if !path.exists() {
        return Ok(AppConfig::default());
    }
    let json = std::fs::read_to_string(&path).map_err(|error| error.to_string())?;
    serde_json::from_str::<PersistedAppConfig>(&json)
        .map(migrate_app_config)
        .map_err(|error| format!("invalid app config at {}: {error}", path.display()))
}

pub fn save_app_config(config_dir: &Path, config: &AppConfig) -> Result<(), String> {
    let path = app_config_path(config_dir);
    let parent = path
        .parent()
        .ok_or_else(|| format!("invalid config path: {}", path.display()))?;
    std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    let json = serde_json::to_string_pretty(config).map_err(|error| error.to_string())?;
    std::fs::write(&path, json).map_err(|error| error.to_string())
}

pub fn is_peer_paired(config: &AppConfig, peer_endpoint_id: &str) -> bool {
    config.libraries.iter().any(|library| {
        matches!(
            library,
            LibraryConfig::Peer(config) if config.peer_id == peer_endpoint_id
        )
    })
}

pub fn pair_peer(
    config: &mut AppConfig,
    peer_endpoint_id: &str,
    peer_name: Option<&str>,
) -> bool {
    let normalized_peer_name = peer_name
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .map(ToOwned::to_owned);
    for library in &mut config.libraries {
        let LibraryConfig::Peer(existing) = library else {
            continue;
        };
        if existing.peer_id != peer_endpoint_id {
            continue;
        }
        if normalized_peer_name.is_none() || existing.name == normalized_peer_name {
            return false;
        }
        existing.name = normalized_peer_name;
        return true;
    }
    upsert_library_config(
        &mut config.libraries,
        LibraryConfig::Peer(PeerLibraryConfig {
            peer_id: peer_endpoint_id.to_owned(),
            name: normalized_peer_name,
        }),
    );
    append_library_order_id(&mut config.library_order, peer_library_id(peer_endpoint_id));
    true
}

pub fn upsert_library_config(libraries: &mut Vec<LibraryConfig>, library: LibraryConfig) {
    let id = library_config_id(&library);
    match libraries
        .iter()
        .position(|existing| library_config_id(existing) == id)
    {
        Some(index) => libraries[index] = library,
        None => libraries.push(library),
    }
}

pub fn append_library_order_id(library_order: &mut Vec<String>, library_id: String) {
    if !library_order
        .iter()
        .any(|candidate| candidate == &library_id)
    {
        library_order.push(library_id);
    }
}

pub fn remove_library_order_id(library_order: &mut Vec<String>, library_id: &str) {
    library_order.retain(|candidate| candidate != library_id);
}

pub fn normalize_library_order(
    library_order: &mut Vec<String>,
    libraries: &[LibraryConfig],
) {
    library_order.retain(|library_id| library_id != PINNED_LIBRARY_ID);
    library_order.retain(|library_id| {
        libraries
            .iter()
            .any(|library| library_config_id(library) == *library_id)
    });
    library_order.insert(0, PINNED_LIBRARY_ID.to_string());
    for library in libraries {
        let library_id = library_config_id(library);
        if library_id == PINNED_LIBRARY_ID {
            continue;
        }
        append_library_order_id(library_order, library_id);
    }
}

fn migrate_app_config(config: PersistedAppConfig) -> AppConfig {
    let mut libraries = config.libraries;
    for directory in config.directories {
        upsert_library_config(
            &mut libraries,
            LibraryConfig::Local(LocalLibraryConfig { path: directory }),
        );
    }
    for s3_library in config.s3_libraries {
        upsert_library_config(&mut libraries, LibraryConfig::S3(s3_library));
    }
    for peer_id in config.paired_peers {
        upsert_library_config(
            &mut libraries,
            LibraryConfig::Peer(PeerLibraryConfig {
                peer_id,
                name: None,
            }),
        );
    }
    let mut library_order = if config.library_order.is_empty() {
        libraries.iter().map(library_config_id).collect::<Vec<_>>()
    } else {
        config.library_order
    };
    normalize_library_order(&mut library_order, &libraries);
    if library_order.first().map(String::as_str) != Some(PINNED_LIBRARY_ID) {
        library_order.insert(0, PINNED_LIBRARY_ID.to_string());
    }
    AppConfig {
        libraries,
        library_order,
        library_modes: config.library_modes,
        sync_targets: config.sync_targets,
        p2p_secret_key: config.p2p_secret_key,
    }
}
