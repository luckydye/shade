use anyhow::Result;
use async_trait::async_trait;
use iroh::{
    address_lookup::{DiscoveryEvent, MdnsAddressLookup},
    endpoint_info::UserData,
    endpoint::Connection,
    protocol::{AcceptError, ProtocolHandler, Router},
    Endpoint, EndpointId, RelayMode, SecretKey,
};
use serde::{Deserialize, Serialize};
use std::{collections::BTreeMap, sync::Arc};
use tokio::{
    sync::RwLock,
    task::JoinHandle,
};
use tokio_stream::StreamExt;

const SHADE_P2P_DISCOVERY_TAG: &str = "shade-p2p";
const SHADE_P2P_BROWSE_ALPN: &[u8] = b"/shade/p2p/browse/1";
const MAX_REQUEST_MESSAGE_BYTES: usize = 64 * 1024;
const MAX_THUMBNAIL_MESSAGE_BYTES: usize = 8 * 1024 * 1024;
const MAX_IMAGE_MESSAGE_BYTES: usize = 256 * 1024 * 1024;
const PEER_PICTURE_PAGE_SIZE: usize = 256;

#[async_trait]
pub trait MediaProvider: Send + Sync + 'static {
    async fn authorize_peer(&self, peer_endpoint_id: &str) -> Result<()>;
    async fn list_pictures(&self) -> Result<Vec<SharedPicture>>;
    async fn get_thumbnail(&self, picture_id: &str) -> Result<Vec<u8>>;
    async fn get_image_bytes(&self, picture_id: &str) -> Result<Vec<u8>>;
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SharedPicture {
    pub id: String,
    pub name: String,
    pub modified_at: Option<u64>,
}

#[derive(Debug, Serialize, Deserialize)]
enum BrowseRequest {
    ListPictures { offset: usize, limit: usize },
    GetThumbnail { picture_id: String },
    GetImageBytes { picture_id: String },
}

