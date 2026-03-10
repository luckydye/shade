use std::path::Path;

use anyhow::{anyhow, Context, Result};
use image::{DynamicImage, ImageFormat};

/// Load an image from disk and return raw RGBA8 bytes along with dimensions.
///
/// Supports any format recognised by the `image` crate (JPEG, PNG, TIFF, WebP, …).
/// The returned buffer has length `width * height * 4` bytes, in row-major order,
/// each pixel as `[R, G, B, A]` with values in `0..=255`.
pub fn load_image(path: &Path) -> Result<(Vec<u8>, u32, u32)> {
    let img = image::open(path)
        .with_context(|| format!("Failed to open image: {}", path.display()))?;
    let rgba = img.to_rgba8();
    let (width, height) = rgba.dimensions();
    Ok((rgba.into_raw(), width, height))
}

/// Save raw RGBA8 bytes to a file.
///
/// The output format is inferred from the file extension:
///   `.png`  → PNG (lossless)
///   `.jpg` / `.jpeg` → JPEG
///   `.tif` / `.tiff` → TIFF
///   `.webp` → WebP
///
/// `data` must have exactly `width * height * 4` bytes.
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

    // For JPEG output, convert to RGB (no alpha channel).
    if format == ImageFormat::Jpeg {
        let rgb_img = dyn_img.to_rgb8();
        rgb_img
            .save_with_format(path, format)
            .with_context(|| format!("Failed to save image to {}", path.display()))?;
    } else {
        dyn_img
            .save_with_format(path, format)
            .with_context(|| format!("Failed to save image to {}", path.display()))?;
    }

    Ok(())
}
