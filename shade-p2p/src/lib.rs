use anyhow::Result;
use async_trait::async_trait;
use iroh::{
    address_lookup::{DiscoveryEvent, MdnsAddressLookup},
    endpoint::Connection,
    endpoint_info::UserData,
    protocol::{AcceptError, ProtocolHandler, Router},
    Endpoint, EndpointId, RelayMode, SecretKey,
};
use serde::{Deserialize, Serialize};
use std::{collections::BTreeMap, sync::Arc};
use tokio::{sync::RwLock, task::JoinHandle};
use tokio_stream::StreamExt;

const SHADE_P2P_DISCOVERY_TAG: &str = "shade-p2p";
const SHADE_P2P_ALPN: &[u8] = b"/shade/p2p/1";
const MAX_REQUEST_MESSAGE_BYTES: usize = 64 * 1024;
const MAX_THUMBNAIL_MESSAGE_BYTES: usize = 8 * 1024 * 1024;
const MAX_IMAGE_MESSAGE_BYTES: usize = 256 * 1024 * 1024;
const MAX_SNAPSHOT_MESSAGE_BYTES: usize = 1024 * 1024;
const PEER_PICTURE_PAGE_SIZE: usize = 256;

/// Ephemeral presence state for a peer. Never persisted.
#[derive(Clone, Debug, Serialize, Deserialize, Default)]
pub struct AwarenessState {
    pub display_name: Option<String>,
    pub active_file_hash: Option<String>,
    pub active_snapshot_id: Option<String>,
}

/// Lightweight snapshot descriptor used for sync diffing.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SyncSnapshotInfo {
    pub id: String,
    pub created_at: i64,
}

/// Metadata for a picture, used for batch sync of ratings and tags.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct PictureMetadata {
    pub file_hash: String,
    pub rating: Option<u8>,
    pub tags: Vec<String>,
    pub rating_updated_at: Option<i64>,
    pub tags_updated_at: Option<i64>,
}

#[async_trait]
pub trait PeerProvider: Send + Sync + 'static {
    /// Called on every incoming connection before any request is handled.
    /// Triggers the pairing dialog for unknown peers.
    async fn authorize_peer(&self, peer_endpoint_id: &str) -> Result<()>;

    async fn list_pictures(&self) -> Result<Vec<SharedPicture>>;
    async fn get_thumbnail(&self, picture_id: &str) -> Result<Vec<u8>>;
    async fn get_image_bytes(&self, picture_id: &str) -> Result<Vec<u8>>;

    async fn get_awareness(&self) -> Result<AwarenessState>;
    async fn list_snapshots(&self, file_hash: &str) -> Result<Vec<SyncSnapshotInfo>>;
    async fn get_snapshot_data(&self, id: &str) -> Result<Vec<u8>>;
    async fn get_metadata(&self, file_hashes: &[String]) -> Result<Vec<PictureMetadata>>;
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SharedPicture {
    pub id: String,
    pub name: String,
    pub modified_at: Option<u64>,
}

#[derive(Debug, Serialize, Deserialize)]
enum Request {
    // browsing
    ListPictures { offset: usize, limit: usize },
    GetThumbnail { picture_id: String },
    GetImageBytes { picture_id: String },
    // presence
    GetAwareness,
    // snapshot sync
    ListSnapshots { file_hash: String },
    GetSnapshotData { id: String },
    // metadata sync
    GetMetadata { file_hashes: Vec<String> },
}

#[derive(Debug, Serialize, Deserialize)]
enum Response {
    // browsing
    PicturesPage {
        pictures: Vec<SharedPicture>,
        has_more: bool,
    },
    Thumbnail(Vec<u8>),
    ImageBytes(Vec<u8>),
    // presence
    Awareness(AwarenessState),
    // snapshot sync
    SnapshotList(Vec<SyncSnapshotInfo>),
    SnapshotData(Vec<u8>),
    // metadata sync
    Metadata(Vec<PictureMetadata>),
    Error(String),
}

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
    router: Router,
    peers: Arc<RwLock<BTreeMap<String, LocalPeer>>>,
    event_task: JoinHandle<()>,
}

