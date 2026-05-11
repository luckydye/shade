//! Colour-space conversion utilities operating on f32 RGBA pixel buffers.
//!
//! Mirrors the GPU pipeline in [`color_transform`](crate::color_transform), but
//! runs on the CPU. Used by image loaders and exporters that need to normalise
//! into / out of the ACEScct working space without paying for a GPU round-trip.

use crate::{ColorMatrix3x3, ColorSpace};

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

/// ACEScct EOTF: encoded → linear AP1.
pub fn acescct_to_linear_channel(v: f32) -> f32 {
    // Y_BRK = (log2(0.0078125) + 9.72) / 17.52
    if v < 0.155_251_141_6 {
        (v - 0.072_905_534_2) / 10.540_237_74
    } else {
        f32::powf(2.0, v * 17.52 - 9.72)
    }
}

/// ACEScct OETF: linear AP1 → encoded.
pub fn linear_to_acescct_channel(v: f32) -> f32 {
    if v <= 0.007_812_5 {
        10.540_237_74 * v + 0.072_905_534_2
    } else {
        (v.max(f32::MIN_POSITIVE).log2() + 9.72) / 17.52
    }
}

// ── Pixel-buffer conversions ──────────────────────────────────────────────────

/// Convert RGBA f32 pixels from `src` colour space into ACEScct (AP1 log, the internal working space).
pub fn to_acescct_f32(pixels: &mut [f32], color_space: &ColorSpace) {
    match color_space {
        ColorSpace::AcesCct => {}
        ColorSpace::LinearSrgb => {
            for chunk in pixels.chunks_exact_mut(4) {
                let (r, g, b) = ColorMatrix3x3::LINEAR_SRGB_TO_AP1.apply(chunk[0], chunk[1], chunk[2]);
                chunk[0] = linear_to_acescct_channel(r);
                chunk[1] = linear_to_acescct_channel(g);
                chunk[2] = linear_to_acescct_channel(b);
            }
        }
        ColorSpace::Srgb | ColorSpace::Unknown => {
            for chunk in pixels.chunks_exact_mut(4) {
                let (r, g, b) = ColorMatrix3x3::LINEAR_SRGB_TO_AP1.apply(
                    srgb_to_linear(chunk[0]),
                    srgb_to_linear(chunk[1]),
                    srgb_to_linear(chunk[2]),
                );
                chunk[0] = linear_to_acescct_channel(r);
                chunk[1] = linear_to_acescct_channel(g);
                chunk[2] = linear_to_acescct_channel(b);
            }
        }
        ColorSpace::AdobeRgb => {
            for chunk in pixels.chunks_exact_mut(4) {
                let (r, g, b) = ColorMatrix3x3::ADOBE_RGB_TO_AP1.apply(
                    chunk[0].powf(2.2),
                    chunk[1].powf(2.2),
                    chunk[2].powf(2.2),
                );
                chunk[0] = linear_to_acescct_channel(r);
                chunk[1] = linear_to_acescct_channel(g);
                chunk[2] = linear_to_acescct_channel(b);
            }
        }
        ColorSpace::DisplayP3 => {
            // P3 uses the sRGB transfer function
            for chunk in pixels.chunks_exact_mut(4) {
                let (r, g, b) = ColorMatrix3x3::DISPLAY_P3_TO_AP1.apply(
                    srgb_to_linear(chunk[0]),
                    srgb_to_linear(chunk[1]),
                    srgb_to_linear(chunk[2]),
                );
                chunk[0] = linear_to_acescct_channel(r);
                chunk[1] = linear_to_acescct_channel(g);
                chunk[2] = linear_to_acescct_channel(b);
            }
        }
        ColorSpace::ProPhotoRgb => {
            for chunk in pixels.chunks_exact_mut(4) {
                let (r, g, b) = ColorMatrix3x3::PROPHOTO_TO_AP1.apply(
                    chunk[0].powf(1.8),
                    chunk[1].powf(1.8),
                    chunk[2].powf(1.8),
                );
                chunk[0] = linear_to_acescct_channel(r);
                chunk[1] = linear_to_acescct_channel(g);
                chunk[2] = linear_to_acescct_channel(b);
            }
        }
        ColorSpace::Custom(_) => {
            // Treat as sRGB
            for chunk in pixels.chunks_exact_mut(4) {
                let (r, g, b) = ColorMatrix3x3::LINEAR_SRGB_TO_AP1.apply(
                    srgb_to_linear(chunk[0]),
                    srgb_to_linear(chunk[1]),
                    srgb_to_linear(chunk[2]),
                );
                chunk[0] = linear_to_acescct_channel(r);
                chunk[1] = linear_to_acescct_channel(g);
                chunk[2] = linear_to_acescct_channel(b);
            }
        }
    }
}

