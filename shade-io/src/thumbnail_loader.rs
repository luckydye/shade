use crate::{ThumbnailJob, ThumbnailQueue};
use std::path::Path;
use std::sync::Arc;

#[derive(Clone, Debug)]
pub struct LoadedThumbnail {
    pub bytes: Vec<u8>,
    pub file_hash: Option<String>,
}

pub type ThumbnailResponseSender =
    tokio::sync::oneshot::Sender<Result<LoadedThumbnail, String>>;

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

fn parse_s3_media_path(path: &str) -> Result<(&str, &str), String> {
    let path = path
        .strip_prefix("s3://")
        .ok_or_else(|| format!("invalid S3 media path: {path}"))?;
    let slash_idx = path
        .find('/')
        .ok_or_else(|| format!("invalid S3 media path: s3://{path}"))?;
    let (source_id, key_with_slash) = path.split_at(slash_idx);
    let key = &key_with_slash[1..];
    if source_id.is_empty() || key.is_empty() {
        return Err(format!("invalid S3 media path: s3://{path}"));
    }
    Ok((source_id, key))
}

pub fn generate_desktop_thumbnail(path: &str) -> Result<LoadedThumbnail, String> {
    let source = Path::new(path);
    let encoded = std::fs::read(source).map_err(|error| error.to_string())?;
    let file_hash = blake3::hash(&encoded).to_hex().to_string();
    let (pixels, width, height) = crate::load_image_bytes(
        &encoded,
        source.file_name().and_then(|name| name.to_str()),
    )
    .map_err(|error| error.to_string())?;
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
    Ok(LoadedThumbnail {
        bytes: jpeg,
        file_hash: Some(file_hash),
    })
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
    S3Thumbnail,
    S3Future,
    PhotoThumbnail,
    PhotoFuture,
>(
    picture_id: &str,
    thumbnail_queue: &ThumbnailQueue<ThumbnailResponseSender>,
    load_camera_thumbnail: CameraThumbnail,
    load_s3_thumbnail: S3Thumbnail,
    load_photo_thumbnail: PhotoThumbnail,
) -> Result<LoadedThumbnail, String>
where
    CameraThumbnail: Fn(String, String) -> CameraFuture,
    CameraFuture: std::future::Future<Output = Result<Vec<u8>, String>>,
    S3Thumbnail: Fn(String) -> S3Future,
    S3Future: std::future::Future<Output = Result<Vec<u8>, String>>,
    PhotoThumbnail: Fn(String) -> PhotoFuture,
    PhotoFuture: std::future::Future<Output = Result<Option<Vec<u8>>, String>>,
{
    if picture_id.starts_with("ccapi://") {
        let (host, file_path) = parse_ccapi_media_path(picture_id)?;
        return load_camera_thumbnail(host.to_string(), file_path.to_string())
            .await
            .map(|bytes| LoadedThumbnail {
                bytes,
                file_hash: None,
            });
    }
    if picture_id.starts_with("s3://") {
        let _ = parse_s3_media_path(picture_id)?;
        return load_s3_thumbnail(picture_id.to_string())
            .await
            .map(|bytes| LoadedThumbnail {
                bytes,
                file_hash: None,
            });
    }
    if let Some(bytes) = load_photo_thumbnail(picture_id.to_string()).await? {
        return Ok(LoadedThumbnail {
            bytes,
            file_hash: None,
        });
    }
    let (response_tx, response_rx) = tokio::sync::oneshot::channel();
    thumbnail_queue.push(ThumbnailJob {
        path: picture_id.to_owned(),
        response: response_tx,
    });
    response_rx.await.map_err(|error| error.to_string())?
}