impl LocalPeerDiscovery {
    pub async fn bind(
        secret_key: Option<SecretKey>,
        peer_provider: Arc<dyn PeerProvider>,
    ) -> Result<Self> {
        let mut builder = Endpoint::empty_builder(RelayMode::Disabled);
        if let Some(secret_key) = secret_key {
            builder = builder.secret_key(secret_key);
        }
        builder = builder.user_data_for_address_lookup(UserData::try_from(
            SHADE_P2P_DISCOVERY_TAG.to_owned(),
        )?);
        let endpoint = builder.bind().await?;
        let mdns = MdnsAddressLookup::builder().build(endpoint.id())?;
        endpoint.address_lookup().add(mdns.clone());
        let router = Router::builder(endpoint.clone())
            .accept(
                SHADE_P2P_ALPN,
                ShadeProtocol {
                    peer_provider: peer_provider.clone(),
                },
            )
            .spawn();

        let peers = Arc::new(RwLock::new(BTreeMap::new()));
        let event_task = tokio::spawn(run_discovery_event_loop(mdns, Arc::clone(&peers)));

        Ok(Self {
            endpoint,
            router,
            peers,
            event_task,
        })
    }

    pub fn secret_key_bytes(&self) -> [u8; 32] {
        self.endpoint.secret_key().to_bytes()
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

    // ── browsing ─────────────────────────────────────────────────────────────

    pub async fn list_peer_pictures(
        &self,
        peer_endpoint_id: &str,
    ) -> Result<Vec<SharedPicture>> {
        let mut pictures = Vec::new();
        let mut offset = 0;
        loop {
            match self
                .send_request(
                    peer_endpoint_id,
                    Request::ListPictures {
                        offset,
                        limit: PEER_PICTURE_PAGE_SIZE,
                    },
                    MAX_REQUEST_MESSAGE_BYTES,
                )
                .await?
            {
                Response::PicturesPage {
                    pictures: page,
                    has_more,
                } => {
                    offset += page.len();
                    pictures.extend(page);
                    if !has_more {
                        return Ok(pictures);
                    }
                }
                Response::Error(message) => return Err(anyhow::anyhow!(message)),
                _ => return Err(anyhow::anyhow!("unexpected response for ListPictures")),
            }
        }
    }

    pub async fn get_peer_thumbnail(
        &self,
        peer_endpoint_id: &str,
        picture_id: &str,
    ) -> Result<Vec<u8>> {
        match self
            .send_request(
                peer_endpoint_id,
                Request::GetThumbnail {
                    picture_id: picture_id.to_owned(),
                },
                MAX_THUMBNAIL_MESSAGE_BYTES,
            )
            .await?
        {
            Response::Thumbnail(bytes) => Ok(bytes),
            Response::Error(message) => Err(anyhow::anyhow!(message)),
            _ => Err(anyhow::anyhow!("unexpected response for GetThumbnail")),
        }
    }

    pub async fn get_peer_image_bytes(
        &self,
        peer_endpoint_id: &str,
        picture_id: &str,
    ) -> Result<Vec<u8>> {
        match self
            .send_request(
                peer_endpoint_id,
                Request::GetImageBytes {
                    picture_id: picture_id.to_owned(),
                },
                MAX_IMAGE_MESSAGE_BYTES,
            )
            .await?
        {
            Response::ImageBytes(bytes) => Ok(bytes),
            Response::Error(message) => Err(anyhow::anyhow!(message)),
            _ => Err(anyhow::anyhow!("unexpected response for GetImageBytes")),
        }
    }

    // ── presence ─────────────────────────────────────────────────────────────

    pub async fn get_peer_awareness(
        &self,
        peer_endpoint_id: &str,
    ) -> Result<AwarenessState> {
        match self
            .send_request(
                peer_endpoint_id,
                Request::GetAwareness,
                MAX_REQUEST_MESSAGE_BYTES,
            )
            .await?
        {
            Response::Awareness(state) => Ok(state),
            Response::Error(message) => Err(anyhow::anyhow!(message)),
            _ => Err(anyhow::anyhow!("unexpected response for GetAwareness")),
        }
    }

    // ── snapshot sync ─────────────────────────────────────────────────────────

    pub async fn list_peer_snapshots(
        &self,
        peer_endpoint_id: &str,
        file_hash: &str,
    ) -> Result<Vec<SyncSnapshotInfo>> {
        match self
            .send_request(
                peer_endpoint_id,
                Request::ListSnapshots {
                    file_hash: file_hash.to_owned(),
                },
                MAX_REQUEST_MESSAGE_BYTES,
            )
            .await?
        {
            Response::SnapshotList(list) => Ok(list),
            Response::Error(message) => Err(anyhow::anyhow!(message)),
            _ => Err(anyhow::anyhow!("unexpected response for ListSnapshots")),
        }
    }

    pub async fn get_peer_snapshot_data(
        &self,
        peer_endpoint_id: &str,
        id: &str,
    ) -> Result<Vec<u8>> {
        match self
            .send_request(
                peer_endpoint_id,
                Request::GetSnapshotData { id: id.to_owned() },
                MAX_SNAPSHOT_MESSAGE_BYTES,
            )
            .await?
        {
            Response::SnapshotData(data) => Ok(data),
            Response::Error(message) => Err(anyhow::anyhow!(message)),
            _ => Err(anyhow::anyhow!("unexpected response for GetSnapshotData")),
        }
    }

    // ── metadata sync ─────────────────────────────────────────────────────────

    pub async fn get_peer_metadata(
        &self,
        peer_endpoint_id: &str,
        file_hashes: &[String],
    ) -> Result<Vec<PictureMetadata>> {
        match self
            .send_request(
                peer_endpoint_id,
                Request::GetMetadata {
                    file_hashes: file_hashes.to_vec(),
                },
                MAX_REQUEST_MESSAGE_BYTES,
            )
            .await?
        {
            Response::Metadata(meta) => Ok(meta),
            Response::Error(message) => Err(anyhow::anyhow!(message)),
            _ => Err(anyhow::anyhow!("unexpected response for GetMetadata")),
        }
    }

    // ── internal ──────────────────────────────────────────────────────────────

    async fn send_request(
        &self,
        peer_endpoint_id: &str,
        request: Request,
        max_response_bytes: usize,
    ) -> Result<Response> {
        let peer_endpoint_id = peer_endpoint_id.parse::<EndpointId>()?;
        let connection = self
            .endpoint
            .connect(peer_endpoint_id, SHADE_P2P_ALPN)
            .await?;
        let (mut send, mut recv) = connection.open_bi().await?;
        let request = serde_json::to_vec(&request)?;
        send.write_all(&request).await?;
        send.finish()?;
        let response = recv.read_to_end(max_response_bytes).await?;
        connection.close(0u32.into(), b"done");
        Ok(serde_json::from_slice(&response)?)
    }
}

impl Drop for LocalPeerDiscovery {
    fn drop(&mut self) {
        self.event_task.abort();
        let router = self.router.clone();
        tokio::spawn(async move {
            let _ = router.shutdown().await;
        });
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

#[derive(Clone)]
struct ShadeProtocol {
    peer_provider: Arc<dyn PeerProvider>,
}

impl std::fmt::Debug for ShadeProtocol {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("ShadeProtocol")
    }
}

impl ProtocolHandler for ShadeProtocol {
    async fn accept(&self, connection: Connection) -> Result<(), AcceptError> {
        let peer_endpoint_id = connection.remote_id().to_string();
        if let Err(error) = self.peer_provider.authorize_peer(&peer_endpoint_id).await {
            let (mut send, _) = connection.accept_bi().await?;
            let response = serde_json::to_vec(&Response::Error(error.to_string()))
                .map_err(AcceptError::from_err)?;
            send.write_all(&response)
                .await
                .map_err(AcceptError::from_err)?;
            send.finish().map_err(AcceptError::from_err)?;
            connection.closed().await;
            return Ok(());
        }
        let (mut send, mut recv) = connection.accept_bi().await?;
        let request = recv
            .read_to_end(MAX_REQUEST_MESSAGE_BYTES)
            .await
            .map_err(AcceptError::from_err)?;
        let request = serde_json::from_slice::<Request>(&request)
            .map_err(AcceptError::from_err)?;
        let response = match request {
            Request::ListPictures { offset, limit } => {
                match self.peer_provider.list_pictures().await {
                    Ok(pictures) => {
                        let total = pictures.len();
                        let page = pictures.into_iter().skip(offset).take(limit).collect();
                        Response::PicturesPage {
                            pictures: page,
                            has_more: offset.saturating_add(limit) < total,
                        }
                    }
                    Err(error) => Response::Error(error.to_string()),
                }
            }
            Request::GetThumbnail { picture_id } => {
                match self.peer_provider.get_thumbnail(&picture_id).await {
                    Ok(bytes) => Response::Thumbnail(bytes),
                    Err(error) => Response::Error(error.to_string()),
                }
            }
            Request::GetImageBytes { picture_id } => {
                match self.peer_provider.get_image_bytes(&picture_id).await {
                    Ok(bytes) => Response::ImageBytes(bytes),
                    Err(error) => Response::Error(error.to_string()),
                }
            }
            Request::GetAwareness => match self.peer_provider.get_awareness().await {
                Ok(state) => Response::Awareness(state),
                Err(error) => Response::Error(error.to_string()),
            },
            Request::ListSnapshots { file_hash } => {
                match self.peer_provider.list_snapshots(&file_hash).await {
                    Ok(list) => Response::SnapshotList(list),
                    Err(error) => Response::Error(error.to_string()),
                }
            }
            Request::GetSnapshotData { id } => {
                match self.peer_provider.get_snapshot_data(&id).await {
                    Ok(data) => Response::SnapshotData(data),
                    Err(error) => Response::Error(error.to_string()),
                }
            }
            Request::GetMetadata { file_hashes } => {
                match self.peer_provider.get_metadata(&file_hashes).await {
                    Ok(meta) => Response::Metadata(meta),
                    Err(error) => Response::Error(error.to_string()),
                }
            }
        };
        let response = serde_json::to_vec(&response).map_err(AcceptError::from_err)?;
        send.write_all(&response)
            .await
            .map_err(AcceptError::from_err)?;
        send.finish().map_err(AcceptError::from_err)?;
        connection.closed().await;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};
    use tokio::time::{sleep, timeout, Duration};

