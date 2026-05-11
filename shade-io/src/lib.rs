use anyhow::{anyhow, Context, Result};
use exif::{In, Tag};
use exr::meta::{attribute::SampleType, MetaData};
use exr::prelude::{ReadChannels, ReadLayers};
use image::{ColorType, DynamicImage, ImageFormat};
use rawler::{
    decoders::{Orientation as RawOrientation, RawDecodeParams},
    imgop::develop::{
        Intermediate as RawIntermediate, ProcessingStep as RawProcessingStep,
        RawDevelop,
    },
    rawsource::RawSource,
    RawImage,
};
use shade_lib::color::{
    from_acescct_f32, linear_srgb_lut_u8, linear_srgb_lut_u16, quantize_rgba_f32,
    to_acescct_f32,
};
use shade_lib::{ColorSpace, FloatImage};
use std::path::Path;
use std::{convert::TryFrom, io::Cursor};

pub mod file_fingerprint;

#[cfg(feature = "native")]
pub mod app_config;
#[cfg(feature = "native")]
pub(crate) mod file_fingerprint_cache;
#[cfg(feature = "native")]
pub(crate) mod file_fingerprint_io;
#[cfg(feature = "native")]
pub mod camera_services;
#[cfg(feature = "native")]
pub mod ccapi;
#[cfg(feature = "native")]
pub mod collections;
#[cfg(feature = "native")]
pub mod image_loader;
#[cfg(feature = "native")]
pub mod library_index;
#[cfg(feature = "native")]
pub mod library_scan_service;
#[cfg(feature = "native")]
pub mod library_source;
#[cfg(feature = "native")]
pub mod thumbnail_cache;
#[cfg(feature = "native")]
pub mod thumbnail_loader;
#[cfg(feature = "native")]
pub mod thumbnail_queue;
#[cfg(feature = "ffmpeg")]
pub mod video_decoder;
#[cfg(feature = "ffmpeg")]
pub mod video_encoder;

pub use file_fingerprint::{fingerprint_from_bytes, fingerprint_local};

#[cfg(feature = "native")]
pub use app_config::{
    append_library_order_id, is_peer_paired, load_app_config, normalize_library_order,
    pair_peer, remove_library_order_id, save_app_config, upsert_library_config, AppConfig,
};
#[cfg(feature = "native")]
pub use camera_services::{CameraDiscoveryService, CameraThumbnailService};
#[cfg(feature = "native")]
pub use collections::{
    add_collection_items, create_collection, create_collections_tables,
    delete_collection, list_collection_items, list_collections, remove_collection_items,
    rename_collection, reorder_collection, Collection, CollectionItem,
};
#[cfg(feature = "native")]
pub use image_loader::{load_picture_bytes, open_image, OpenedImage};
#[cfg(feature = "native")]
pub use library_index::{
    delete_persisted_library_index, delete_persisted_library_index_item,
    has_persisted_library_index, has_persisted_library_index_by_root,
    is_supported_library_image, library_index_db_path, load_persisted_library_index_by_root,
    picture_display_name, rating_for_image_path, replace_persisted_library_index_by_root,
    scan_directory_images, sort_indexed_library_items, IndexedLibraryImage, LibraryIndexDb,
};
#[cfg(feature = "native")]
pub use library_scan_service::{
    flush_library_scan_batch, LibraryScanService, LibraryScanSnapshot,
};
#[cfg(feature = "native")]
pub use library_source::{
    camera_library_id, delete_s3_object, display_s3_library_name, fetch_url_bytes,
    format_s3_library_detail, get_s3_object_bytes, head_s3_object_modified_at,
    library_config_id, list_s3_objects, list_s3_objects_page, local_library_id,
    media_path_for_s3_object, normalize_s3_library_input, parse_s3_media_path,
    peer_library_id, put_s3_object_bytes, put_s3_object_bytes_with_atime,
    resolve_s3_source_id_from_library_id, s3_library_id, AddS3LibraryParams,
    CameraLibraryConfig, LibraryConfig, LibraryMode, LocalLibraryConfig, PeerLibraryConfig,
    S3LibraryConfig,
};
#[cfg(feature = "native")]
pub use thumbnail_cache::{thumbnail_cache_key, ThumbnailCacheDb, ThumbnailCacheEntry};
#[cfg(feature = "native")]
pub use thumbnail_loader::{
    generate_desktop_thumbnail, load_thumbnail_bytes, spawn_thumbnail_workers,
    ThumbnailResponseSender,
};
#[cfg(feature = "native")]
pub use thumbnail_queue::ThumbnailQueue;
#[cfg(feature = "ffmpeg")]
pub use video_decoder::{FrameInfo, VideoDecoder};
#[cfg(feature = "ffmpeg")]
pub use video_encoder::{VideoCodec, VideoEncoder};

