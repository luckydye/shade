use std::collections::HashMap;
use crate::media_libraries::MediaLibrary;
use crate::paths::app_config_dir;


pub(crate) fn load_app_config() -> Result<shade_io::AppConfig, String> {
    shade_io::load_app_config(&app_config_dir()?)
}
pub(crate) fn save_app_config(config: &shade_io::AppConfig) -> Result<(), String> {
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
pub(crate) fn is_peer_paired(peer_endpoint_id: &str) -> Result<bool, String> {
    Ok(shade_io::is_peer_paired(
        &load_app_config()?,
        peer_endpoint_id,
    ))
}
pub(crate) fn pair_peer(peer_endpoint_id: &str, peer_name: Option<&str>) -> Result<(), String> {
    let mut config = load_app_config()?;
    if !shade_io::pair_peer(&mut config, peer_endpoint_id, peer_name) {
        return Ok(());
    }
    save_app_config(&config)
}
pub(crate) fn sync_persisted_peer_names(
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
pub(crate) fn emit_peer_paired<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    peer_endpoint_id: &str,
) -> Result<(), String> {
    crate::channel_server::channel_from_app(app).send_blocking(
        crate::ChannelMessage::PeerPaired {
            peer_id: peer_endpoint_id.to_owned(),
            name: String::new(),
        },
    );
    Ok(())
}
pub(crate) fn set_library_order(library_order: Vec<String>) -> Result<(), String> {
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
pub(crate) fn ordered_library_entries(
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
