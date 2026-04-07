use crate::{
    load_image_bytes_f32_with_info, load_image_f32_with_info, picture_display_name,
    SourceImageInfo,
};
use shade_lib::FloatImage;
use std::io::Read;
use std::path::Path;

#[derive(Clone, Debug)]
pub struct OpenedImage {
    pub file_hash: String,
    pub source_name: Option<String>,
    pub image: FloatImage,
    pub info: SourceImageInfo,
}

fn hash_bytes(bytes: &[u8]) -> String {
    blake3::hash(bytes).to_hex().to_string()
}

pub fn hash_file(path: &Path) -> Result<String, String> {
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

pub async fn load_picture_bytes<
    CameraImage,
    CameraFuture,
    S3Image,
    S3Future,
    PhotoImage,
    PhotoFuture,
>(
    picture_id: &str,
    load_camera_image: CameraImage,
    load_s3_image: S3Image,
    load_photo_image: PhotoImage,
) -> Result<Vec<u8>, String>
where
    CameraImage: Fn(String, String) -> CameraFuture,
    CameraFuture: std::future::Future<Output = Result<Vec<u8>, String>>,
    S3Image: Fn(String) -> S3Future,
    S3Future: std::future::Future<Output = Result<Vec<u8>, String>>,
    PhotoImage: Fn(String) -> PhotoFuture,
    PhotoFuture: std::future::Future<Output = Result<Option<Vec<u8>>, String>>,
{
    if picture_id.starts_with("ccapi://") {
        let (host, file_path) = parse_ccapi_media_path(picture_id)?;
        return load_camera_image(host.to_string(), file_path.to_string()).await;
    }
    if picture_id.starts_with("s3://") {
        let _ = parse_s3_media_path(picture_id)?;
        return load_s3_image(picture_id.to_string()).await;
    }
    if let Some(bytes) = load_photo_image(picture_id.to_string()).await? {
        return Ok(bytes);
    }
    std::fs::read(picture_id).map_err(|error| error.to_string())
}

pub async fn open_image<
    CameraImage,
    CameraFuture,
    S3Image,
    S3Future,
    PhotoImage,
    PhotoFuture,
>(
    path: &str,
    load_camera_image: CameraImage,
    load_s3_image: S3Image,
    load_photo_image: PhotoImage,
) -> Result<OpenedImage, String>
where
    CameraImage: Fn(String, String) -> CameraFuture,
    CameraFuture: std::future::Future<Output = Result<Vec<u8>, String>>,
    S3Image: Fn(String) -> S3Future,
    S3Future: std::future::Future<Output = Result<Vec<u8>, String>>,
    PhotoImage: Fn(String) -> PhotoFuture,
    PhotoFuture: std::future::Future<Output = Result<Option<Vec<u8>>, String>>,
{
    if path.starts_with("ccapi://") {
        let bytes = load_picture_bytes(
            path,
            &load_camera_image,
            &load_s3_image,
            &load_photo_image,
        )
        .await?;
        let (_, file_path) = parse_ccapi_media_path(path)?;
        let (image, info) = load_image_bytes_f32_with_info(
            &bytes,
            Some(&picture_display_name(file_path)),
        )
        .map_err(|error| error.to_string())?;
        return Ok(OpenedImage {
            file_hash: hash_bytes(&bytes),
            source_name: Some(path.to_string()),
            image,
            info,
        });
    }
    if path.starts_with("s3://") {
        let bytes = load_picture_bytes(
            path,
            &load_camera_image,
            &load_s3_image,
            &load_photo_image,
        )
        .await?;
        let (_, key) = parse_s3_media_path(path)?;
        let (image, info) =
            load_image_bytes_f32_with_info(&bytes, Some(&picture_display_name(key)))
                .map_err(|error| error.to_string())?;
        return Ok(OpenedImage {
            file_hash: hash_bytes(&bytes),
            source_name: Some(path.to_string()),
            image,
            info,
        });
    }
    if let Some(bytes) = load_photo_image(path.to_string()).await? {
        let (image, info) = load_image_bytes_f32_with_info(&bytes, None)
            .map_err(|error| error.to_string())?;
        return Ok(OpenedImage {
            file_hash: hash_bytes(&bytes),
            source_name: Some(path.to_string()),
            image,
            info,
        });
    }
    let source = Path::new(path);
    let (image, info) =
        load_image_f32_with_info(source).map_err(|error| error.to_string())?;
    Ok(OpenedImage {
        file_hash: hash_file(source)?,
        source_name: Some(path.to_string()),
        image,
        info,
    })
}