#[cfg(feature = "ffmpeg")]
pub fn init_video() {
    video_rs::init().expect("failed to initialise FFmpeg via video-rs");
}

#[cfg(not(feature = "ffmpeg"))]
pub fn init_video() {
    panic!(
        "shade-io was compiled without the `ffmpeg` feature. \
         Install system FFmpeg and rebuild with the `ffmpeg` feature enabled."
    );
}

// ── Public image loading ───────────────────────────────────────────────────────

const EXR_MAGIC: [u8; 4] = [0x76, 0x2f, 0x31, 0x01];
const RAW_EXTENSIONS: &[&str] = &[
    "3fr", "ari", "arw", "cr2", "cr3", "crm", "crw", "dcr", "dcs", "dng", "erf", "fff",
    "iiq", "kdc", "mef", "mos", "mrw", "nef", "nrw", "orf", "ori", "pef", "qtk", "raf",
    "raw", "rw2", "rwl", "srw", "x3f",
];

/// Load an image from disk and return raw RGBA8 bytes along with dimensions.
/// Pixels are returned as-is (still in the source colour space / gamma).
pub fn load_image(path: &Path) -> Result<(Vec<u8>, u32, u32)> {
    let bytes = std::fs::read(path)
        .with_context(|| format!("Cannot read file: {}", path.display()))?;
    load_image_bytes(&bytes, path.file_name().and_then(|name| name.to_str()))
        .with_context(|| format!("Failed to decode image: {}", path.display()))
}

pub fn load_image_bytes(bytes: &[u8], name_hint: Option<&str>) -> Result<(Vec<u8>, u32, u32)> {
    if is_exr(name_hint, bytes) || is_camera_raw(name_hint, bytes) {
        let (image, _info) = load_image_bytes_f32_with_info(bytes, name_hint)?;
        let mut pixels = image.pixels.to_vec();
        from_acescct_f32(&mut pixels, &ColorSpace::Srgb);
        return Ok((quantize_rgba_f32(&pixels), image.width, image.height));
    }
    let img = apply_orientation(
        image::load_from_memory(bytes).context("Failed to decode image bytes")?,
        read_orientation(&mut Cursor::new(bytes))?,
    );
    let rgba = img.to_rgba8();
    let (width, height) = rgba.dimensions();
    Ok((rgba.into_raw(), width, height))
}

/// Load an image and also detect its embedded colour space.
/// Returns (pixels_rgba8, width, height, detected_color_space).

#[derive(Clone, Debug)]
pub struct SourceImageInfo {
    pub bit_depth: String,
    pub color_space: ColorSpace,
}

pub fn load_image_f32_with_info(path: &Path) -> Result<(FloatImage, SourceImageInfo)> {
    let bytes = std::fs::read(path)
        .with_context(|| format!("Cannot read file: {}", path.display()))?;
    let (image, info) = load_image_bytes_f32_with_info(
        &bytes,
        path.file_name().and_then(|name| name.to_str()),
    )
    .with_context(|| format!("Failed to decode image: {}", path.display()))?;
    Ok((image, info))
}