    static NEXT_PEER_ID: AtomicU64 = AtomicU64::new(1);

    struct TestPeerProvider {
        id: u64,
    }

    impl TestPeerProvider {
        fn new() -> Self {
            Self {
                id: NEXT_PEER_ID.fetch_add(1, Ordering::Relaxed),
            }
        }
    }

    #[async_trait]
    impl PeerProvider for TestPeerProvider {
        async fn authorize_peer(&self, _peer_endpoint_id: &str) -> Result<()> {
            Ok(())
        }

        async fn list_pictures(&self) -> Result<Vec<SharedPicture>> {
            let _ = self.id;
            Ok(Vec::new())
        }

        async fn get_thumbnail(&self, _picture_id: &str) -> Result<Vec<u8>> {
            Ok(Vec::new())
        }

        async fn get_image_bytes(&self, _picture_id: &str) -> Result<Vec<u8>> {
            Ok(Vec::new())
        }

        async fn get_awareness(&self) -> Result<AwarenessState> {
            Ok(AwarenessState::default())
        }

        async fn list_snapshots(&self, _file_hash: &str) -> Result<Vec<SyncSnapshotInfo>> {
            Ok(Vec::new())
        }

        async fn get_snapshot_data(&self, _id: &str) -> Result<Vec<u8>> {
            Ok(Vec::new())
        }

