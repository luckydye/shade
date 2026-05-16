//! Preview channel: dedicated `Channel<PreviewFrame>` for pushing pixel frames
//! from Rust to the frontend.
//!
//! Separate from the coordination channel so that frame size and volume cannot
//! affect coordination message latency. This is the only IPC path that carries
//! binary pixel data (other than the `shade://` custom protocol used for
//! thumbnails).

use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tauri::ipc::{Channel, InvokeResponseBody};
use tokio::sync::RwLock;

use crate::channel_protocol::PreviewQuality;

#[derive(Serialize, Deserialize, Clone, Copy, Debug)]
#[serde(rename_all = "snake_case")]
pub enum PreviewFrameKind {
    Rgba,
    RgbaFloat16,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug)]
#[serde(rename_all = "snake_case")]
pub enum PreviewColorSpace {
    Srgb,
    DisplayP3,
}

#[derive(Clone, Debug)]
pub struct PreviewFrame {
    pub artboard_id: String,
    pub generation: u64,
    pub quality: PreviewQuality,
    pub width: u32,
    pub height: u32,
    pub crop_x: f64,
    pub crop_y: f64,
    pub crop_width: f64,
    pub crop_height: f64,
    pub kind: PreviewFrameKind,
    pub color_space: PreviewColorSpace,
    pub pixels: Vec<u8>,
}

impl tauri::ipc::IpcResponse for PreviewFrame {
    fn body(self) -> tauri::Result<InvokeResponseBody> {
        // Pack header JSON + raw pixel bytes into a single Response. The
        // frontend reads metadata from headers and the pixel buffer from the
        // body.
        #[derive(Serialize)]
        struct Header<'a> {
            artboard_id: &'a str,
            generation: u64,
            quality: PreviewQuality,
            width: u32,
            height: u32,
            crop_x: f64,
            crop_y: f64,
            crop_width: f64,
            crop_height: f64,
            kind: PreviewFrameKind,
            color_space: PreviewColorSpace,
        }
        let header = Header {
            artboard_id: &self.artboard_id,
            generation: self.generation,
            quality: self.quality,
            width: self.width,
            height: self.height,
            crop_x: self.crop_x,
            crop_y: self.crop_y,
            crop_width: self.crop_width,
            crop_height: self.crop_height,
            kind: self.kind,
            color_space: self.color_space,
        };
        let header_json = serde_json::to_vec(&header)
            .map_err(|e| tauri::Error::Anyhow(anyhow::anyhow!(e)))?;
        let header_len = (header_json.len() as u32).to_le_bytes();
        let mut packed = Vec::with_capacity(4 + header_json.len() + self.pixels.len());
        packed.extend_from_slice(&header_len);
        packed.extend_from_slice(&header_json);
        packed.extend_from_slice(&self.pixels);
        Ok(InvokeResponseBody::Raw(packed))
    }
}

#[derive(Default)]
pub struct PreviewChannel {
    inner: RwLock<Option<Channel<PreviewFrame>>>,
}

impl PreviewChannel {
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    pub async fn register(&self, channel: Channel<PreviewFrame>) {
        *self.inner.write().await = Some(channel);
    }

    pub async fn send(&self, frame: PreviewFrame) {
        if let Some(ch) = self.inner.read().await.as_ref() {
            let _ = ch.send(frame);
        }
    }
}

pub struct PreviewChannelService(pub Arc<PreviewChannel>);

#[tauri::command]
pub async fn register_preview_channel(
    channel: Channel<PreviewFrame>,
    service: tauri::State<'_, PreviewChannelService>,
) -> Result<(), String> {
    service.0.register(channel).await;
    Ok(())
}