pub fn load_image_bytes_f32_with_info(
    bytes: &[u8],
    name_hint: Option<&str>,
) -> Result<(FloatImage, SourceImageInfo)> {
    if is_exr(name_hint, bytes) {
        let image = working_space_image(decode_exr_f32(bytes)?, &ColorSpace::LinearSrgb);
        return Ok((
            image,
            SourceImageInfo {
                bit_depth: detect_exr_bit_depth(bytes)?,
                color_space: ColorSpace::LinearSrgb,
            },
        ));
    }
    if is_camera_raw(name_hint, bytes) {
        let raw_source = match name_hint {
            Some(name) => RawSource::new_from_slice(bytes).with_path(name),
            None => RawSource::new_from_slice(bytes),
        };
        let raw_image = rawler::decode(&raw_source, &RawDecodeParams::default())
            .context("RAW decode failed")?;
        let bit_depth = format!("{}-bit RAW", raw_image.bps);
        let image = working_space_image(
            develop_raw_image_linear_srgb(&raw_image)?,
            &ColorSpace::LinearSrgb,
        );
        return Ok((
            image,
            SourceImageInfo {
                bit_depth,
                color_space: ColorSpace::Srgb,
            },
        ));
    }

    let ext = name_hint
        .and_then(|name| Path::new(name).extension())
        .and_then(|ext| ext.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();

    let color_space = match ext.as_str() {
        "jpg" | "jpeg" => detect_jpeg_colorspace(bytes),
        "png" => detect_png_colorspace(bytes),
        _ => ColorSpace::Unknown,
    };

    let image = apply_orientation(
        image::load_from_memory(bytes).context("Failed to decode image bytes")?,
        read_orientation(&mut Cursor::new(bytes))?,
    );
    let color_type = image.color();
    let bit_depth = decoder_color_type_label(color_type);
    Ok((
        into_linear_float_image(image, color_type, &color_space),
        SourceImageInfo {
            bit_depth: bit_depth.to_string(),
            color_space,
        },
    ))
}

fn read_orientation<R: std::io::BufRead + std::io::Seek>(
    reader: &mut R,
) -> Result<Option<u32>> {
    match exif::Reader::new().read_from_container(reader) {
        Ok(exif) => Ok(exif
            .get_field(Tag::Orientation, In::PRIMARY)
            .and_then(|field| field.value.get_uint(0))),
        Err(exif::Error::NotFound(_)) => Ok(None),
        Err(err) => Err(anyhow!(err)).context("Failed to read EXIF orientation"),
    }
}

fn apply_orientation(image: DynamicImage, orientation: Option<u32>) -> DynamicImage {
    match orientation.unwrap_or(1) {
        1 => image,
        2 => image.fliph(),
        3 => image.rotate180(),
        4 => image.flipv(),
        5 => image.rotate90().fliph(),
        6 => image.rotate90(),
        7 => image.rotate270().fliph(),
        8 => image.rotate270(),
        _ => image,
    }
}

fn raw_orientation_to_exif(orientation: RawOrientation) -> Option<u32> {
    match orientation {
        RawOrientation::Unknown => None,
        RawOrientation::Normal => Some(1),
        RawOrientation::HorizontalFlip => Some(2),
        RawOrientation::Rotate180 => Some(3),
        RawOrientation::VerticalFlip => Some(4),
        RawOrientation::Transpose => Some(5),
        RawOrientation::Rotate90 => Some(6),
        RawOrientation::Transverse => Some(7),
        RawOrientation::Rotate270 => Some(8),
    }
}


/// Save raw RGBA8 bytes to a file.
pub fn save_image(path: &Path, data: &[u8], width: u32, height: u32) -> Result<()> {
    let expected = (width * height * 4) as usize;
    if data.len() != expected {
        return Err(anyhow!(
            "save_image: expected {} bytes, got {}",
            expected,
            data.len()
        ));
    }
    let img = image::RgbaImage::from_raw(width, height, data.to_vec())
        .ok_or_else(|| anyhow!("save_image: failed to construct RgbaImage"))?;
    let dyn_img = DynamicImage::ImageRgba8(img);
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();
    let format = match ext.as_str() {
        "png" => ImageFormat::Png,
        "jpg" | "jpeg" => ImageFormat::Jpeg,
        "tif" | "tiff" => ImageFormat::Tiff,
        "webp" => ImageFormat::WebP,
        other => {
            return Err(anyhow!(
                "Unsupported output format: '.{}'. Use png, jpg, tiff, or webp.",
                other
            ))
        }
    };
    if format == ImageFormat::Jpeg {
        dyn_img
            .to_rgb8()
            .save_with_format(path, format)
            .with_context(|| format!("Failed to save image to {}", path.display()))?;
    } else {
        dyn_img
            .save_with_format(path, format)
            .with_context(|| format!("Failed to save image to {}", path.display()))?;
    }
    Ok(())
}

// ── Internal helpers ──────────────────────────────────────────────────────────

fn is_exr(name_hint: Option<&str>, bytes: &[u8]) -> bool {
    name_hint
        .and_then(|name| Path::new(name).extension())
        .and_then(|ext| ext.to_str())
        .is_some_and(|ext| ext.eq_ignore_ascii_case("exr"))
        || bytes.starts_with(&EXR_MAGIC)
}

fn is_camera_raw(name_hint: Option<&str>, bytes: &[u8]) -> bool {
    let has_raw_extension = name_hint
        .and_then(|name| Path::new(name).extension())
        .and_then(|ext| ext.to_str())
        .is_some_and(|ext| {
            RAW_EXTENSIONS
                .iter()
                .any(|candidate| ext.eq_ignore_ascii_case(candidate))
        });
    has_raw_extension || is_cr3(bytes)
}

fn is_cr3(bytes: &[u8]) -> bool {
    if bytes.len() < 12 {
        return false;
    }
    bytes[4..8] == *b"ftyp" && matches!(&bytes[8..12], b"cr3 " | b"crx ")
}


fn decode_exr_f32(bytes: &[u8]) -> Result<FloatImage> {
    struct ExrPixels {
        width: usize,
        data: Vec<f32>,
    }

    let image = exr::prelude::read()
        .no_deep_data()
        .largest_resolution_level()
        .rgba_channels(
            |resolution, _channels| ExrPixels {
                width: resolution.width(),
                data: vec![0.0; resolution.area() * 4],
            },
            |pixels: &mut ExrPixels, position, (r, g, b, a): (f32, f32, f32, f32)| {
                let base = (position.y() * pixels.width + position.x()) * 4;
                pixels.data[base] = r;
                pixels.data[base + 1] = g;
                pixels.data[base + 2] = b;
                pixels.data[base + 3] = a;
            },
        )
        .first_valid_layer()
        .all_attributes()
        .from_buffered(Cursor::new(bytes))
        .context("EXR decode failed")?;

    Ok(FloatImage {
        pixels: image.layer_data.channel_data.pixels.data.into(),
        width: u32::try_from(image.layer_data.size.width())
            .context("EXR width exceeds u32")?,
        height: u32::try_from(image.layer_data.size.height())
            .context("EXR height exceeds u32")?,
    })
}

fn detect_exr_bit_depth(bytes: &[u8]) -> Result<String> {
    let meta = MetaData::read_from_buffered(Cursor::new(bytes), false)
        .context("EXR metadata read failed")?;
    let channels = &meta
        .headers
        .first()
        .ok_or_else(|| anyhow!("EXR has no headers"))?
        .channels;
    let sample_type = channels.uniform_sample_type.unwrap_or_else(|| {
        channels
            .list
            .first()
            .map(|channel| channel.sample_type)
            .unwrap_or(SampleType::F32)
    });
    Ok(match sample_type {
        SampleType::F16 => "16-bit float".to_string(),
        SampleType::F32 => "32-bit float".to_string(),
        SampleType::U32 => "32-bit integer".to_string(),
    })
}


fn into_linear_float_image(
    image: DynamicImage,
    color_type: ColorType,
    color_space: &ColorSpace,
) -> FloatImage {
    match (color_type, color_space) {
        (
            ColorType::L8 | ColorType::La8 | ColorType::Rgb8 | ColorType::Rgba8,
            ColorSpace::Srgb | ColorSpace::Unknown | ColorSpace::Custom(_),
        ) => rgba8_to_linear_float_image(image.into_rgba8()),
        (
            ColorType::L16 | ColorType::La16 | ColorType::Rgb16 | ColorType::Rgba16,
            ColorSpace::Srgb | ColorSpace::Unknown | ColorSpace::Custom(_),
        ) => rgba16_to_linear_float_image(image.into_rgba16(), color_space),
        _ => {
            let rgba = image.into_rgba32f();
            let (width, height) = rgba.dimensions();
            let mut pixels = rgba.into_raw();
            to_acescct_f32(&mut pixels, color_space);
            FloatImage {
                pixels: pixels.into(),
                width,
                height,
            }
        }
    }
}

fn develop_raw_image_linear_srgb(raw_image: &RawImage) -> Result<FloatImage> {
    let developed = RawDevelop {
        steps: vec![
            RawProcessingStep::Rescale,
            RawProcessingStep::Demosaic,
            RawProcessingStep::CropActiveArea,
            RawProcessingStep::WhiteBalance,
            RawProcessingStep::Calibrate,
            RawProcessingStep::CropDefault,
        ],
    }
    .develop_intermediate(raw_image)
    .context("RAW development failed")?;
    Ok(match developed {
        RawIntermediate::ThreeColor(image) => {
            oriented_rgb_f32_to_float_image(image.width, image.height, image.data, raw_image.orientation)
        }
        developed => into_linear_float_image_raw_srgb_oriented(
            developed
                .to_dynamic_image()
                .ok_or_else(|| anyhow!("RAW development produced an invalid image buffer"))?,
            raw_image.orientation,
        ),
    })
}

fn into_linear_float_image_raw_srgb_oriented(
    image: DynamicImage,
    orientation: RawOrientation,
) -> FloatImage {
    match image {
        DynamicImage::ImageRgb16(image) => {
            oriented_rgb16_to_linear_float_image(image, orientation)
        }
        image => {
            let image = apply_orientation(image, raw_orientation_to_exif(orientation));
            let color_type = image.color();
            into_linear_float_image(image, color_type, &ColorSpace::Srgb)
        }
    }
}

fn rgba8_to_linear_float_image(image: image::RgbaImage) -> FloatImage {
    let (width, height) = image.dimensions();
    let linear_lut = linear_srgb_lut_u8();
    let mut pixels = image
        .into_raw()
        .chunks_exact(4)
        .flat_map(|rgba| {
            [
                linear_lut[rgba[0] as usize],
                linear_lut[rgba[1] as usize],
                linear_lut[rgba[2] as usize],
                rgba[3] as f32 / 255.0,
            ]
        })
        .collect::<Vec<_>>();
    to_acescct_f32(&mut pixels, &ColorSpace::LinearSrgb);
    FloatImage {
        pixels: pixels.into(),
        width,
        height,
    }
}

fn rgba16_to_linear_float_image(
    image: image::ImageBuffer<image::Rgba<u16>, Vec<u16>>,
    color_space: &ColorSpace,
) -> FloatImage {
    let (width, height) = image.dimensions();
    let mut pixels = match color_space {
        ColorSpace::Srgb | ColorSpace::Unknown | ColorSpace::Custom(_) => {
            let linear_lut = linear_srgb_lut_u16();
            image
                .into_raw()
                .chunks_exact(4)
                .flat_map(|rgba| {
                    [
                        linear_lut[rgba[0] as usize],
                        linear_lut[rgba[1] as usize],
                        linear_lut[rgba[2] as usize],
                        rgba[3] as f32 / 65535.0,
                    ]
                })
                .collect::<Vec<_>>()
        }
        _ => {
            let mut pixels = image
                .into_raw()
                .chunks_exact(4)
                .flat_map(|rgba| {
                    [
                        rgba[0] as f32 / 65535.0,
                        rgba[1] as f32 / 65535.0,
                        rgba[2] as f32 / 65535.0,
                        rgba[3] as f32 / 65535.0,
                    ]
                })
                .collect::<Vec<_>>();
            to_acescct_f32(&mut pixels, color_space);
            pixels
        }
    };
    if matches!(
        color_space,
        ColorSpace::Srgb | ColorSpace::Unknown | ColorSpace::Custom(_)
    ) {
        to_acescct_f32(&mut pixels, &ColorSpace::LinearSrgb);
    }
    FloatImage {
        pixels: pixels.into(),
        width,
        height,
    }
}

fn oriented_rgb_f32_to_float_image(
    src_width: usize,
    src_height: usize,
    src: Vec<[f32; 3]>,
    orientation: RawOrientation,
) -> FloatImage {
    let (width, height) = match orientation {
        RawOrientation::Transpose
        | RawOrientation::Rotate90
        | RawOrientation::Transverse
        | RawOrientation::Rotate270 => (src_height as u32, src_width as u32),
        _ => (src_width as u32, src_height as u32),
    };
    let mut pixels = vec![0.0; width as usize * height as usize * 4];
    let dst_width = width as usize;

    for sy in 0..src_height {
        for sx in 0..src_width {
            let (dx, dy) = match orientation {
                RawOrientation::Unknown | RawOrientation::Normal => (sx, sy),
                RawOrientation::HorizontalFlip => (src_width - 1 - sx, sy),
                RawOrientation::Rotate180 => (src_width - 1 - sx, src_height - 1 - sy),
                RawOrientation::VerticalFlip => (sx, src_height - 1 - sy),
                RawOrientation::Transpose => (sy, sx),
                RawOrientation::Rotate90 => (src_height - 1 - sy, sx),
                RawOrientation::Transverse => {
                    (src_height - 1 - sy, src_width - 1 - sx)
                }
                RawOrientation::Rotate270 => (sy, src_width - 1 - sx),
            };
            let rgb = src[sy * src_width + sx];
            let dst_base = (dy * dst_width + dx) * 4;
            pixels[dst_base] = rgb[0];
            pixels[dst_base + 1] = rgb[1];
            pixels[dst_base + 2] = rgb[2];
            pixels[dst_base + 3] = 1.0;
        }
    }

    FloatImage {
        pixels: pixels.into(),
        width,
        height,
    }
}

fn oriented_rgb16_to_linear_float_image(
    image: image::ImageBuffer<image::Rgb<u16>, Vec<u16>>,
    orientation: RawOrientation,
) -> FloatImage {
    let (src_width, src_height) = image.dimensions();
    let (width, height) = match orientation {
        RawOrientation::Transpose
        | RawOrientation::Rotate90
        | RawOrientation::Transverse
        | RawOrientation::Rotate270 => (src_height, src_width),
        _ => (src_width, src_height),
    };
    let src = image.into_raw();
    let mut pixels = vec![0.0; width as usize * height as usize * 4];
    let linear_lut = linear_srgb_lut_u16();
    let dst_width = width as usize;
    let src_width = src_width as usize;
    let src_height = src_height as usize;

    for sy in 0..src_height {
        for sx in 0..src_width {
            let (dx, dy) = match orientation {
                RawOrientation::Unknown | RawOrientation::Normal => (sx, sy),
                RawOrientation::HorizontalFlip => (src_width - 1 - sx, sy),
                RawOrientation::Rotate180 => (src_width - 1 - sx, src_height - 1 - sy),
                RawOrientation::VerticalFlip => (sx, src_height - 1 - sy),
                RawOrientation::Transpose => (sy, sx),
                RawOrientation::Rotate90 => (src_height - 1 - sy, sx),
                RawOrientation::Transverse => {
                    (src_height - 1 - sy, src_width - 1 - sx)
                }
                RawOrientation::Rotate270 => (sy, src_width - 1 - sx),
            };
            let src_base = (sy * src_width + sx) * 3;
            let dst_base = (dy * dst_width + dx) * 4;
            pixels[dst_base] = linear_lut[src[src_base] as usize];
            pixels[dst_base + 1] = linear_lut[src[src_base + 1] as usize];
            pixels[dst_base + 2] = linear_lut[src[src_base + 2] as usize];
            pixels[dst_base + 3] = 1.0;
        }
    }

    FloatImage {
        pixels: pixels.into(),
        width,
        height,
    }
}

fn decoder_color_type_label(color_type: image::ColorType) -> &'static str {
    use image::ColorType::*;
    match color_type {
        L8 | La8 | Rgb8 | Rgba8 => "8-bit",
        L16 | La16 | Rgb16 | Rgba16 => "16-bit",
        Rgb32F | Rgba32F => "32-bit float",
        _ => "Unknown",
    }
}

