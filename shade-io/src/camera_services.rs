use std::collections::HashMap;
use std::sync::Arc;

pub struct CameraDiscoveryService {
    pub hosts: tokio::sync::RwLock<Vec<String>>,
}

impl CameraDiscoveryService {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            hosts: tokio::sync::RwLock::new(Vec::new()),
        })
    }

    pub async fn snapshot(&self) -> Vec<String> {
        self.hosts.read().await.clone()
    }

    pub async fn replace_hosts(&self, hosts: Vec<String>) {
        *self.hosts.write().await = hosts;
    }
}

pub struct CameraThumbnailService {
    pub semaphores: tokio::sync::Mutex<HashMap<String, Arc<tokio::sync::Semaphore>>>,
}

impl CameraThumbnailService {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            semaphores: tokio::sync::Mutex::new(HashMap::new()),
        })
    }

    pub async fn acquire(
        &self,
        host: &str,
    ) -> Result<tokio::sync::OwnedSemaphorePermit, String> {
        let semaphore = {
            let mut semaphores = self.semaphores.lock().await;
            semaphores
                .entry(host.to_string())
                .or_insert_with(|| Arc::new(tokio::sync::Semaphore::new(1)))
                .clone()
        };
        semaphore
            .acquire_owned()
            .await
            .map_err(|_| format!("camera thumbnail throttler closed for {host}"))
    }
}
