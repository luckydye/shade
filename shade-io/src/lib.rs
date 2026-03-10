use std::path::Path;
use anyhow::{anyhow, Context, Result};
use image::{DynamicImage, ImageFormat};
use shade_core::{ColorSpace, ColorMatrix3x3};

// ── Public image loading ───────────────────────────────────────────────────────

/// Load an image from disk and return raw RGBA8 bytes along with dimensions.
/// Pixels are returned as-is (still in the source colour space / gamma).
pub fn load_image(path: &Path) -> Result<(Vec<u8>, u32, u32)> {
    let img = image::open(path)
        .with_context(|| format!("Failed to open image: {}", path.display()))?;
    let rgba = img.to_rgba8();
    let (width, height) = rgba.dimensions();
    Ok((rgba.into_raw(), width, height))
}

/// Load an image and also detect its embedded colour space.
/// Returns (pixels_rgba8, width, height, detected_color_space).
pub fn load_image_with_colorspace(path: &Path) -> Result<(Vec<u8>, u32, u32, ColorSpace)> {
    let bytes = std::fs::read(path)
        .with_context(|| format!("Cannot read file: {}", path.display()))?;

    let ext = path.extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();

    let color_space = match ext.as_str() {
        "jpg" | "jpeg" => detect_jpeg_colorspace(&bytes),
        "png"          => detect_png_colorspace(&bytes),
        _              => ColorSpace::Unknown,
    };

    let img = image::load_from_memory(&bytes)
        .with_context(|| format!("Failed to decode image: {}", path.display()))?;
    let rgba = img.to_rgba8();
    let (width, height) = rgba.dimensions();

    Ok((rgba.into_raw(), width, height, color_space))
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
                chunk[0] = (srgb_to_linear(chunk[0] as f32 / 255.0) * 255.0).round().clamp(0.0, 255.0) as u8;
                chunk[1] = (srgb_to_linear(chunk[1] as f32 / 255.0) * 255.0).round().clamp(0.0, 255.0) as u8;
                chunk[2] = (srgb_to_linear(chunk[2] as f32 / 255.0) * 255.0).round().clamp(0.0, 255.0) as u8;
                // alpha unchanged
            }
        }
        ColorSpace::AdobeRgb => {
            apply_matrix_and_linearise(pixels, 2.2, &ColorMatrix3x3::ADOBE_RGB_TO_LINEAR_SRGB);
        }
        ColorSpace::DisplayP3 => {
            apply_matrix_and_linearise(pixels, 2.2, &ColorMatrix3x3::DISPLAY_P3_TO_LINEAR_SRGB);
        }
        ColorSpace::ProPhotoRgb => {
            apply_matrix_and_linearise(pixels, 1.8, &ColorMatrix3x3::PROPHOTO_TO_LINEAR_SRGB);
        }
        ColorSpace::Custom(_) => {
            // Fallback: assume sRGB for unknown embedded profiles
            for chunk in pixels.chunks_exact_mut(4) {
                chunk[0] = (srgb_to_linear(chunk[0] as f32 / 255.0) * 255.0).round().clamp(0.0, 255.0) as u8;
                chunk[1] = (srgb_to_linear(chunk[1] as f32 / 255.0) * 255.0).round().clamp(0.0, 255.0) as u8;
                chunk[2] = (srgb_to_linear(chunk[2] as f32 / 255.0) * 255.0).round().clamp(0.0, 255.0) as u8;
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
                chunk[0] = (linear_to_srgb(chunk[0] as f32 / 255.0) * 255.0).round().clamp(0.0, 255.0) as u8;
                chunk[1] = (linear_to_srgb(chunk[1] as f32 / 255.0) * 255.0).round().clamp(0.0, 255.0) as u8;
                chunk[2] = (linear_to_srgb(chunk[2] as f32 / 255.0) * 255.0).round().clamp(0.0, 255.0) as u8;
            }
        }
        ColorSpace::DisplayP3 => {
            apply_linear_matrix_and_gamma(pixels, &ColorMatrix3x3::LINEAR_SRGB_TO_DISPLAY_P3, 2.2);
        }
        _ => {
            // Default: apply sRGB encoding
            for chunk in pixels.chunks_exact_mut(4) {
                chunk[0] = (linear_to_srgb(chunk[0] as f32 / 255.0) * 255.0).round().clamp(0.0, 255.0) as u8;
                chunk[1] = (linear_to_srgb(chunk[1] as f32 / 255.0) * 255.0).round().clamp(0.0, 255.0) as u8;
                chunk[2] = (linear_to_srgb(chunk[2] as f32 / 255.0) * 255.0).round().clamp(0.0, 255.0) as u8;
            }
        }
    }
}