fn working_space_image(image: FloatImage, color_space: &ColorSpace) -> FloatImage {
    let mut pixels = image.pixels.to_vec();
    to_acescct_f32(&mut pixels, color_space);
    FloatImage {
        pixels: pixels.into(),
        width: image.width,
        height: image.height,
    }
}

#[cfg(test)]
mod tests {
    use super::{
        apply_orientation, into_linear_float_image, load_image,
        load_image_bytes_f32_with_info, load_image_f32_with_info, raw_orientation_to_exif,
    };
    use image::{DynamicImage, ImageFormat, Rgba, RgbaImage};
    use rawler::{
        decoders::RawDecodeParams,
        imgop::develop::RawDevelop,
        rawsource::RawSource,
    };
    use shade_lib::color::{acescct_to_linear_channel, to_linear_srgb_f32};
    use shade_lib::ColorSpace;
    use std::path::Path;
    use std::time::{Duration, Instant};

    fn format_duration(duration: Duration) -> String {
        format!("{:.2}ms", duration.as_secs_f64() * 1000.0)
    }

    fn legacy_rgba16_to_linear_float_image(image: DynamicImage) {
        let rgba = image.into_rgba16();
        let mut pixels = rgba
            .into_raw()
            .chunks_exact(4)
            .flat_map(|rgba| {
                [
                    rgba[0] as f32 / 65535.0,
                    rgba[1] as f32 / 65535.0,
                    rgba[2] as f32 / 65535.0,
                    rgba[3] as f32 / 65535.0,
                ]
            })
            .collect::<Vec<_>>();
        to_linear_srgb_f32(&mut pixels, &ColorSpace::Srgb);
    }