        async fn get_metadata(&self, _file_hashes: &[String]) -> Result<Vec<PictureMetadata>> {
            Ok(Vec::new())
        }
    }

    async fn wait_for_peer(
        discovery: &LocalPeerDiscovery,
        expected_peer_id: &str,
    ) -> Result<()> {
        timeout(Duration::from_secs(15), async {
            loop {
                let snapshot = discovery.snapshot().await;
                if snapshot
                    .peers
                    .iter()
                    .any(|peer| peer.endpoint_id == expected_peer_id)
                {
                    return Ok(());
                }
                sleep(Duration::from_millis(100)).await;
            }
        })
        .await
        .map_err(|_| anyhow::anyhow!("timed out waiting for peer discovery"))?
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn two_local_instances_discover_each_other() -> Result<()> {
        let a = LocalPeerDiscovery::bind(None, Arc::new(TestPeerProvider::new())).await?;
        let b = LocalPeerDiscovery::bind(None, Arc::new(TestPeerProvider::new())).await?;

        let a_id = a.snapshot().await.local_endpoint_id;
        let b_id = b.snapshot().await.local_endpoint_id;
        assert_ne!(a_id, b_id);

        wait_for_peer(&a, &b_id).await?;
        wait_for_peer(&b, &a_id).await?;

        Ok(())
    }
}
