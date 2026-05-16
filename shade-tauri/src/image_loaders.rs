use crate::media_libraries::{
    collect_images_in_directory, resolve_s3_library_config,
    resolve_s3_library_for_media_path, s3_library_id,
};
use crate::media_metadata::import_xmp_rating;
use crate::paths::{default_pictures_dir, library_sync_dir};
use crate::render::render_snapshot_thumbnail_bytes;
use crate::snapshots::{latest_snapshot_created_at, register_image_source};
use shade_io::{
    load_image_bytes, load_image_bytes_f32_with_info, picture_display_name,
    SourceImageInfo,
};
use shade_lib::FloatImage;
use std::panic::{catch_unwind, AssertUnwindSafe};
use tauri::Manager;

#[cfg(target_os = "ios")]
extern "C" {
    fn ios_list_photos() -> *mut std::os::raw::c_char;
    fn ios_get_thumbnail(
        identifier: *const std::os::raw::c_char,
        width: i32,
        height: i32,
        out_size: *mut i32,
    ) -> *mut u8;
    fn ios_get_image_data(
        identifier: *const std::os::raw::c_char,
        out_size: *mut i32,
    ) -> *mut u8;
    fn ios_free_buffer(ptr: *mut u8);
    fn ios_free_string(ptr: *mut std::os::raw::c_char);
}
#[cfg(target_os = "ios")]
#[derive(Deserialize)]
pub(crate) struct IosPhotoEntry {
    pub(crate) id: String,
    pub(crate) modified_at: Option<u64>,
}
pub(crate) fn panic_payload_message(payload: Box<dyn std::any::Any + Send>) -> String {
    match payload.downcast::<String>() {
        Ok(message) => *message,
        Err(payload) => match payload.downcast::<&'static str>() {
            Ok(message) => (*message).to_string(),
            Err(_) => "panic without message".to_string(),
        },
    }
}
pub(crate) fn decode_image_bytes_with_info(
    bytes: &[u8],
    name_hint: Option<&str>,
) -> Result<(FloatImage, SourceImageInfo), String> {
    catch_unwind(AssertUnwindSafe(|| {
        load_image_bytes_f32_with_info(bytes, name_hint)
    }))
    .map_err(|payload| {
        format!("image decode panicked: {}", panic_payload_message(payload))
    })?
    .map_err(|e| e.to_string())
}
pub(crate) fn open_local_image_sync(path: &str) -> Result<shade_io::OpenedImage, String> {
    let source = std::path::Path::new(path);
    let (image, info) =
        shade_io::load_image_f32_with_info(source).map_err(|e| e.to_string())?;
    Ok(shade_io::OpenedImage {
        fingerprint: shade_io::fingerprint_local(source)
            .map_err(|error| error.to_string())?
            .fingerprint
            .to_hex(),
        source_name: Some(path.to_string()),
        image,
        info,
    })
}
pub(crate) async fn load_camera_thumbnail_from_tauri<R: tauri::Runtime>(
    _app: &tauri::AppHandle<R>,
    host: &str,
    file_path: &str,
) -> Result<Vec<u8>, String> {
    let _permit = _app
        .state::<crate::CameraThumbnailService>()
        .0
        .acquire(host)
        .await?;
    shade_io::ccapi::CCAPI::new(host)
        .thumbnail(file_path)
        .await
        .map(|bytes| bytes.to_vec())
        .map_err(|error| error.to_string())
}
pub(crate) async fn load_s3_thumbnail_from_tauri(
    picture_id: &str,
) -> Result<Vec<u8>, String> {
    let (config, key) = resolve_s3_library_for_media_path(picture_id)?;
    let library_id = s3_library_id(&config.id);
    let sync_dir = library_sync_dir(&library_id)?;
    let file_name = std::path::Path::new(&key)
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| key.clone());
    let local_path = sync_dir.join(&file_name);
    let bytes = if local_path.is_file() {
        std::fs::read(&local_path).map_err(|e| e.to_string())?
    } else {
        shade_io::get_s3_object_bytes(&config, &key).await?
    };
    let key_display = picture_display_name(&key);
    let picture_id_owned = picture_id.to_string();
    let jpeg = tokio::task::spawn_blocking(move || -> Result<Vec<u8>, String> {
        let (pixels, width, height) = load_image_bytes(&bytes, Some(&key_display))
            .map_err(|error| error.to_string())?;
        let image =
            image::RgbaImage::from_raw(width, height, pixels).ok_or_else(|| {
                format!("failed to decode S3 image for thumbnail: {picture_id_owned}")
            })?;
        let thumbnail = image::DynamicImage::ImageRgba8(image).thumbnail(320, 320);
        let mut jpeg = Vec::new();
        thumbnail
            .write_to(
                &mut std::io::Cursor::new(&mut jpeg),
                image::ImageFormat::Jpeg,
            )
            .map_err(|error| error.to_string())?;
        Ok(jpeg)
    })
    .await
    .map_err(|e| e.to_string())??;
    Ok(jpeg)
}
pub(crate) async fn load_photo_thumbnail_from_tauri<R: tauri::Runtime>(
    _app: &tauri::AppHandle<R>,
    picture_id: &str,
) -> Result<Option<Vec<u8>>, String> {
    #[cfg(target_os = "android")]
    if picture_id.starts_with("content://") {
        return _app
            .state::<crate::photos::PhotosHandle<R>>()
            .get_thumbnail(picture_id)
            .await
            .map(Some);
    }

    #[cfg(target_os = "ios")]
    if !picture_id.starts_with('/') {
        let picture_id = picture_id.to_owned();
        let bytes = tokio::task::spawn_blocking(move || {
            let c_id =
                std::ffi::CString::new(picture_id.as_str()).map_err(|e| e.to_string())?;
            let mut out_size: i32 = 0;
            let ptr =
                unsafe { ios_get_thumbnail(c_id.as_ptr(), 320, 320, &mut out_size) };
            if ptr.is_null() {
                return Err("failed to get thumbnail from photo library".to_string());
            }
            let bytes = unsafe {
                let v = std::slice::from_raw_parts(ptr, out_size as usize).to_vec();
                ios_free_buffer(ptr);
                v
            };
            Ok(bytes)
        })
        .await
        .map_err(|error| error.to_string())??;
        return Ok(Some(bytes));
    }

    let _ = picture_id;
    Ok(None)
}
pub(crate) async fn load_camera_image_from_tauri(
    host: &str,
    file_path: &str,
) -> Result<Vec<u8>, String> {
    shade_io::ccapi::CCAPI::new(host)
        .original(file_path)
        .await
        .map(|bytes| bytes.to_vec())
        .map_err(|error| error.to_string())
}
pub(crate) async fn load_s3_image_from_tauri(path: &str) -> Result<Vec<u8>, String> {
    let (source_id, key) =
        shade_io::parse_s3_media_path(path).map_err(|e| e.to_string())?;
    let library_id = s3_library_id(source_id);
    let sync_dir = library_sync_dir(&library_id)?;
    let file_name = std::path::Path::new(key)
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| key.to_string());
    let local_path = sync_dir.join(&file_name);
    if local_path.is_file() {
        return std::fs::read(&local_path).map_err(|e| e.to_string());
    }
    let config = resolve_s3_library_config(&library_id)?;
    shade_io::get_s3_object_bytes(&config, key).await
}
pub(crate) async fn load_photo_image_from_tauri<R: tauri::Runtime>(
    _app: &tauri::AppHandle<R>,
    picture_id: &str,
) -> Result<Option<Vec<u8>>, String> {
    #[cfg(target_os = "android")]
    if picture_id.starts_with("content://") {
        return _app
            .state::<crate::photos::PhotosHandle<R>>()
            .get_image_data(picture_id)
            .await
            .map(Some);
    }

    #[cfg(target_os = "ios")]
    if !picture_id.starts_with('/') {
        let picture_id = picture_id.to_owned();
        let bytes = tokio::task::spawn_blocking(move || {
            let c_id =
                std::ffi::CString::new(picture_id.as_str()).map_err(|e| e.to_string())?;
            let mut out_size: i32 = 0;
            let ptr = unsafe { ios_get_image_data(c_id.as_ptr(), &mut out_size) };
            if ptr.is_null() {
                return Err("failed to fetch image from photo library".to_string());
            }
            let bytes = unsafe {
                let v = std::slice::from_raw_parts(ptr, out_size as usize).to_vec();
                ios_free_buffer(ptr);
                v
            };
            Ok(bytes)
        })
        .await
        .map_err(|error| error.to_string())??;
        return Ok(Some(bytes));
    }

    let _ = picture_id;
    Ok(None)
}
pub async fn load_thumbnail_bytes<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    picture_id: &str,
) -> Result<Vec<u8>, String> {
    // The picture_id may contain a #modified_at or #snapshot:<id> suffix for cache busting.
    // Strip it for the actual load path, keep the original for the cache key.
    let load_path = picture_id.split_once('#').map_or(picture_id, |(p, _)| p);
    let cache = app.state::<crate::ThumbnailCacheDb>();
    let is_snapshot = picture_id.contains("#snapshot:");
    let cache_key = if is_snapshot {
        // Include edit version created_at so in-place edits invalidate the cache.
        match latest_snapshot_created_at(load_path).await {
            Some(created_at) => format!(
                "{}#ev_{created_at}",
                shade_io::thumbnail_cache_key(picture_id)
            ),
            None => shade_io::thumbnail_cache_key(picture_id),
        }
    } else {
        shade_io::thumbnail_cache_key(picture_id)
    };
    if let Ok(Some((cached_fingerprint, cached_bytes))) = cache.0.get(&cache_key).await {
        if let Some(fingerprint) = cached_fingerprint.as_deref() {
            register_image_source(fingerprint, Some(load_path)).await?;
            return Ok(cached_bytes);
        }
        let is_local_path =
            !load_path.starts_with("ccapi://") && !load_path.starts_with("s3://");
        if !is_local_path {
            return Ok(cached_bytes);
        }
    }
    if let Some((bytes, fingerprint)) =
        render_snapshot_thumbnail_bytes(&app, load_path).await?
    {
        register_image_source(&fingerprint, Some(load_path)).await?;
        cache.0.put(&cache_key, Some(&fingerprint), &bytes).await?;
        return Ok(bytes);
    }
    let thumbnail_queue = app.state::<crate::ThumbnailService>().raw_queue.clone();
    let thumbnail = shade_io::load_thumbnail_bytes(
        load_path,
        thumbnail_queue.as_ref(),
        {
            let app = app.clone();
            move |host, file_path| {
                let app = app.clone();
                async move { load_camera_thumbnail_from_tauri(&app, &host, &file_path).await }
            }
        },
        |s3_path| async move { load_s3_thumbnail_from_tauri(&s3_path).await },
        {
            let app = app.clone();
            move |picture_id| {
                let app = app.clone();
                async move { load_photo_thumbnail_from_tauri(&app, &picture_id).await }
            }
        },
    )
    .await?;
    if let Some(fingerprint) = thumbnail.fingerprint.as_deref() {
        register_image_source(fingerprint, Some(load_path)).await?;
    }
    cache
        .0
        .put(
            &cache_key,
            thumbnail.fingerprint.as_deref(),
            &thumbnail.bytes,
        )
        .await?;
    #[cfg(not(any(target_os = "ios", target_os = "android")))]
    if let Some(fingerprint) = thumbnail.fingerprint.clone() {
        import_xmp_rating(picture_id, &fingerprint).await;
        crate::tagging_worker::enqueue_thumbnail_for_tagging(
            &app,
            shade_io::ThumbnailCacheEntry {
                picture_id: cache_key,
                fingerprint,
                data: thumbnail.bytes.clone(),
            },
        )?;
    }
    Ok(thumbnail.bytes)
}
pub async fn load_picture_bytes<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    picture_id: &str,
) -> Result<Vec<u8>, String> {
    shade_io::load_picture_bytes(
        picture_id,
        |host, file_path| async move { load_camera_image_from_tauri(&host, &file_path).await },
        |s3_path| async move { load_s3_image_from_tauri(&s3_path).await },
        {
            let app = app.clone();
            move |picture_id| {
                let app = app.clone();
                async move { load_photo_image_from_tauri(&app, &picture_id).await }
            }
        },
    )
    .await
}
#[tauri::command]
pub async fn list_pictures<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
) -> Result<Vec<String>, String> {
    Ok(load_picture_entries(app)
        .await?
        .into_iter()
        .map(|picture| picture.id)
        .collect())
}
pub async fn load_picture_entries<R: tauri::Runtime>(
    _app: tauri::AppHandle<R>,
) -> Result<Vec<shade_p2p::SharedPicture>, String> {
    #[cfg(target_os = "android")]
    {
        let mut pictures = _app
            .state::<crate::photos::PhotosHandle<R>>()
            .list_photos()
            .await
            .map(|pictures| {
                pictures
                    .into_iter()
                    .map(|photo| shade_p2p::SharedPicture {
                        name: picture_display_name(&photo.uri),
                        id: photo.uri,
                        modified_at: photo.modified_at,
                    })
                    .collect::<Vec<_>>()
            })?;
        return Ok(pictures);
    }

    #[cfg(target_os = "ios")]
    {
        let mut pictures = tokio::task::spawn_blocking(|| {
            let ptr = unsafe { ios_list_photos() };
            if ptr.is_null() {
                return Ok::<Vec<shade_p2p::SharedPicture>, String>(vec![]);
            }
            let json = unsafe {
                let s = std::ffi::CStr::from_ptr(ptr).to_string_lossy().into_owned();
                ios_free_string(ptr);
                s
            };
            serde_json::from_str::<Vec<IosPhotoEntry>>(&json)
                .map(|pictures| {
                    pictures
                        .into_iter()
                        .map(|photo| shade_p2p::SharedPicture {
                            name: picture_display_name(&photo.id),
                            id: photo.id,
                            modified_at: photo.modified_at,
                        })
                        .collect::<Vec<_>>()
                })
                .map_err(|e| e.to_string())
        })
        .await
        .map_err(|e| e.to_string())??;
        return Ok(pictures);
    }

    #[cfg(not(any(target_os = "ios", target_os = "android")))]
    {
        let pictures = collect_images_in_directory(&default_pictures_dir()?)?
            .into_iter()
            .map(|picture| shade_p2p::SharedPicture {
                name: picture.name,
                id: picture.path,
                modified_at: picture.modified_at,
            })
            .collect::<Vec<_>>();
        Ok(pictures)
    }
}