    #[test]
    fn applies_orientation_to_cr3_fixture() {
        let path =
            Path::new(env!("CARGO_MANIFEST_DIR")).join("../test/fixtures/_MGC3030.CR3");
        let (_, width, height) = load_image(&path).expect("fixture should decode");
        assert_eq!((width, height), (3648, 5472));
    }

    #[test]
    fn applies_orientation_to_cr3_fixture_in_f32_info_path() {
        let path =
            Path::new(env!("CARGO_MANIFEST_DIR")).join("../test/fixtures/_MGC3030.CR3");
        let (image, _) = load_image_f32_with_info(&path).expect("fixture should decode");
        assert_eq!((image.width, image.height), (3648, 5472));
    }

    #[test]
    fn reports_actual_exr_bit_depth_for_fixture() {
        let path =
            Path::new(env!("CARGO_MANIFEST_DIR")).join("../test/fixtures/Desk.exr");
        let (_, info) = load_image_f32_with_info(&path).expect("fixture should decode");
        assert_eq!(info.bit_depth, "16-bit float");
    }

    #[test]
    fn loads_srgb_png_into_acescct_working_space() {
        let mut encoded = Vec::new();
        DynamicImage::ImageRgba8(RgbaImage::from_pixel(
            1,
            1,
            Rgba([118, 118, 118, 255]),
        ))
        .write_to(&mut std::io::Cursor::new(&mut encoded), ImageFormat::Png)
        .expect("PNG should encode");

        let (image, info) = load_image_bytes_f32_with_info(&encoded, Some("midgrey.png"))
            .expect("PNG should decode");

        assert!(matches!(info.color_space, ColorSpace::Srgb | ColorSpace::Unknown));
        let rgb = &image.pixels[..3];
        for channel in rgb {
            let linear = acescct_to_linear_channel(*channel);
            assert!(
                (linear - 0.18).abs() < 0.01,
                "expected working-space pixel to decode to ~0.18 linear, got {linear}"
            );
        }
    }

