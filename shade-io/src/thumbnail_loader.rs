use crate::{ThumbnailJob, ThumbnailQueue};
use std::io::Read;
use std::path::Path;
use std::sync::Arc;

pub type ThumbnailResponseSender = tokio::sync::oneshot::Sender<Result<Vec<u8>, String>>;

fn hash_file(path: &Path) -> Result<String, String> {
    let mut file = std::fs::File::open(path).map_err(|error| error.to_string())?;
    let mut hasher = blake3::Hasher::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = file.read(&mut buffer).map_err(|error| error.to_string())?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(hasher.finalize().to_hex().to_string())
}

fn parse_ccapi_media_path(path: &str) -> Result<(&str, &str), String> {
    let path = path
        .strip_prefix("ccapi://")
        .ok_or_else(|| format!("invalid ccapi media path: {path}"))?;
    let slash_idx = path
        .find('/')
        .ok_or_else(|| format!("invalid ccapi media path: ccapi://{path}"))?;
    let (host, file_path) = path.split_at(slash_idx);
    if host.is_empty() || file_path.is_empty() {
        return Err(format!("invalid ccapi media path: ccapi://{path}"));
    }
    Ok((host, file_path))
}

pub fn generate_desktop_thumbnail(path: &str) -> Result<Vec<u8>, String> {
    let source = Path::new(path);
    let cache_key = hash_file(source)?;
    let cache_dir = std::env::temp_dir().join("shade-thumbnails");
    std::fs::create_dir_all(&cache_dir).map_err(|error| error.to_string())?;
    let cache_path = cache_dir.join(format!("v2-{cache_key}.jpg"));
    if cache_path.exists() {
        return std::fs::read(&cache_path).map_err(|error| error.to_string());
    }
    let (pixels, width, height) =
        crate::load_image(source).map_err(|error| error.to_string())?;
    let img = image::RgbaImage::from_raw(width, height, pixels)
        .ok_or("failed to wrap pixels in RgbaImage")?;
    let thumb = image::DynamicImage::ImageRgba8(img).thumbnail(320, 320);
    let mut jpeg = Vec::new();
    thumb
        .write_to(
            &mut std::io::Cursor::new(&mut jpeg),
            image::ImageFormat::Jpeg,
        )
        .map_err(|error| error.to_string())?;
    std::fs::write(&cache_path, &jpeg).map_err(|error| error.to_string())?;
    Ok(jpeg)
}

pub fn spawn_thumbnail_workers() -> Arc<ThumbnailQueue<ThumbnailResponseSender>> {
    let queue = Arc::new(ThumbnailQueue::<ThumbnailResponseSender>::new());
    for worker_idx in 0..3 {
        let worker_queue = queue.clone();
        std::thread::Builder::new()
            .name(format!("shade-thumbnail-{worker_idx}"))
            .spawn(move || loop {
                let job = worker_queue.pop_latest();
                let result = generate_desktop_thumbnail(&job.path);
                for response in job.responses {
                    let _ = response.send(result.clone());
                }
            })
            .expect("failed to spawn thumbnail worker thread");
    }
    queue
}

pub async fn load_thumbnail_bytes<
    CameraThumbnail,
    CameraFuture,
    PhotoThumbnail,
    PhotoFuture,
>(
    picture_id: &str,
    thumbnail_queue: &ThumbnailQueue<ThumbnailResponseSender>,
    load_camera_thumbnail: CameraThumbnail,
    load_photo_thumbnail: PhotoThumbnail,
) -> Result<Vec<u8>, String>
where
    CameraThumbnail: Fn(String, String) -> CameraFuture,
    CameraFuture: std::future::Future<Output = Result<Vec<u8>, String>>,
    PhotoThumbnail: Fn(String) -> PhotoFuture,
    PhotoFuture: std::future::Future<Output = Result<Option<Vec<u8>>, String>>,
{
    if picture_id.starts_with("ccapi://") {
        let (host, file_path) = parse_ccapi_media_path(picture_id)?;
        return load_camera_thumbnail(host.to_string(), file_path.to_string()).await;
    }
    if let Some(bytes) = load_photo_thumbnail(picture_id.to_string()).await? {
        return Ok(bytes);
    }
    let (response_tx, response_rx) = tokio::sync::oneshot::channel();
    thumbnail_queue.push(ThumbnailJob {
        path: picture_id.to_owned(),
        response: response_tx,
    });
    response_rx.await.map_err(|error| error.to_string())?
}