/// Convert RGBA f32 pixels from ACEScct (AP1 log, the internal working space) to `dst` colour space.
pub fn from_acescct_f32(pixels: &mut [f32], color_space: &ColorSpace) {
    match color_space {
        ColorSpace::AcesCct => {}
        ColorSpace::LinearSrgb => {
            for chunk in pixels.chunks_exact_mut(4) {
                let (r, g, b) = ColorMatrix3x3::AP1_TO_LINEAR_SRGB.apply(
                    acescct_to_linear_channel(chunk[0]),
                    acescct_to_linear_channel(chunk[1]),
                    acescct_to_linear_channel(chunk[2]),
                );
                chunk[0] = r;
                chunk[1] = g;
                chunk[2] = b;
            }
        }
        ColorSpace::DisplayP3 => {
            for chunk in pixels.chunks_exact_mut(4) {
                let (r, g, b) = ColorMatrix3x3::AP1_TO_DISPLAY_P3.apply(
                    acescct_to_linear_channel(chunk[0]),
                    acescct_to_linear_channel(chunk[1]),
                    acescct_to_linear_channel(chunk[2]),
                );
                chunk[0] = linear_to_srgb(r);
                chunk[1] = linear_to_srgb(g);
                chunk[2] = linear_to_srgb(b);
            }
        }
        _ => {
            // Default: sRGB output
            for chunk in pixels.chunks_exact_mut(4) {
                let (r, g, b) = ColorMatrix3x3::AP1_TO_LINEAR_SRGB.apply(
                    acescct_to_linear_channel(chunk[0]),
                    acescct_to_linear_channel(chunk[1]),
                    acescct_to_linear_channel(chunk[2]),
                );
                chunk[0] = linear_to_srgb(r);
                chunk[1] = linear_to_srgb(g);
                chunk[2] = linear_to_srgb(b);
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
        ColorSpace::AcesCct => { /* already in working space */ }
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

// ── LUTs ──────────────────────────────────────────────────────────────────────

/// 256-entry LUT mapping u8 sRGB-encoded values to linear-light f32.
pub fn linear_srgb_lut_u8() -> &'static [f32; 256] {
    static LUT: std::sync::OnceLock<[f32; 256]> = std::sync::OnceLock::new();
    LUT.get_or_init(|| std::array::from_fn(|idx| srgb_to_linear(idx as f32 / 255.0)))
}

/// 65536-entry LUT mapping u16 sRGB-encoded values to linear-light f32.
pub fn linear_srgb_lut_u16() -> &'static [f32; 65536] {
    static LUT: std::sync::OnceLock<Box<[f32; 65536]>> = std::sync::OnceLock::new();
    LUT.get_or_init(|| {
        Box::new(std::array::from_fn(|idx| {
            srgb_to_linear(idx as f32 / 65535.0)
        }))
    })
}

// ── Quantisation ──────────────────────────────────────────────────────────────

fn float_to_u8(value: f32) -> u8 {
    if value.is_nan() {
        return 0;
    }
    (value.clamp(0.0, 1.0) * 255.0).round() as u8
}

/// Clamp and quantise an RGBA f32 buffer to 8-bit unsigned bytes.
pub fn quantize_rgba_f32(pixels: &[f32]) -> Vec<u8> {
    pixels.iter().map(|channel| float_to_u8(*channel)).collect()
}

// ── Matrix helpers ────────────────────────────────────────────────────────────

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
