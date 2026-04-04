use anyhow::{anyhow, Context, Result};
use exif::{In, Tag};
use exr::meta::{attribute::SampleType, MetaData};
use exr::prelude::{ReadChannels, ReadLayers};
use image::{ColorType, DynamicImage, ImageDecoder, ImageFormat, ImageReader};
use rawler::{
    decoders::{Orientation as RawOrientation, RawDecodeParams},
    imgop::develop::RawDevelop,
    rawsource::RawSource,
    RawImage,
};
use shade_core::{ColorMatrix3x3, ColorSpace, FloatImage};
use std::path::Path;
use std::{convert::TryFrom, io::Cursor};

#[cfg(feature = "native")]
pub mod app_config;
#[cfg(feature = "native")]
pub mod camera_services;
#[cfg(feature = "native")]
pub mod image_loader;
#[cfg(feature = "native")]
pub mod library_index;
#[cfg(feature = "native")]
pub mod library_scan_service;
#[cfg(feature = "native")]
pub mod library_source;
#[cfg(feature = "native")]
pub mod thumbnail_loader;
#[cfg(feature = "native")]
pub mod thumbnail_queue;
#[cfg(feature = "ffmpeg")]
pub mod video_decoder;
#[cfg(feature = "ffmpeg")]
pub mod video_encoder;

#[cfg(feature = "native")]
pub use app_config::{
    app_config_path, append_library_order_id, is_peer_paired, load_app_config,
    normalize_library_order, pair_peer, remove_library_order_id, save_app_config,
    upsert_library_config, AppConfig,
};
#[cfg(feature = "native")]
pub use camera_services::{CameraDiscoveryService, CameraThumbnailService};
#[cfg(feature = "native")]
pub use image_loader::{load_picture_bytes, open_image, OpenedImage};
#[cfg(feature = "native")]
pub use library_index::{
    delete_persisted_library_index, has_persisted_library_index,
    has_persisted_library_index_by_root, indexed_library_image_for_path,
    is_supported_library_image, library_index_db_path, load_persisted_library_index,
    load_persisted_library_index_by_root, picture_display_name,
    replace_persisted_library_index, replace_persisted_library_index_by_root,
    scan_directory_images, sort_indexed_library_items, IndexedLibraryImage,
    PersistedLibraryIndex,
};
#[cfg(feature = "native")]
pub use library_scan_service::{
    flush_library_scan_batch, scan_library_into_snapshot, start_library_scan,
    LibraryScanService, LibraryScanSnapshot,
};
#[cfg(feature = "native")]
pub use library_source::{
    camera_library_id, delete_s3_object, display_s3_library_name,
    format_s3_library_detail, get_s3_object_bytes, library_config_id, list_s3_objects,
    list_s3_objects_page, local_library_id, media_path_for_s3_object,
    normalize_s3_library_input, parse_s3_media_path, peer_library_id,
    put_s3_object_bytes, resolve_s3_source_id_from_library_id, s3_library_id,
    AddS3LibraryParams, CameraLibraryConfig, LibraryConfig, LocalLibraryConfig,
    PeerLibraryConfig, S3LibraryConfig, S3ObjectEntry, S3ObjectListPage,
};
#[cfg(feature = "native")]
pub use thumbnail_loader::{
    generate_desktop_thumbnail, load_thumbnail_bytes, spawn_thumbnail_workers,
    ThumbnailResponseSender,
};
#[cfg(feature = "native")]
pub use thumbnail_queue::{PendingThumbnailJob, ThumbnailJob, ThumbnailQueue};
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
    let (pixels, width, height, _) = load_image_bytes_with_colorspace(
        &bytes,
        path.file_name().and_then(|name| name.to_str()),
    )
    .with_context(|| format!("Failed to decode image: {}", path.display()))?;
    Ok((pixels, width, height))
}

/// Load an encoded image from memory and return raw RGBA8 bytes along with dimensions.
/// `name_hint` is used only for format detection when the payload itself is ambiguous.
pub fn load_image_bytes(
    bytes: &[u8],
    name_hint: Option<&str>,
) -> Result<(Vec<u8>, u32, u32)> {
    let (pixels, width, height, _) = load_image_bytes_with_colorspace(bytes, name_hint)?;
    Ok((pixels, width, height))
}

pub fn load_image_f32(path: &Path) -> Result<FloatImage> {
    let (image, _) = load_image_f32_with_colorspace(path)?;
    Ok(image)
}

pub fn load_image_bytes_f32(bytes: &[u8], name_hint: Option<&str>) -> Result<FloatImage> {
    let (image, _) = load_image_bytes_f32_with_colorspace(bytes, name_hint)?;
    Ok(image)
}

