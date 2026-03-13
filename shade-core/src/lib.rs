use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// Tone adjustment parameters — must match the WGSL uniform struct layout.
#[repr(C)]
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct ToneParams {
    /// Exposure offset added to linear pixel values.
    pub exposure: f32,
    /// Contrast adjustment, pivoted around 0.18 mid-grey.
    pub contrast: f32,
    /// Black level lift.
    pub blacks: f32,
    /// Highlights compression amount.
    pub highlights: f32,
    /// Shadows lift amount.
    pub shadows: f32,
    /// Gamma exponent applied as pow(rgb, gamma). 1.0 = no change.
    pub gamma: f32,
}

impl Default for ToneParams {
    fn default() -> Self {
        Self {
            exposure: 0.0,
            contrast: 0.0,
            blacks: 0.0,
            highlights: 0.0,
            shadows: 0.0,
            gamma: 1.0,
        }
    }
}

/// Color adjustment parameters.
#[repr(C)]
#[derive(
    Copy, Clone, Debug, Default, Serialize, Deserialize, bytemuck::Pod, bytemuck::Zeroable,
)]
pub struct ColorParams {
    pub saturation: f32,
    pub vibrancy: f32,
    pub temperature: f32,
    pub tint: f32,
}

/// Vignette parameters.
#[repr(C)]
#[derive(Copy, Clone, Debug, Serialize, Deserialize, bytemuck::Pod, bytemuck::Zeroable)]
pub struct VignetteParams {
    pub amount: f32,
    pub midpoint: f32,
    pub feather: f32,
    pub roundness: f32,
}

impl Default for VignetteParams {
    fn default() -> Self {
        Self {
            amount: 0.0,
            midpoint: 0.5,
            feather: 0.2,
            roundness: 1.0,
        }
    }
}

/// Sharpen parameters.
#[repr(C)]
#[derive(
    Copy, Clone, Debug, Default, Serialize, Deserialize, bytemuck::Pod, bytemuck::Zeroable,
)]
pub struct SharpenParams {
    pub amount: f32,
    pub threshold: f32,
}

/// Film grain parameters.
#[repr(C)]
#[derive(Copy, Clone, Debug, Serialize, Deserialize, bytemuck::Pod, bytemuck::Zeroable)]
pub struct GrainParams {
    pub amount: f32,
    pub size: f32,
    pub roughness: f32,
    pub seed: f32,
}

impl Default for GrainParams {
    fn default() -> Self {
        Self {
            amount: 0.0,
            size: 1.0,
            roughness: 0.5,
            seed: 0.0,
        }
    }
}

/// Returns a 256-element identity LUT: [0/255, 1/255, ..., 1.0].
pub fn linear_lut() -> Vec<f32> {
    (0u32..256).map(|i| i as f32 / 255.0).collect()
}

/// Adjustment operations that can be applied to a layer.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum AdjustmentOp {
    Tone {
        exposure: f32,
        contrast: f32,
        blacks: f32,
        highlights: f32,
        shadows: f32,
        gamma: f32,
    },
    Curves {
        lut_r: Vec<f32>,
        lut_g: Vec<f32>,
        lut_b: Vec<f32>,
        lut_master: Vec<f32>,
        per_channel: bool,
    },
    Color(ColorParams),
    Vignette(VignetteParams),
    Sharpen(SharpenParams),
    Grain(GrainParams),
}

/// A unique identifier for a texture resource.
pub type TextureId = u64;

/// Full-precision RGBA image data stored as linear or gamma-encoded `f32` samples.
#[derive(Clone, Debug)]
pub struct FloatImage {
    pub pixels: Vec<f32>,
    pub width: u32,
    pub height: u32,
}

/// A unique identifier for a mask resource.
pub type MaskId = u64;

/// R8 mask data (one byte per pixel, 0=transparent, 255=opaque).
/// Stored as Rgba8 internally but only the R channel is used.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct MaskData {
    pub width: u32,
    pub height: u32,
    /// R8 data (one byte per pixel, 0=transparent, 255=opaque)
    pub pixels: Vec<u8>,
}

impl MaskData {
    pub fn new_full(width: u32, height: u32) -> Self {
        Self {
            width,
            height,
            pixels: vec![255u8; (width * height) as usize],
        }
    }