    #[test]
    #[ignore = "benchmark helper"]
    fn benchmark_cr3_wasm_open_path() {
        let path =
            Path::new(env!("CARGO_MANIFEST_DIR")).join("../test/fixtures/_MGC3030.CR3");
        let bytes = std::fs::read(&path).expect("fixture bytes");

        let decode_start = Instant::now();
        let raw_source = RawSource::new_from_slice(&bytes).with_path("_MGC3030.CR3");
        let raw_image =
            rawler::decode(&raw_source, &RawDecodeParams::default()).expect("RAW decode");
        let decode_duration = decode_start.elapsed();

        let develop_start = Instant::now();
        let developed = RawDevelop::default()
            .develop_intermediate(&raw_image)
            .expect("RAW development failed")
            .to_dynamic_image()
            .expect("RAW development produced an invalid image buffer");
        let develop_duration = develop_start.elapsed();

        let orient_start = Instant::now();
        let oriented =
            apply_orientation(developed, raw_orientation_to_exif(raw_image.orientation));
        let orient_duration = orient_start.elapsed();

        let color_type = oriented.color();
        let legacy_source = oriented.clone();
        let legacy_convert_start = Instant::now();
        legacy_rgba16_to_linear_float_image(legacy_source);
        let legacy_convert_duration = legacy_convert_start.elapsed();
        let convert_start = Instant::now();
        let image = into_linear_float_image(oriented, color_type, &ColorSpace::Srgb);
        let convert_duration = convert_start.elapsed();

        let total =
            decode_duration + develop_duration + orient_duration + convert_duration;

        eprintln!(
            "cr3 wasm-open benchmark: decode={} develop={} orient={} to_float={} legacy_to_float={} total={} size={}x{}",
            format_duration(decode_duration),
            format_duration(develop_duration),
            format_duration(orient_duration),
            format_duration(convert_duration),
            format_duration(legacy_convert_duration),
            format_duration(total),
            image.width,
            image.height,
        );

        assert_eq!((image.width, image.height), (3648, 5472));
    }
}