/// Load an image and also detect its embedded colour space.
/// Returns (pixels_rgba8, width, height, detected_color_space).
pub fn load_image_with_colorspace(
    path: &Path,
) -> Result<(Vec<u8>, u32, u32, ColorSpace)> {
    let bytes = std::fs::read(path)
        .with_context(|| format!("Cannot read file: {}", path.display()))?;
    load_image_bytes_with_colorspace(
        &bytes,
        path.file_name().and_then(|name| name.to_str()),
    )
    .with_context(|| format!("Failed to decode image: {}", path.display()))
}

pub fn load_image_f32_with_colorspace(path: &Path) -> Result<(FloatImage, ColorSpace)> {
    let bytes = std::fs::read(path)
        .with_context(|| format!("Cannot read file: {}", path.display()))?;
    load_image_bytes_f32_with_colorspace(
        &bytes,
        path.file_name().and_then(|name| name.to_str()),
    )
    .with_context(|| format!("Failed to decode image: {}", path.display()))
}

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

/// Load an encoded image from memory and also detect its colour space.
pub fn load_image_bytes_with_colorspace(
    bytes: &[u8],
    name_hint: Option<&str>,
) -> Result<(Vec<u8>, u32, u32, ColorSpace)> {
    if is_exr(name_hint, bytes) {
        let (pixels, width, height) = decode_exr(bytes)?;
        return Ok((pixels, width, height, ColorSpace::LinearSrgb));
    }
    if is_camera_raw(name_hint, bytes) {
        let (pixels, width, height) = decode_camera_raw(bytes, name_hint)?;
        return Ok((pixels, width, height, ColorSpace::Srgb));
    }

    let ext = name_hint
        .and_then(|name| Path::new(name).extension())
        .and_then(|ext| ext.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();

    let color_space = match ext.as_str() {
        "jpg" | "jpeg" => detect_jpeg_colorspace(&bytes),
        "png" => detect_png_colorspace(&bytes),
        _ => ColorSpace::Unknown,
    };

    let img = apply_orientation(
        image::load_from_memory(&bytes).context("Failed to decode image bytes")?,
        read_orientation(&mut Cursor::new(bytes))?,
    );
    let rgba = img.to_rgba8();
    let (width, height) = rgba.dimensions();

    Ok((rgba.into_raw(), width, height, color_space))
}

pub fn load_image_bytes_f32_with_colorspace(
    bytes: &[u8],
    name_hint: Option<&str>,
) -> Result<(FloatImage, ColorSpace)> {
    if is_exr(name_hint, bytes) {
        return Ok((decode_exr_f32(bytes)?, ColorSpace::LinearSrgb));
    }
    if is_camera_raw(name_hint, bytes) {
        return Ok((decode_camera_raw_f32(bytes, name_hint)?, ColorSpace::Srgb));
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

    let rgba = apply_orientation(
        image::load_from_memory(bytes).context("Failed to decode image bytes")?,
        read_orientation(&mut Cursor::new(bytes))?,
    )
    .to_rgba32f();
    let (width, height) = rgba.dimensions();
    Ok((
        FloatImage {
            pixels: rgba.into_raw().into(),
            width,
            height,
        },
        color_space,
    ))
}

pub fn load_image_bytes_f32_with_info(
    bytes: &[u8],
    name_hint: Option<&str>,
) -> Result<(FloatImage, SourceImageInfo)> {
    if is_exr(name_hint, bytes) {
        return Ok((
            decode_exr_f32(bytes)?,
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
        let rgba = apply_orientation(
            develop_raw_image(&raw_image)?,
            raw_orientation_to_exif(raw_image.orientation),
        )
        .into_rgba32f();
        let (width, height) = rgba.dimensions();
        let mut pixels = rgba.into_raw();
        to_linear_srgb_f32(&mut pixels, &ColorSpace::Srgb);
        return Ok((
            FloatImage {
                pixels: pixels.into(),
                width,
                height,
            },
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

    let decoder = ImageReader::new(Cursor::new(bytes))
        .with_guessed_format()
        .context("Failed to guess image format")?
        .into_decoder()
        .context("Failed to create image decoder")?;
    let color_type = decoder.color_type();
    let bit_depth = decoder_color_type_label(color_type);
    let image = apply_orientation(
        image::load_from_memory(bytes).context("Failed to decode image bytes")?,
        read_orientation(&mut Cursor::new(bytes))?,
    );
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

/// Convert RGBA8 pixels from `src_space` to **linear sRGB** in-place.
///
/// This is the normalisation step applied to every source image on load.
/// The engine always works in linear sRGB internally.
pub fn to_linear_srgb(pixels: &mut Vec<u8>, color_space: &ColorSpace) {
    match color_space {
        ColorSpace::LinearSrgb => { /* already linear, nothing to do */ }
        ColorSpace::Srgb | ColorSpace::Unknown => {
            // Remove sRGB gamma → linear
            for chunk in pixels.chunks_exact_mut(4) {
                chunk[0] = (srgb_to_linear(chunk[0] as f32 / 255.0) * 255.0)
                    .round()
                    .clamp(0.0, 255.0) as u8;
                chunk[1] = (srgb_to_linear(chunk[1] as f32 / 255.0) * 255.0)
                    .round()
                    .clamp(0.0, 255.0) as u8;
                chunk[2] = (srgb_to_linear(chunk[2] as f32 / 255.0) * 255.0)
                    .round()
                    .clamp(0.0, 255.0) as u8;
                // alpha unchanged
            }
        }
        ColorSpace::AdobeRgb => {
            apply_matrix_and_linearise(
                pixels,
                2.2,
                &ColorMatrix3x3::ADOBE_RGB_TO_LINEAR_SRGB,
            );
        }
        ColorSpace::DisplayP3 => {
            apply_matrix_and_linearise(
                pixels,
                2.2,
                &ColorMatrix3x3::DISPLAY_P3_TO_LINEAR_SRGB,
            );
        }
        ColorSpace::ProPhotoRgb => {
            apply_matrix_and_linearise(
                pixels,
                1.8,
                &ColorMatrix3x3::PROPHOTO_TO_LINEAR_SRGB,
            );
        }
        ColorSpace::Custom(_) => {
            // Fallback: assume sRGB for unknown embedded profiles
            for chunk in pixels.chunks_exact_mut(4) {
                chunk[0] = (srgb_to_linear(chunk[0] as f32 / 255.0) * 255.0)
                    .round()
                    .clamp(0.0, 255.0) as u8;
                chunk[1] = (srgb_to_linear(chunk[1] as f32 / 255.0) * 255.0)
                    .round()
                    .clamp(0.0, 255.0) as u8;
                chunk[2] = (srgb_to_linear(chunk[2] as f32 / 255.0) * 255.0)
                    .round()
                    .clamp(0.0, 255.0) as u8;
            }
        }
    }
}

/// Convert RGBA8 pixels from **linear sRGB** to `dst_space` for display/export.
pub fn from_linear_srgb(pixels: &mut Vec<u8>, color_space: &ColorSpace) {
    match color_space {
        ColorSpace::LinearSrgb => { /* nothing to do */ }
        ColorSpace::Srgb | ColorSpace::Unknown => {
            for chunk in pixels.chunks_exact_mut(4) {
                chunk[0] = (linear_to_srgb(chunk[0] as f32 / 255.0) * 255.0)
                    .round()
                    .clamp(0.0, 255.0) as u8;
                chunk[1] = (linear_to_srgb(chunk[1] as f32 / 255.0) * 255.0)
                    .round()
                    .clamp(0.0, 255.0) as u8;
                chunk[2] = (linear_to_srgb(chunk[2] as f32 / 255.0) * 255.0)
                    .round()
                    .clamp(0.0, 255.0) as u8;
            }
        }
        ColorSpace::DisplayP3 => {
            apply_linear_matrix_and_gamma(
                pixels,
                &ColorMatrix3x3::LINEAR_SRGB_TO_DISPLAY_P3,
                2.2,
            );
        }
        _ => {
            // Default: apply sRGB encoding
            for chunk in pixels.chunks_exact_mut(4) {
                chunk[0] = (linear_to_srgb(chunk[0] as f32 / 255.0) * 255.0)
                    .round()
                    .clamp(0.0, 255.0) as u8;
                chunk[1] = (linear_to_srgb(chunk[1] as f32 / 255.0) * 255.0)
                    .round()
                    .clamp(0.0, 255.0) as u8;
                chunk[2] = (linear_to_srgb(chunk[2] as f32 / 255.0) * 255.0)
                    .round()
                    .clamp(0.0, 255.0) as u8;
            }
        }
    }
}

pub fn to_linear_srgb_f32(pixels: &mut [f32], color_space: &ColorSpace) {
    match color_space {
        ColorSpace::LinearSrgb => {}
        ColorSpace::Srgb | ColorSpace::Unknown => {
            for chunk in pixels.chunks_exact_mut(4) {
                chunk[0] = srgb_to_linear(chunk[0]);
                chunk[1] = srgb_to_linear(chunk[1]);
                chunk[2] = srgb_to_linear(chunk[2]);
            }
        }
        ColorSpace::AdobeRgb => apply_matrix_and_linearise_f32(
            pixels,
            2.2,
            &ColorMatrix3x3::ADOBE_RGB_TO_LINEAR_SRGB,
        ),
        ColorSpace::DisplayP3 => apply_matrix_and_linearise_f32(
            pixels,
            2.2,
            &ColorMatrix3x3::DISPLAY_P3_TO_LINEAR_SRGB,
        ),
        ColorSpace::ProPhotoRgb => apply_matrix_and_linearise_f32(
            pixels,
            1.8,
            &ColorMatrix3x3::PROPHOTO_TO_LINEAR_SRGB,
        ),
        ColorSpace::Custom(_) => {
            for chunk in pixels.chunks_exact_mut(4) {
                chunk[0] = srgb_to_linear(chunk[0]);
                chunk[1] = srgb_to_linear(chunk[1]);
                chunk[2] = srgb_to_linear(chunk[2]);
            }
        }
    }
}

pub fn from_linear_srgb_f32(pixels: &mut [f32], color_space: &ColorSpace) {
    match color_space {
        ColorSpace::LinearSrgb => {}
        ColorSpace::Srgb | ColorSpace::Unknown => {
            for chunk in pixels.chunks_exact_mut(4) {
                chunk[0] = linear_to_srgb(chunk[0]);
                chunk[1] = linear_to_srgb(chunk[1]);
                chunk[2] = linear_to_srgb(chunk[2]);
            }
        }
        ColorSpace::DisplayP3 => apply_linear_matrix_and_gamma_f32(
            pixels,
            &ColorMatrix3x3::LINEAR_SRGB_TO_DISPLAY_P3,
            2.2,
        ),
        _ => {
            for chunk in pixels.chunks_exact_mut(4) {
                chunk[0] = linear_to_srgb(chunk[0]);
                chunk[1] = linear_to_srgb(chunk[1]);
                chunk[2] = linear_to_srgb(chunk[2]);
            }
        }
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

// ── Transfer functions ────────────────────────────────────────────────────────

/// sRGB electro-optical transfer function: encoded → linear.
pub fn srgb_to_linear(v: f32) -> f32 {
    if v <= 0.04045 {
        v / 12.92
    } else {
        ((v + 0.055) / 1.055_f32).powf(2.4)
    }
}

/// sRGB opto-electrical transfer function: linear → encoded.
pub fn linear_to_srgb(v: f32) -> f32 {
    let v = v.clamp(0.0, 1.0);
    if v <= 0.0031308 {
        v * 12.92
    } else {
        1.055 * v.powf(1.0 / 2.4) - 0.055
    }
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

fn decode_exr(bytes: &[u8]) -> Result<(Vec<u8>, u32, u32)> {
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

    let width =
        u32::try_from(image.layer_data.size.width()).context("EXR width exceeds u32")?;
    let height = u32::try_from(image.layer_data.size.height())
        .context("EXR height exceeds u32")?;
    let float_pixels = image.layer_data.channel_data.pixels.data;
    let mut rgba = Vec::with_capacity(float_pixels.len());
    for channel in float_pixels {
        rgba.push(float_to_u8(channel));
    }

    Ok((rgba, width, height))
}

fn decode_camera_raw(
    bytes: &[u8],
    name_hint: Option<&str>,
) -> Result<(Vec<u8>, u32, u32)> {
    let raw_source = match name_hint {
        Some(name) => RawSource::new_from_slice(bytes).with_path(name),
        None => RawSource::new_from_slice(bytes),
    };
    let raw_image = rawler::decode(&raw_source, &RawDecodeParams::default())
        .context("RAW decode failed")?;
    let image = apply_orientation(
        develop_raw_image(&raw_image)?,
        raw_orientation_to_exif(raw_image.orientation),
    );
    let rgba = image.to_rgba8();
    let (width, height) = rgba.dimensions();
    Ok((rgba.into_raw(), width, height))
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

fn decode_camera_raw_f32(bytes: &[u8], name_hint: Option<&str>) -> Result<FloatImage> {
    let raw_source = match name_hint {
        Some(name) => RawSource::new_from_slice(bytes).with_path(name),
        None => RawSource::new_from_slice(bytes),
    };
    let raw_image = rawler::decode(&raw_source, &RawDecodeParams::default())
        .context("RAW decode failed")?;
    let rgba = apply_orientation(
        develop_raw_image(&raw_image)?,
        raw_orientation_to_exif(raw_image.orientation),
    )
    .to_rgba32f();
    let (width, height) = rgba.dimensions();
    Ok(FloatImage {
        pixels: rgba.into_raw().into(),
        width,
        height,
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
            to_linear_srgb_f32(&mut pixels, color_space);
            FloatImage {
                pixels: pixels.into(),
                width,
                height,
            }
        }
    }
}

fn rgba8_to_linear_float_image(image: image::RgbaImage) -> FloatImage {
    let (width, height) = image.dimensions();
    let linear_lut = linear_srgb_lut_u8();
    let pixels = image
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
    to_linear_srgb_f32(&mut pixels, color_space);
    FloatImage {
        pixels: pixels.into(),
        width,
        height,
    }
}

fn linear_srgb_lut_u8() -> &'static [f32; 256] {
    static LUT: std::sync::OnceLock<[f32; 256]> = std::sync::OnceLock::new();
    LUT.get_or_init(|| std::array::from_fn(|idx| srgb_to_linear(idx as f32 / 255.0)))
}

fn develop_raw_image(raw_image: &RawImage) -> Result<DynamicImage> {
    RawDevelop::default()
        .develop_intermediate(raw_image)
        .context("RAW development failed")?
        .to_dynamic_image()
        .ok_or_else(|| anyhow!("RAW development produced an invalid image buffer"))
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

fn float_to_u8(value: f32) -> u8 {
    if value.is_nan() {
        return 0;
    }
    (value.clamp(0.0, 1.0) * 255.0).round() as u8
}

pub fn quantize_rgba_f32(pixels: &[f32]) -> Vec<u8> {
    pixels.iter().map(|channel| float_to_u8(*channel)).collect()
}

/// Decode gamma, apply matrix, result is linear sRGB.
fn apply_matrix_and_linearise(pixels: &mut Vec<u8>, gamma: f32, matrix: &ColorMatrix3x3) {
    for chunk in pixels.chunks_exact_mut(4) {
        let r = (chunk[0] as f32 / 255.0).powf(gamma);
        let g = (chunk[1] as f32 / 255.0).powf(gamma);
        let b = (chunk[2] as f32 / 255.0).powf(gamma);
        let (or, og, ob) = matrix.apply(r, g, b);
        chunk[0] = (or.clamp(0.0, 1.0) * 255.0).round() as u8;
        chunk[1] = (og.clamp(0.0, 1.0) * 255.0).round() as u8;
        chunk[2] = (ob.clamp(0.0, 1.0) * 255.0).round() as u8;
    }
}

/// Apply matrix then encode gamma. Linear sRGB → destination space.
fn apply_linear_matrix_and_gamma(
    pixels: &mut Vec<u8>,
    matrix: &ColorMatrix3x3,
    gamma: f32,
) {
    let inv_gamma = 1.0 / gamma;
    for chunk in pixels.chunks_exact_mut(4) {
        let r = chunk[0] as f32 / 255.0;
        let g = chunk[1] as f32 / 255.0;
        let b = chunk[2] as f32 / 255.0;
        let (or, og, ob) = matrix.apply(r, g, b);
        chunk[0] = (or.clamp(0.0, 1.0).powf(inv_gamma) * 255.0).round() as u8;
        chunk[1] = (og.clamp(0.0, 1.0).powf(inv_gamma) * 255.0).round() as u8;
        chunk[2] = (ob.clamp(0.0, 1.0).powf(inv_gamma) * 255.0).round() as u8;
    }
}

fn apply_matrix_and_linearise_f32(
    pixels: &mut [f32],
    gamma: f32,
    matrix: &ColorMatrix3x3,
) {
    for chunk in pixels.chunks_exact_mut(4) {
        let r = chunk[0].max(0.0).powf(gamma);
        let g = chunk[1].max(0.0).powf(gamma);
        let b = chunk[2].max(0.0).powf(gamma);
        let (or, og, ob) = matrix.apply(r, g, b);
        chunk[0] = or;
        chunk[1] = og;
        chunk[2] = ob;
    }
}

fn apply_linear_matrix_and_gamma_f32(
    pixels: &mut [f32],
    matrix: &ColorMatrix3x3,
    gamma: f32,
) {
    let inv_gamma = 1.0 / gamma;
    for chunk in pixels.chunks_exact_mut(4) {
        let (or, og, ob) = matrix.apply(chunk[0], chunk[1], chunk[2]);
        chunk[0] = or.max(0.0).powf(inv_gamma);
        chunk[1] = og.max(0.0).powf(inv_gamma);
        chunk[2] = ob.max(0.0).powf(inv_gamma);
    }
}

#[cfg(test)]
mod tests {
    use super::{load_image, load_image_f32_with_info};
    use std::path::Path;

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