/// Save raw RGBA8 bytes to a file.
pub fn save_image(path: &Path, data: &[u8], width: u32, height: u32) -> Result<()> {
    let expected = (width * height * 4) as usize;
    if data.len() != expected {
        return Err(anyhow!("save_image: expected {} bytes, got {}", expected, data.len()));
    }
    let img = image::RgbaImage::from_raw(width, height, data.to_vec())
        .ok_or_else(|| anyhow!("save_image: failed to construct RgbaImage"))?;
    let dyn_img = DynamicImage::ImageRgba8(img);
    let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("").to_lowercase();
    let format = match ext.as_str() {
        "png"           => ImageFormat::Png,
        "jpg" | "jpeg"  => ImageFormat::Jpeg,
        "tif" | "tiff"  => ImageFormat::Tiff,
        "webp"          => ImageFormat::WebP,
        other => return Err(anyhow!("Unsupported output format: '.{}'. Use png, jpg, tiff, or webp.", other)),
    };
    if format == ImageFormat::Jpeg {
        dyn_img.to_rgb8().save_with_format(path, format)
            .with_context(|| format!("Failed to save image to {}", path.display()))?;
    } else {
        dyn_img.save_with_format(path, format)
            .with_context(|| format!("Failed to save image to {}", path.display()))?;
    }
    Ok(())
}

// ── Transfer functions ────────────────────────────────────────────────────────

/// sRGB electro-optical transfer function: encoded → linear.
pub fn srgb_to_linear(v: f32) -> f32 {
    if v <= 0.04045 { v / 12.92 } else { ((v + 0.055) / 1.055_f32).powf(2.4) }
}

/// sRGB opto-electrical transfer function: linear → encoded.
pub fn linear_to_srgb(v: f32) -> f32 {
    let v = v.clamp(0.0, 1.0);
    if v <= 0.0031308 { v * 12.92 } else { 1.055 * v.powf(1.0 / 2.4) - 0.055 }
}

// ── Internal helpers ──────────────────────────────────────────────────────────

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
fn apply_linear_matrix_and_gamma(pixels: &mut Vec<u8>, matrix: &ColorMatrix3x3, gamma: f32) {
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

// ── ICC profile detection ─────────────────────────────────────────────────────

/// Detect colour space from embedded ICC profile in a JPEG file.
/// Looks for the APP2 marker (0xFF 0xE2) with "ICC_PROFILE\0" signature.
fn detect_jpeg_colorspace(bytes: &[u8]) -> ColorSpace {
    let icc = extract_jpeg_icc(bytes);
    icc.as_deref().map(identify_icc_profile).unwrap_or(ColorSpace::Srgb)
}

/// Extract the ICC profile bytes from a JPEG APP2 segment.
fn extract_jpeg_icc(bytes: &[u8]) -> Option<Vec<u8>> {
    const ICC_SIG: &[u8] = b"ICC_PROFILE\0";
    let mut i = 2; // skip SOI marker
    while i + 4 < bytes.len() {
        if bytes[i] != 0xFF { break; }
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
    if bytes.len() < 8 { return ColorSpace::Unknown; }
    let mut i = 8;
    while i + 12 <= bytes.len() {
        let len = u32::from_be_bytes([bytes[i], bytes[i+1], bytes[i+2], bytes[i+3]]) as usize;
        let chunk_type = &bytes[i+4..i+8];
        match chunk_type {
            b"sRGB" => return ColorSpace::Srgb,
            b"iCCP" => {
                // iCCP: null-terminated name, 1 byte compression method, compressed profile
                let data = &bytes[i+8..i+8+len];
                // Find null terminator for profile name
                if let Some(null_pos) = data.iter().position(|&b| b == 0) {
                    let profile_name = std::str::from_utf8(&data[..null_pos]).unwrap_or("");
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
    if icc.len() < 20 { return ColorSpace::Unknown; }
    // Bytes 16..20: colour space signature
    let cs_sig = &icc[16..20];
    // Bytes 4..8: CMM type (not useful here)
    // Profile description is more reliable but requires tag table parsing
    // Use a quick scan for known description strings instead
    let profile_str = String::from_utf8_lossy(icc);
    if profile_str.contains("Adobe RGB") || profile_str.contains("AdobeRGB") {
        return ColorSpace::AdobeRgb;
    }
    if profile_str.contains("Display P3") || profile_str.contains("P3 D65") {
        return ColorSpace::DisplayP3;
    }
    if profile_str.contains("ProPhoto") || profile_str.contains("ROMM") {
        return ColorSpace::ProPhotoRgb;
    }
    if profile_str.contains("sRGB") || cs_sig == b"RGB " {
        return ColorSpace::Srgb;
    }
    // Default: sRGB
    ColorSpace::Srgb
}

/// Identify colour space from the iCCP profile name string.
fn identify_icc_by_name(name: &str) -> ColorSpace {
    let n = name.to_lowercase();
    if n.contains("adobe") { ColorSpace::AdobeRgb }
    else if n.contains("p3") { ColorSpace::DisplayP3 }
    else if n.contains("prophoto") || n.contains("romm") { ColorSpace::ProPhotoRgb }
    else if n.contains("srgb") { ColorSpace::Srgb }
    else { ColorSpace::Custom(vec![]) }
}
