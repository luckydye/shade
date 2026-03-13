use serde::{Deserialize, Serialize};
use tauri::{plugin::Builder, Runtime};

#[derive(Deserialize)]
pub struct ListResult {
    pub uris: Vec<String>,
}

#[derive(Deserialize)]
pub struct BytesResult {
    pub bytes: Vec<u8>,
}

/// Stored in app state on Android; used by commands to call into the Kotlin PhotosPlugin.
#[cfg(target_os = "android")]
pub struct PhotosHandle<R: Runtime>(tauri::plugin::PluginHandle<R>);

#[cfg(target_os = "android")]
impl<R: Runtime> PhotosHandle<R> {
    pub async fn list_photos(&self) -> Result<Vec<String>, String> {
        let (tx, rx) = tokio::sync::oneshot::channel();
        self.0
            .run("listPhotos", (), move |resp| {
                let _ = tx.send(resp);
            })
            .map_err(|e| e.to_string())?;
        let resp = rx.await.map_err(|_| "channel closed".to_string())?;
        if !resp.success {
            return Err(resp.payload.to_string());
        }
        let r: ListResult = serde_json::from_value(resp.payload).map_err(|e| e.to_string())?;
        Ok(r.uris)
    }

    pub async fn get_thumbnail(&self, uri: &str) -> Result<Vec<u8>, String> {
        #[derive(Serialize)]
        struct Args<'a> {
            uri: &'a str,
        }
        let (tx, rx) = tokio::sync::oneshot::channel();
        self.0
            .run("getThumbnail", Args { uri }, move |resp| {
                let _ = tx.send(resp);
            })
            .map_err(|e| e.to_string())?;
        let resp = rx.await.map_err(|_| "channel closed".to_string())?;
        if !resp.success {
            return Err(resp.payload.to_string());
        }
        let r: BytesResult = serde_json::from_value(resp.payload).map_err(|e| e.to_string())?;
        Ok(r.bytes)
    }

    pub async fn get_image_data(&self, uri: &str) -> Result<Vec<u8>, String> {
        #[derive(Serialize)]
        struct Args<'a> {
            uri: &'a str,
        }
        let (tx, rx) = tokio::sync::oneshot::channel();
        self.0
            .run("getImageData", Args { uri }, move |resp| {
                let _ = tx.send(resp);
            })
            .map_err(|e| e.to_string())?;
        let resp = rx.await.map_err(|_| "channel closed".to_string())?;
        if !resp.success {
            return Err(resp.payload.to_string());
        }
        let r: BytesResult = serde_json::from_value(resp.payload).map_err(|e| e.to_string())?;
        Ok(r.bytes)
    }
}

pub fn init<R: Runtime>() -> tauri::plugin::TauriPlugin<R> {
    Builder::new("photos")
        .setup(|_app, _api| {
            #[cfg(target_os = "android")]
            {
                let handle =
                    _api.register_android_plugin("com.shade.editor", "PhotosPlugin")?;
                _app.manage(PhotosHandle(handle));
            }
            Ok(())
        })
        .build()
}