// ── ICC profile detection ─────────────────────────────────────────────────────

/// Detect colour space from embedded ICC profile in a JPEG file.
/// Looks for the APP2 marker (0xFF 0xE2) with "ICC_PROFILE\0" signature.
fn detect_jpeg_colorspace(bytes: &[u8]) -> ColorSpace {
    let icc = extract_jpeg_icc(bytes);
    icc.as_deref()
        .map(identify_icc_profile)
        .unwrap_or(ColorSpace::Srgb)
}

/// Extract the ICC profile bytes from a JPEG APP2 segment.
fn extract_jpeg_icc(bytes: &[u8]) -> Option<Vec<u8>> {
    const ICC_SIG: &[u8] = b"ICC_PROFILE\0";
    let mut i = 2; // skip SOI marker
    while i + 4 < bytes.len() {
        if bytes[i] != 0xFF {
            break;
        }
        let marker = bytes[i + 1];
        let seg_len = u16::from_be_bytes([bytes[i + 2], bytes[i + 3]]) as usize;
        if marker == 0xE2 && i + 4 + ICC_SIG.len() < bytes.len() {
            let payload = &bytes[i + 4..i + 2 + seg_len];
            if payload.starts_with(ICC_SIG) {
                // Skip 2 bytes: chunk_num, total_chunks
                let profile_data = payload[ICC_SIG.len() + 2..].to_vec();
                return Some(profile_data);
            }
        }
        i += 2 + seg_len;
    }
    None
}

