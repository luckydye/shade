use crate::{
    display_s3_library_name, library_config_id, LibraryConfig, LocalLibraryConfig,
    PeerLibraryConfig, S3LibraryConfig,
};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Serialize, Deserialize, Debug, Default, Clone)]
#[serde(default)]
pub struct AppConfig {
    pub libraries: Vec<LibraryConfig>,
    pub p2p_secret_key: Option<[u8; 32]>,
}

#[derive(Deserialize, Debug, Default)]
#[serde(default)]
struct PersistedAppConfig {
    libraries: Vec<LibraryConfig>,
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

pub fn pair_peer(config: &mut AppConfig, peer_endpoint_id: &str) {
    if is_peer_paired(config, peer_endpoint_id) {
        return;
    }
    upsert_library_config(
        &mut config.libraries,
        LibraryConfig::Peer(PeerLibraryConfig {
            peer_id: peer_endpoint_id.to_owned(),
        }),
    );
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
    libraries.sort_by_key(library_sort_key);
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
            LibraryConfig::Peer(PeerLibraryConfig { peer_id }),
        );
    }
    AppConfig {
        libraries,
        p2p_secret_key: config.p2p_secret_key,
    }
}

fn library_sort_key(library: &LibraryConfig) -> (u8, String) {
    match library {
        LibraryConfig::Local(config) => (0, config.path.clone()),
        LibraryConfig::S3(config) => (1, display_s3_library_name(config)),
        LibraryConfig::Camera(config) => (2, config.host.clone()),
        LibraryConfig::Peer(config) => (3, config.peer_id.clone()),
    }
}
