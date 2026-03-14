use anyhow::Result;
use iroh::{
    address_lookup::{DiscoveryEvent, MdnsAddressLookup},
    endpoint_info::UserData,
    Endpoint, RelayMode,
};
use serde::Serialize;
use std::{collections::BTreeMap, sync::Arc};
use tokio::{
    sync::RwLock,
    task::JoinHandle,
};
use tokio_stream::StreamExt;

const SHADE_P2P_DISCOVERY_TAG: &str = "shade-p2p";

#[derive(Clone, Debug, Serialize)]
pub struct LocalPeer {
    pub endpoint_id: String,
    pub direct_addresses: Vec<String>,
    pub last_updated: Option<u64>,
}

#[derive(Clone, Debug, Serialize)]
pub struct LocalPeerDiscoverySnapshot {
    pub local_endpoint_id: String,
    pub local_direct_addresses: Vec<String>,
    pub peers: Vec<LocalPeer>,
}

pub struct LocalPeerDiscovery {
    endpoint: Endpoint,
    peers: Arc<RwLock<BTreeMap<String, LocalPeer>>>,
    event_task: JoinHandle<()>,
}

impl LocalPeerDiscovery {
    pub async fn bind() -> Result<Self> {
        let endpoint = Endpoint::empty_builder(RelayMode::Disabled)
            .bind()
            .await?;
        let mdns = MdnsAddressLookup::builder().build(endpoint.id())?;
        endpoint.address_lookup().add(mdns.clone());
        endpoint.set_user_data_for_address_lookup(Some(UserData::try_from(
            SHADE_P2P_DISCOVERY_TAG.to_owned(),
        )?));

        let peers = Arc::new(RwLock::new(BTreeMap::new()));
        let event_task = tokio::spawn(run_discovery_event_loop(mdns, Arc::clone(&peers)));

        Ok(Self {
            endpoint,
            peers,
            event_task,
        })
    }

    pub async fn snapshot(&self) -> LocalPeerDiscoverySnapshot {
        let peers = self.peers.read().await.values().cloned().collect();
        let local_direct_addresses = self
            .endpoint
            .addr()
            .ip_addrs()
            .map(|addr| addr.to_string())
            .collect();

        LocalPeerDiscoverySnapshot {
            local_endpoint_id: self.endpoint.id().to_string(),
            local_direct_addresses,
            peers,
        }
    }
}

impl Drop for LocalPeerDiscovery {
    fn drop(&mut self) {
        self.event_task.abort();
    }
}

async fn run_discovery_event_loop(
    mdns: MdnsAddressLookup,
    peers: Arc<RwLock<BTreeMap<String, LocalPeer>>>,
) {
    let mut events = mdns.subscribe().await;
    while let Some(event) = events.next().await {
        match event {
            DiscoveryEvent::Discovered {
                endpoint_info,
                last_updated,
            } => {
                match endpoint_info.data.user_data() {
                    Some(user_data) if user_data.as_ref() == SHADE_P2P_DISCOVERY_TAG => {}
                    _ => continue,
                }
                let endpoint_id = endpoint_info.endpoint_id.to_string();
                let direct_addresses = endpoint_info
                    .ip_addrs()
                    .map(|addr| addr.to_string())
                    .collect();
                peers.write().await.insert(
                    endpoint_id.clone(),
                    LocalPeer {
                        endpoint_id,
                        direct_addresses,
                        last_updated,
                    },
                );
            }
            DiscoveryEvent::Expired { endpoint_id } => {
                peers.write().await.remove(&endpoint_id.to_string());
            }
        }
    }
}
