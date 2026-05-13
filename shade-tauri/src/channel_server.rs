//! Coordination channel server: stores the active frontend channel handle and
//! exposes lightweight send helpers used by background workers.
//!
//! Workers never panic if the frontend has reloaded — `send` is a no-op when no
//! channel is registered.

use std::sync::Arc;

use tauri::ipc::Channel;
use tokio::sync::RwLock;

use crate::channel_protocol::ChannelMessage;

#[derive(Default)]
pub struct CoordinationChannel {
    inner: RwLock<Option<Channel<ChannelMessage>>>,
}

impl CoordinationChannel {
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    pub async fn register(&self, channel: Channel<ChannelMessage>) {
        *self.inner.write().await = Some(channel);
    }

    /// Fire-and-forget send. Failures (no channel registered, JS reloaded) are
    /// swallowed by design — coordination messages are not load-bearing.
    pub async fn send(&self, msg: ChannelMessage) {
        if let Some(ch) = self.inner.read().await.as_ref() {
            let _ = ch.send(msg);
        }
    }

    /// Blocking variant for synchronous worker contexts (e.g. callbacks invoked
    /// from non-async code). Uses a short-lived tokio runtime handle if
    /// available; otherwise the message is dropped.
    pub fn send_blocking(self: &Arc<Self>, msg: ChannelMessage) {
        let this = self.clone();
        if let Ok(handle) = tokio::runtime::Handle::try_current() {
            handle.spawn(async move {
                this.send(msg).await;
            });
        }
    }
}

pub struct CoordinationChannelService(pub Arc<CoordinationChannel>);

#[tauri::command]
pub async fn register_coordination_channel(
    channel: Channel<ChannelMessage>,
    service: tauri::State<'_, CoordinationChannelService>,
) -> Result<(), String> {
    service.0.register(channel).await;
    Ok(())
}

/// Helper for callsites that already have an `AppHandle` — pulls the
/// coordination channel out of state.
pub fn channel_from_app<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
) -> Arc<CoordinationChannel> {
    use tauri::Manager;
    app.state::<CoordinationChannelService>().0.clone()
}