#[derive(Debug, Serialize, Deserialize)]
enum BrowseResponse {
    PicturesPage { pictures: Vec<SharedPicture>, has_more: bool },
    Thumbnail(Vec<u8>),
    ImageBytes(Vec<u8>),
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
        media_provider: Arc<dyn MediaProvider>,
    ) -> Result<Self> {
        let mut builder = Endpoint::empty_builder(RelayMode::Disabled);
        if let Some(secret_key) = secret_key {
            builder = builder.secret_key(secret_key);
        }
        let endpoint = builder.bind().await?;
        let mdns = MdnsAddressLookup::builder().build(endpoint.id())?;
        endpoint.address_lookup().add(mdns.clone());
        endpoint.set_user_data_for_address_lookup(Some(UserData::try_from(
            SHADE_P2P_DISCOVERY_TAG.to_owned(),
        )?));
        let router = Router::builder(endpoint.clone())
            .accept(
                SHADE_P2P_BROWSE_ALPN,
                BrowseProtocol {
                    media_provider: media_provider.clone(),
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

    pub async fn list_peer_pictures(&self, peer_endpoint_id: &str) -> Result<Vec<SharedPicture>> {
        let mut pictures = Vec::new();
        let mut offset = 0;
        loop {
            match self
                .send_request(
                    peer_endpoint_id,
                    BrowseRequest::ListPictures {
                        offset,
                        limit: PEER_PICTURE_PAGE_SIZE,
                    },
                    MAX_REQUEST_MESSAGE_BYTES,
                )
                .await?
            {
                BrowseResponse::PicturesPage { pictures: page, has_more } => {
                    offset += page.len();
                    pictures.extend(page);
                    if !has_more {
                        return Ok(pictures);
                    }
                }
                BrowseResponse::Error(message) => return Err(anyhow::anyhow!(message)),
                BrowseResponse::Thumbnail(_) => return Err(anyhow::anyhow!("received thumbnail response for picture list request")),
                BrowseResponse::ImageBytes(_) => return Err(anyhow::anyhow!("received image response for picture list request")),
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
                BrowseRequest::GetThumbnail {
                    picture_id: picture_id.to_owned(),
                },
                MAX_THUMBNAIL_MESSAGE_BYTES,
            )
            .await?
        {
            BrowseResponse::Thumbnail(bytes) => Ok(bytes),
            BrowseResponse::Error(message) => Err(anyhow::anyhow!(message)),
            BrowseResponse::PicturesPage { .. } => Err(anyhow::anyhow!("received picture list response for thumbnail request")),
            BrowseResponse::ImageBytes(_) => Err(anyhow::anyhow!("received image response for thumbnail request")),
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
                BrowseRequest::GetImageBytes {
                    picture_id: picture_id.to_owned(),
                },
                MAX_IMAGE_MESSAGE_BYTES,
            )
            .await?
        {
            BrowseResponse::ImageBytes(bytes) => Ok(bytes),
            BrowseResponse::Error(message) => Err(anyhow::anyhow!(message)),
            BrowseResponse::PicturesPage { .. } => Err(anyhow::anyhow!("received picture list response for image request")),
            BrowseResponse::Thumbnail(_) => Err(anyhow::anyhow!("received thumbnail response for image request")),
        }
    }

    async fn send_request(
        &self,
        peer_endpoint_id: &str,
        request: BrowseRequest,
        max_response_bytes: usize,
    ) -> Result<BrowseResponse> {
        let peer_endpoint_id = peer_endpoint_id.parse::<EndpointId>()?;
        let connection = self
            .endpoint
            .connect(peer_endpoint_id, SHADE_P2P_BROWSE_ALPN)
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

#[derive(Clone)]
struct BrowseProtocol {
    media_provider: Arc<dyn MediaProvider>,
}

impl std::fmt::Debug for BrowseProtocol {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("BrowseProtocol")
    }
}

impl ProtocolHandler for BrowseProtocol {
    async fn accept(&self, connection: Connection) -> Result<(), AcceptError> {
        let peer_endpoint_id = connection.remote_id().to_string();
        if let Err(error) = self.media_provider.authorize_peer(&peer_endpoint_id).await {
            let (mut send, _) = connection.accept_bi().await?;
            let response = serde_json::to_vec(&BrowseResponse::Error(error.to_string()))
                .map_err(AcceptError::from_err)?;
            send.write_all(&response).await.map_err(AcceptError::from_err)?;
            send.finish().map_err(AcceptError::from_err)?;
            connection.closed().await;
            return Ok(());
        }
        let (mut send, mut recv) = connection.accept_bi().await?;
        let request = recv
            .read_to_end(MAX_REQUEST_MESSAGE_BYTES)
            .await
            .map_err(AcceptError::from_err)?;
        let request = serde_json::from_slice::<BrowseRequest>(&request)
            .map_err(AcceptError::from_err)?;
        let response = match request {
            BrowseRequest::ListPictures { offset, limit } => match self.media_provider.list_pictures().await {
                Ok(pictures) => {
                    let total = pictures.len();
                    let page = pictures.into_iter().skip(offset).take(limit).collect();
                    BrowseResponse::PicturesPage {
                        pictures: page,
                        has_more: offset.saturating_add(limit) < total,
                    }
                }
                Err(error) => BrowseResponse::Error(error.to_string()),
            },
            BrowseRequest::GetThumbnail { picture_id } => {
                match self.media_provider.get_thumbnail(&picture_id).await {
                    Ok(bytes) => BrowseResponse::Thumbnail(bytes),
                    Err(error) => BrowseResponse::Error(error.to_string()),
                }
            }
            BrowseRequest::GetImageBytes { picture_id } => {
                match self.media_provider.get_image_bytes(&picture_id).await {
                    Ok(bytes) => BrowseResponse::ImageBytes(bytes),
                    Err(error) => BrowseResponse::Error(error.to_string()),
                }
            }
        };
        let response = serde_json::to_vec(&response).map_err(AcceptError::from_err)?;
        send.write_all(&response).await.map_err(AcceptError::from_err)?;
        send.finish().map_err(AcceptError::from_err)?;
        connection.closed().await;
        Ok(())
    }
}