/// Detect colour space from a PNG file by looking for the iCCP chunk
/// or the sRGB chunk.
fn detect_png_colorspace(bytes: &[u8]) -> ColorSpace {
    // PNG signature is 8 bytes, then chunks
    if bytes.len() < 8 {
        return ColorSpace::Unknown;
    }
    let mut i = 8;
    while i + 12 <= bytes.len() {
        let len = u32::from_be_bytes([bytes[i], bytes[i + 1], bytes[i + 2], bytes[i + 3]])
            as usize;
        let chunk_type = &bytes[i + 4..i + 8];
        match chunk_type {
            b"sRGB" => return ColorSpace::Srgb,
            b"iCCP" => {
                // iCCP: null-terminated name, 1 byte compression method, compressed profile
                let data = &bytes[i + 8..i + 8 + len];
                // Find null terminator for profile name
                if let Some(null_pos) = data.iter().position(|&b| b == 0) {
                    let profile_name =
                        std::str::from_utf8(&data[..null_pos]).unwrap_or("");
                    return identify_icc_by_name(profile_name);
                }
                return ColorSpace::Custom(vec![]);
            }
            b"gAMA" => {
                // Gamma chunk present but no sRGB/iCCP — treat as sRGB
                return ColorSpace::Srgb;
            }
            b"IDAT" => break, // no more metadata chunks
            _ => {}
        }
        i += 12 + len; // 4 len + 4 type + len data + 4 CRC
    }
    ColorSpace::Unknown
}

/// Identify a common ICC profile by inspecting the 128-byte header.
/// Profile description tag starts at offset 128 in ICC profiles.
/// We use a simpler heuristic: check the color space field at offset 16.
fn identify_icc_profile(icc: &[u8]) -> ColorSpace {
    if icc.len() < 20 {
        return ColorSpace::Unknown;
    }
    // Bytes 16..20: colour space signature
    let cs_sig = &icc[16..20];
    // ICC profile descriptions are often stored as UTF-16LE (null bytes between each char).
    // Strip null bytes to get an ASCII-comparable string for common profile names.
    let ascii: String = icc
        .iter()
        .filter(|&&b| b != 0)
        .map(|&b| b as char)
        .collect();
    if ascii.contains("Adobe RGB") || ascii.contains("AdobeRGB") {
        return ColorSpace::AdobeRgb;
    }
    if ascii.contains("Display P3") || ascii.contains("P3 D65") {
        return ColorSpace::DisplayP3;
    }
    if ascii.contains("ProPhoto") || ascii.contains("ROMM") {
        return ColorSpace::ProPhotoRgb;
    }
    if ascii.contains("sRGB") || cs_sig == b"RGB " {
        return ColorSpace::Srgb;
    }
    // Default: sRGB
    ColorSpace::Srgb
}

/// Identify colour space from the iCCP profile name string.
fn identify_icc_by_name(name: &str) -> ColorSpace {
    let n = name.to_lowercase();
    if n.contains("adobe") {
        ColorSpace::AdobeRgb
    } else if n.contains("p3") {
        ColorSpace::DisplayP3
    } else if n.contains("prophoto") || n.contains("romm") {
        ColorSpace::ProPhotoRgb
    } else if n.contains("srgb") {
        ColorSpace::Srgb
    } else {
        ColorSpace::Custom(vec![])
    }
}