    pub fn new_empty(width: u32, height: u32) -> Self {
        Self {
            width,
            height,
            pixels: vec![0u8; (width * height) as usize],
        }
    }
}

/// An affine transform (identity by default).
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct AffineTransform {
    pub tx: f32,
    pub ty: f32,
    pub scale_x: f32,
    pub scale_y: f32,
    pub rotation: f32,
}

/// A layer in the edit stack.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum Layer {
    Image {
        texture_id: TextureId,
        transform: AffineTransform,
    },
    Adjustment {
        ops: Vec<AdjustmentOp>,
    },
}

/// Blend modes for layer compositing.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
pub enum BlendMode {
    #[default]
    Normal, // 0
    Multiply,   // 1
    Screen,     // 2
    Overlay,    // 3
    SoftLight,  // 4
    Luminosity, // 5
}

impl BlendMode {
    /// Convert blend mode to the u32 value used in the composite shader.
    pub fn to_u32(self) -> u32 {
        match self {
            BlendMode::Normal => 0,
            BlendMode::Multiply => 1,
            BlendMode::Screen => 2,
            BlendMode::Overlay => 3,
            BlendMode::SoftLight => 4,
            BlendMode::Luminosity => 5,
        }
    }
}

/// Precision level for layer rendering.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
pub enum LayerPrecision {
    #[default]
    Half,
    Full,
}

/// A layer entry in the edit graph with compositing metadata.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LayerEntry {
    pub layer: Layer,
    pub precision: LayerPrecision,
    pub blend_mode: BlendMode,
    pub opacity: f32,
    pub mask: Option<MaskId>,
    pub visible: bool,
}

/// An ordered stack of layers with mask storage and a generation counter.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct LayerStack {
    pub layers: Vec<LayerEntry>,
    pub masks: HashMap<MaskId, MaskData>,
    next_mask_id: u64,
    pub generation: u64,
}

impl LayerStack {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn add_adjustment_layer(&mut self, ops: Vec<AdjustmentOp>) -> usize {
        let idx = self.layers.len();
        self.layers.push(LayerEntry {
            layer: Layer::Adjustment { ops },
            precision: LayerPrecision::Half,
            blend_mode: BlendMode::Normal,
            opacity: 1.0,
            mask: None,
            visible: true,
        });
        self.generation += 1;
        idx
    }

    pub fn add_image_layer(&mut self, texture_id: TextureId, _width: u32, _height: u32) -> usize {
        let idx = self.layers.len();
        self.layers.push(LayerEntry {
            layer: Layer::Image {
                texture_id,
                transform: AffineTransform::default(),
            },
            precision: LayerPrecision::Half,
            blend_mode: BlendMode::Normal,
            opacity: 1.0,
            mask: None,
            visible: true,
        });
        self.generation += 1;
        idx
    }

    pub fn set_mask(&mut self, layer_idx: usize, mask: MaskData) -> MaskId {
        let id = self.next_mask_id;
        self.next_mask_id += 1;
        self.masks.insert(id, mask);
        self.layers[layer_idx].mask = Some(id);
        self.generation += 1;
        id
    }

    pub fn remove_mask(&mut self, layer_idx: usize) {
        if let Some(id) = self.layers[layer_idx].mask.take() {
            self.masks.remove(&id);
        }
        self.generation += 1;
    }
}

/// Known colour spaces with their chromaticities.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum ColorSpace {
    /// Standard sRGB (IEC 61966-2-1). Gamma ≈ 2.2 (piecewise).
    Srgb,
    /// Linear sRGB — same primaries as sRGB but no gamma. Used as internal working space.
    LinearSrgb,
    /// Adobe RGB (1998). Wider gamut, gamma 2.2.
    AdobeRgb,
    /// Display P3 (DCI-P3 with D65 white point). Used in Apple displays.
    DisplayP3,
    /// ProPhoto RGB. Very wide gamut, gamma 1.8.
    ProPhotoRgb,
    /// Custom ICC profile stored as raw bytes.
    Custom(Vec<u8>),
    /// Untagged — treat as sRGB.
    Unknown,
}

