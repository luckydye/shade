#[cfg(target_os = "android")]
use serde::Deserialize;
use tauri::{plugin::Builder, Runtime};

#[cfg(target_os = "android")]
#[derive(Deserialize)]
struct ListResult {
    uris: Vec<String>,
}

#[cfg(target_os = "android")]
#[derive(Deserialize)]
struct BytesResult {
    bytes: Vec<u8>,
}

/// Stored in app state on Android; wraps the registered PluginHandle for PhotosPlugin.
#[cfg(target_os = "android")]
pub struct PhotosHandle<R: Runtime>(tauri::plugin::PluginHandle<R>);

#[cfg(target_os = "android")]
impl<R: Runtime> PhotosHandle<R> {
    pub async fn list_photos(&self) -> Result<Vec<String>, String> {
        let r: ListResult = self
            .0
            .run_mobile_plugin_async("listPhotos", ())
            .await
            .map_err(|e| e.to_string())?;
        Ok(r.uris)
    }

    pub async fn get_thumbnail(&self, uri: &str) -> Result<Vec<u8>, String> {
        #[derive(serde::Serialize)]
        struct Args<'a> {
            uri: &'a str,
        }
        let r: BytesResult = self
            .0
            .run_mobile_plugin_async("getThumbnail", Args { uri })
            .await
            .map_err(|e| e.to_string())?;
        Ok(r.bytes)
    }

    pub async fn get_image_data(&self, uri: &str) -> Result<Vec<u8>, String> {
        #[derive(serde::Serialize)]
        struct Args<'a> {
            uri: &'a str,
        }
        let r: BytesResult = self
            .0
            .run_mobile_plugin_async("getImageData", Args { uri })
            .await
            .map_err(|e| e.to_string())?;
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