impl Default for ColorSpace {
    fn default() -> Self {
        ColorSpace::Srgb
    }
}

impl ColorSpace {
    /// Human-readable name.
    pub fn name(&self) -> &str {
        match self {
            ColorSpace::Srgb => "sRGB",
            ColorSpace::LinearSrgb => "Linear sRGB",
            ColorSpace::AdobeRgb => "Adobe RGB (1998)",
            ColorSpace::DisplayP3 => "Display P3",
            ColorSpace::ProPhotoRgb => "ProPhoto RGB",
            ColorSpace::Custom(_) => "Custom ICC",
            ColorSpace::Unknown => "Unknown (sRGB)",
        }
    }

    /// Whether this space uses a gamma transfer function (vs linear).
    pub fn is_gamma_encoded(&self) -> bool {
        !matches!(self, ColorSpace::LinearSrgb)
    }
}

/// A 3×3 colour transform matrix (row-major, applied as: out = M * in).
/// Transforms linear RGB values between colour spaces.
#[repr(C)]
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct ColorMatrix3x3 {
    pub m: [[f32; 3]; 3],
}

impl ColorMatrix3x3 {
    pub const IDENTITY: Self = Self {
        m: [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]],
    };

    /// Apply matrix to an RGB triple.
    pub fn apply(&self, r: f32, g: f32, b: f32) -> (f32, f32, f32) {
        let out_r = self.m[0][0] * r + self.m[0][1] * g + self.m[0][2] * b;
        let out_g = self.m[1][0] * r + self.m[1][1] * g + self.m[1][2] * b;
        let out_b = self.m[2][0] * r + self.m[2][1] * g + self.m[2][2] * b;
        (out_r, out_g, out_b)
    }

    /// Adobe RGB (1998) → linear sRGB matrix.
    /// Derived from Bradford-adapted primaries.
    pub const ADOBE_RGB_TO_LINEAR_SRGB: Self = Self {
        m: [
            [1.3985, -0.3086, -0.0908], // R row
            [-0.0827, 1.1316, -0.0489], // G row
            [0.0172, -0.0603, 1.0431],  // B row
        ],
    };

    /// Display P3 → linear sRGB matrix.
    pub const DISPLAY_P3_TO_LINEAR_SRGB: Self = Self {
        m: [
            [1.2249, -0.2247, 0.0000],
            [-0.0420, 1.0419, 0.0000],
            [-0.0197, -0.0786, 1.0983],
        ],
    };

    /// ProPhoto RGB → linear sRGB matrix.
    pub const PROPHOTO_TO_LINEAR_SRGB: Self = Self {
        m: [
            [1.3460, -0.2556, -0.0511],
            [-0.5446, 1.5082, 0.0205],
            [0.0000, 0.0000, 1.2152],
        ],
    };

    /// linear sRGB → Display P3 matrix (inverse of DISPLAY_P3_TO_LINEAR_SRGB).
    pub const LINEAR_SRGB_TO_DISPLAY_P3: Self = Self {
        m: [
            [0.8225, 0.1774, 0.0000],
            [0.0332, 0.9669, 0.0000],
            [0.0171, 0.0724, 0.9105],
        ],
    };
}

/// Project-level colour settings.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProjectColorSettings {
    /// Internal working colour space (always LinearSrgb in practice).
    pub working_space: ColorSpace,
    /// Display colour space (for viewport tone-mapping).
    pub display_space: ColorSpace,
    /// Export colour space (for final file output).
    pub export_space: ColorSpace,
}

impl Default for ProjectColorSettings {
    fn default() -> Self {
        Self {
            working_space: ColorSpace::LinearSrgb,
            display_space: ColorSpace::Srgb,
            export_space: ColorSpace::Srgb,
        }
    }
}

/// The main edit graph: an ordered list of layers plus a generation counter
/// for dirty tracking.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct EditGraph {
    pub layers: Vec<LayerEntry>,
    pub generation: u64,
}

impl EditGraph {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn push_layer(&mut self, entry: LayerEntry) {
        self.layers.push(entry);
        self.generation += 1;
    }

    pub fn bump_generation(&mut self) {
        self.generation += 1;
    }
}
