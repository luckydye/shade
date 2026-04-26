extern crate self as shade_lib;

pub mod color_transform;
pub mod composite;
mod context;
pub mod denoise;
mod pipeline;
pub mod pipelines;
pub mod profiler;
mod renderer;
pub mod sharpen2;
pub mod text;
pub mod text_buffer;
pub mod text_outline;
pub mod texture_cache;
pub mod timestamp;

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Arc;

pub const INTERNAL_TEXTURE_FORMAT: wgpu::TextureFormat = wgpu::TextureFormat::Rgba16Float;
pub const WORK_TEXTURE_USAGE: wgpu::TextureUsages = wgpu::TextureUsages::TEXTURE_BINDING
    .union(wgpu::TextureUsages::STORAGE_BINDING)
    .union(wgpu::TextureUsages::COPY_SRC)
    .union(wgpu::TextureUsages::COPY_DST);

pub use color_transform::{ColorTransformPipeline, ColorTransformUniform};
pub use composite::{
    create_rw_mask_texture, upload_mask_texture, BrushStampPipeline, BrushStampUniform,
    CompositePipeline, CompositeUniform,
};
pub use context::GpuContext;
pub use denoise::DenoisePipeline;
pub use pipeline::TonePipeline;
pub use pipelines::{
    ColorPipeline, CropPipeline, CropUniform, CurvesPipeline, GlowPipeline,
    GrainPipeline, HslPipeline, SharpenPipeline, VignettePipeline,
};
pub use profiler::{GpuProfiler, PassTiming};
pub use renderer::{PreviewCrop, Renderer};
pub use sharpen2::SharpenTwoPassPipeline;
pub use text::{
    FontBlobHash, FontEntry, FontId, TextAlign, TextAnchor, TextContent, TextSpan, TextStyle,
};
pub use text_buffer::{
    GlyphBufferLayout, GpuBand, GpuGlyphMeta, GpuPlacedGlyph, PlacedGlyph, FLOATS_PER_CURVE,
};
pub use text_outline::{
    build_bands, outline_glyph, GlyphBand, GlyphCurves, QuadBezier, Rect as GlyphRect,
    DEFAULT_BANDS,
};
pub use texture_cache::TextureCache;

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
    /// White ceiling lift (highlight-targeted additive, mirrors blacks).
    pub whites: f32,
    /// Highlights compression amount.
    pub highlights: f32,
    /// Shadows lift amount.
    pub shadows: f32,
    /// Gamma exponent applied as pow(rgb, gamma). 1.0 = no change.
    pub gamma: f32,
    pub _pad: f32,
}

impl Default for ToneParams {
    fn default() -> Self {
        Self {
            exposure: 0.0,
            contrast: 0.0,
            blacks: 0.0,
            whites: 0.0,
            highlights: 0.0,
            shadows: 0.0,
            gamma: 1.0,
            _pad: 0.0,
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
#[derive(
    Copy, Clone, Debug, Serialize, Deserialize, bytemuck::Pod, bytemuck::Zeroable,
)]
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
#[derive(
    Copy, Clone, Debug, Serialize, Deserialize, bytemuck::Pod, bytemuck::Zeroable,
)]
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

/// Highlight glow / film halation parameters.
#[repr(C)]
#[derive(
    Copy, Clone, Debug, Serialize, Deserialize, bytemuck::Pod, bytemuck::Zeroable,
)]
pub struct GlowParams {
    pub amount: f32,
    pub _pad: [f32; 3],
}

impl Default for GlowParams {
    fn default() -> Self {
        Self {
            amount: 0.0,
            _pad: [0.0; 3],
        }
    }
}

/// Returns a 256-element identity LUT: [0/255, 1/255, ..., 1.0].
pub fn linear_lut() -> Vec<f32> {
    (0u32..256).map(|i| i as f32 / 255.0).collect()
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct CurveControlPoint {
    pub x: f32,
    pub y: f32,
}

fn clamp(value: f32, min: f32, max: f32) -> f32 {
    value.clamp(min, max)
}

fn normalize_curve_points(points: &[CurveControlPoint]) -> Vec<CurveControlPoint> {
    let mut normalized: Vec<CurveControlPoint> = points
        .iter()
        .map(|point| CurveControlPoint {
            x: clamp(point.x.round(), 0.0, 255.0),
            y: clamp(point.y, 0.0, 1.0),
        })
        .collect();
    normalized.sort_by(|a, b| a.x.total_cmp(&b.x));
    normalized.dedup_by(|a, b| a.x == b.x);
    if normalized.first().map(|point| point.x) != Some(0.0) {
        normalized.insert(0, CurveControlPoint { x: 0.0, y: 0.0 });
    }
    if normalized.last().map(|point| point.x) != Some(255.0) {
        normalized.push(CurveControlPoint { x: 255.0, y: 1.0 });
    }
    normalized
}

pub fn build_curve_lut_from_points(points: &[CurveControlPoint]) -> Vec<f32> {
    let anchors = normalize_curve_points(points);
    assert!(
        anchors.len() >= 2,
        "curve requires explicit left and right endpoint clamps"
    );
    assert!(
        anchors[0].x == 0.0,
        "curve must include a left endpoint clamp at x=0"
    );
    assert!(
        anchors[anchors.len() - 1].x == 255.0,
        "curve must include a right endpoint clamp at x=255"
    );

    let mut lut = vec![0.0; 256];
    let mut delta = vec![0.0; anchors.len() - 1];
    let mut tangent = vec![0.0; anchors.len()];

    for i in 0..anchors.len() - 1 {
        let span = anchors[i + 1].x - anchors[i].x;
        assert!(span > 0.0, "curve anchors must be strictly increasing");
        delta[i] = (anchors[i + 1].y - anchors[i].y) / span;
    }

    tangent[0] = delta[0];
    tangent[anchors.len() - 1] = delta[delta.len() - 1];
    for i in 1..anchors.len() - 1 {
        tangent[i] = if delta[i - 1] * delta[i] <= 0.0 {
            0.0
        } else {
            (delta[i - 1] + delta[i]) * 0.5
        };
    }

    for i in 0..delta.len() {
        if delta[i] == 0.0 {
            tangent[i] = 0.0;
            tangent[i + 1] = 0.0;
            continue;
        }
        let a = tangent[i] / delta[i];
        let b = tangent[i + 1] / delta[i];
        let norm = a.hypot(b);
        if norm > 3.0 {
            let scale = 3.0 / norm;
            tangent[i] = scale * a * delta[i];
            tangent[i + 1] = scale * b * delta[i];
        }
    }

    for seg in 0..anchors.len() - 1 {
        let start = anchors[seg];
        let end = anchors[seg + 1];
        let span = end.x - start.x;
        let start_x = start.x as usize;
        let end_x = end.x as usize;
        for x in start_x..=end_x {
            let t = (x as f32 - start.x) / span;
            let t2 = t * t;
            let t3 = t2 * t;
            let h00 = 2.0 * t3 - 3.0 * t2 + 1.0;
            let h10 = t3 - 2.0 * t2 + t;
            let h01 = -2.0 * t3 + 3.0 * t2;
            let h11 = t3 - t2;
            lut[x] = clamp(
                h00 * start.y
                    + h10 * span * tangent[seg]
                    + h01 * end.y
                    + h11 * span * tangent[seg + 1],
                0.0,
                1.0,
            );
        }
    }

    lut
}

/// Denoiser parameters — must match the WGSL uniform struct layout.
///
/// Two algorithms are available:
/// - mode 0 (bilateral): fast joint bilateral filter, suitable for interactive preview
/// - mode 1 (NLM): non-local means with shared-memory tile caching, higher quality for export
#[repr(C)]
#[derive(
    Copy, Clone, Debug, Serialize, Deserialize, bytemuck::Pod, bytemuck::Zeroable,
)]
pub struct DenoiseParams {
    /// Luminance noise reduction strength (0.0 = off, 1.0 = maximum).
    pub luma_strength: f32,
    /// Chroma (colour) noise reduction strength (0.0 = off, 1.0 = maximum).
    pub chroma_strength: f32,
    /// Algorithm: 0 = bilateral (fast), 1 = NLM (quality).
    pub mode: u32,
    pub _pad: f32,
}

impl Default for DenoiseParams {
    fn default() -> Self {
        Self {
            luma_strength: 0.0,
            chroma_strength: 0.0,
            mode: 0,
            _pad: 0.0,
        }
    }
}

/// Per-color HSL adjustment parameters (red, green, blue ranges).
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize, Default)]
pub struct HslParams {
    /// Hue shift for reds (-1 to 1, scaled to ±180° in the shader).
    pub red_hue: f32,
    pub red_sat: f32,
    pub red_lum: f32,
    pub green_hue: f32,
    pub green_sat: f32,
    pub green_lum: f32,
    pub blue_hue: f32,
    pub blue_sat: f32,
    pub blue_lum: f32,
}

/// Adjustment operations that can be applied to a layer.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum AdjustmentOp {
    Tone {
        exposure: f32,
        contrast: f32,
        blacks: f32,
        whites: f32,
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
        control_points: Option<Vec<CurveControlPoint>>,
    },
    LsCurve {
        lut: Vec<f32>,
        control_points: Option<Vec<CurveControlPoint>>,
    },
    Color(ColorParams),
    Vignette(VignetteParams),
    Sharpen(SharpenParams),
    Grain(GrainParams),
    Glow(GlowParams),
    Hsl(HslParams),
    Denoise(DenoiseParams),
}

/// A unique identifier for a texture resource.
pub type TextureId = u64;

/// Full-precision RGBA image data stored as linear or gamma-encoded `f32` samples.
#[derive(Clone, Debug)]
pub struct FloatImage {
    pub pixels: Arc<[f32]>,
    pub width: u32,
    pub height: u32,
}

/// A unique identifier for a mask resource.
pub type MaskId = u64;

pub(crate) mod base64_serde {
    use base64::Engine;
    use serde::{Deserialize, Deserializer, Serializer};

    pub fn serialize<S: Serializer>(bytes: &[u8], s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&base64::engine::general_purpose::STANDARD.encode(bytes))
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<Vec<u8>, D::Error> {
        let s = String::deserialize(d)?;
        base64::engine::general_purpose::STANDARD
            .decode(&s)
            .map_err(serde::de::Error::custom)
    }
}

/// Parameters that define how a mask was generated.
/// For gradient masks, stored so the UI can draw interactive handles.
/// For brush masks, stores the serialized pixel data for persistence.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub enum MaskParams {
    Linear {
        x1: f32,
        y1: f32,
        x2: f32,
        y2: f32,
    },
    Radial {
        cx: f32,
        cy: f32,
        radius: f32,
    },
    Brush {
        width: u32,
        height: u32,
        #[serde(with = "base64_serde")]
        pixels: Vec<u8>,
    },
}

/// R8 mask data (one byte per pixel, 0=transparent, 255=opaque).
/// Stored as Rgba8 internally but only the R channel is used.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct MaskData {
    pub width: u32,
    pub height: u32,
    /// R8 data (one byte per pixel, 0=transparent, 255=opaque)
    pub pixels: Arc<[u8]>,
}

impl MaskData {
    pub fn new_full(width: u32, height: u32) -> Self {
        Self {
            width,
            height,
            pixels: vec![255u8; (width * height) as usize].into(),
        }
    }

    pub fn new_empty(width: u32, height: u32) -> Self {
        Self {
            width,
            height,
            pixels: vec![0u8; (width * height) as usize].into(),
        }
    }

    /// Fill with a linear gradient from (x1,y1) to (x2,y2).
    /// Pixels before the start line are 0, after the end line are 255.
    pub fn fill_linear_gradient(&mut self, x1: f32, y1: f32, x2: f32, y2: f32) {
        let dx = x2 - x1;
        let dy = y2 - y1;
        let len_sq = dx * dx + dy * dy;
        assert!(len_sq > 0.0, "gradient start and end must differ");
        let pixels = Arc::make_mut(&mut self.pixels);
        for row in 0..self.height {
            for col in 0..self.width {
                let px = col as f32 + 0.5;
                let py = row as f32 + 0.5;
                let t = ((px - x1) * dx + (py - y1) * dy) / len_sq;
                let t = t.clamp(0.0, 1.0);
                pixels[(row * self.width + col) as usize] = (t * 255.0) as u8;
            }
        }
    }

    /// Fill with a radial gradient centered at (cx,cy) with given radius.
    /// Center is 255, edge (at radius) is 0.
    pub fn fill_radial_gradient(&mut self, cx: f32, cy: f32, radius: f32) {
        assert!(radius > 0.0, "gradient radius must be positive");
        let pixels = Arc::make_mut(&mut self.pixels);
        for row in 0..self.height {
            for col in 0..self.width {
                let px = col as f32 + 0.5;
                let py = row as f32 + 0.5;
                let dist = ((px - cx).powi(2) + (py - cy).powi(2)).sqrt();
                let t = (1.0 - dist / radius).clamp(0.0, 1.0);
                pixels[(row * self.width + col) as usize] = (t * 255.0) as u8;
            }
        }
    }

    /// Stamp a soft circular brush at (cx, cy) with given radius and softness.
    /// softness=0 → hard edge; softness=1 → smooth cosine falloff to edge.
    /// Pixels are set to the maximum of their current value and the brush alpha.
    /// erase=false → max-blend (paint); erase=true → min-blend (erase).
    pub fn stamp_brush(
        &mut self,
        cx: f32,
        cy: f32,
        radius: f32,
        softness: f32,
        erase: bool,
    ) {
        assert!(radius > 0.0, "brush radius must be positive");
        let r_ceil = radius.ceil() as i32;
        let w = self.width as i32;
        let h = self.height as i32;
        let col_min = (cx as i32 - r_ceil).max(0);
        let col_max = (cx as i32 + r_ceil).min(w - 1);
        let row_min = (cy as i32 - r_ceil).max(0);
        let row_max = (cy as i32 + r_ceil).min(h - 1);
        let radius_sq = radius * radius;
        let hard_edge = 1.0 - softness.clamp(0.0, 1.0);
        let hard_radius = radius * hard_edge;
        let hard_radius_sq = hard_radius * hard_radius;
        let soft_span = (radius - hard_radius).max(f32::EPSILON);
        let pixels = Arc::make_mut(&mut self.pixels);
        for row in row_min..=row_max {
            let row_offset = (row * w) as usize;
            for col in col_min..=col_max {
                let dx = col as f32 + 0.5 - cx;
                let dy = row as f32 + 0.5 - cy;
                let dist_sq = dx * dx + dy * dy;
                if dist_sq > radius_sq {
                    continue;
                }
                let alpha = if dist_sq <= hard_radius_sq {
                    1.0_f32
                } else {
                    let dist = dist_sq.sqrt();
                    let s = (dist - hard_radius) / soft_span;
                    0.5 * (1.0 + (std::f32::consts::PI * s).cos())
                };
                let idx = row_offset + col as usize;
                if erase {
                    let floor = ((1.0 - alpha) * 255.0) as u8;
                    pixels[idx] = pixels[idx].min(floor);
                } else {
                    pixels[idx] = pixels[idx].max((alpha * 255.0) as u8);
                }
            }
        }
    }

    /// Returns a downscaled copy of the mask, fitting within max_w × max_h
    /// using nearest-neighbour sampling.
    pub fn get_thumbnail(&self, max_w: u32, max_h: u32) -> (Vec<u8>, u32, u32) {
        let scale = (max_w as f32 / self.width as f32)
            .min(max_h as f32 / self.height as f32)
            .min(1.0);
        let tw = ((self.width as f32 * scale).round() as u32).max(1);
        let th = ((self.height as f32 * scale).round() as u32).max(1);
        let mut out = vec![0u8; (tw * th) as usize];
        for ty in 0..th {
            for tx in 0..tw {
                let sx = (tx as f32 / tw as f32 * self.width as f32) as u32;
                let sy = (ty as f32 / th as f32 * self.height as f32) as u32;
                out[(ty * tw + tx) as usize] =
                    self.pixels[(sy * self.width + sx) as usize];
            }
        }
        (out, tw, th)
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

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct CropRect {
    pub x: f32,
    pub y: f32,
    pub width: f32,
    pub height: f32,
    pub rotation: f32,
}

/// A layer in the edit stack.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum Layer {
    Image {
        texture_id: TextureId,
        transform: AffineTransform,
    },
    Crop {
        rect: CropRect,
    },
    Adjustment {
        ops: Vec<AdjustmentOp>,
    },
    /// A declarative text layer rasterized at render time.
    /// `style.font_id` must reference an entry in [`LayerStack::fonts`].
    Text {
        content: TextContent,
        style: TextStyle,
        transform: AffineTransform,
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
    #[serde(default)]
    pub name: Option<String>,
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
    pub mask_params: HashMap<MaskId, MaskParams>,
    next_mask_id: u64,
    pub generation: u64,
    /// Fonts referenced by `Layer::Text` entries. Defaulted for backward
    /// compatibility with documents serialized before text layers existed.
    #[serde(default)]
    pub fonts: HashMap<FontId, FontEntry>,
    #[serde(default)]
    next_font_id: FontId,
}

impl LayerStack {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn add_adjustment_layer(&mut self, ops: Vec<AdjustmentOp>) -> usize {
        let idx = self.layers.len();
        self.layers.push(LayerEntry {
            layer: Layer::Adjustment { ops },
            name: None,
            precision: LayerPrecision::Half,
            blend_mode: BlendMode::Normal,
            opacity: 1.0,
            mask: None,
            visible: true,
        });
        self.generation += 1;
        idx
    }

    pub fn add_image_layer(
        &mut self,
        texture_id: TextureId,
        _width: u32,
        _height: u32,
    ) -> usize {
        let idx = self.layers.len();
        self.layers.push(LayerEntry {
            layer: Layer::Image {
                texture_id,
                transform: AffineTransform::default(),
            },
            name: None,
            precision: LayerPrecision::Half,
            blend_mode: BlendMode::Normal,
            opacity: 1.0,
            mask: None,
            visible: true,
        });
        self.generation += 1;
        idx
    }

    pub fn add_crop_layer(&mut self, rect: CropRect) -> usize {
        let idx = self.layers.len();
        self.layers.push(LayerEntry {
            layer: Layer::Crop { rect },
            name: None,
            precision: LayerPrecision::Half,
            blend_mode: BlendMode::Normal,
            opacity: 1.0,
            mask: None,
            visible: true,
        });
        self.generation += 1;
        idx
    }

    /// Add a text layer referencing a font already registered via [`Self::add_font`].
    /// Returns the layer index.
    pub fn add_text_layer(&mut self, content: TextContent, style: TextStyle) -> usize {
        let idx = self.layers.len();
        self.layers.push(LayerEntry {
            layer: Layer::Text {
                content,
                style,
                transform: AffineTransform::default(),
            },
            name: None,
            precision: LayerPrecision::Half,
            blend_mode: BlendMode::Normal,
            opacity: 1.0,
            mask: None,
            visible: true,
        });
        self.generation += 1;
        idx
    }

    /// Register a font blob, returning a [`FontId`]. If a font with the same
    /// content hash is already registered, returns the existing id without
    /// duplicating the blob.
    pub fn add_font(&mut self, family: impl Into<String>, blob: Vec<u8>) -> FontId {
        let entry = FontEntry::new(family, blob);
        if let Some(existing) = self.find_font_by_hash(entry.blob_hash) {
            return existing;
        }
        let id = self.next_font_id;
        self.next_font_id += 1;
        self.fonts.insert(id, entry);
        self.generation += 1;
        id
    }

    /// Look up a previously registered font by its content hash.
    pub fn find_font_by_hash(&self, hash: FontBlobHash) -> Option<FontId> {
        self.fonts
            .iter()
            .find(|(_, e)| e.blob_hash == hash)
            .map(|(id, _)| *id)
    }

    /// Drop fonts not referenced by any [`Layer::Text`] entry. Returns the
    /// number of fonts evicted.
    pub fn remove_unused_fonts(&mut self) -> usize {
        let mut referenced: std::collections::HashSet<FontId> =
            std::collections::HashSet::new();
        for entry in &self.layers {
            if let Layer::Text { style, content, .. } = &entry.layer {
                referenced.insert(style.font_id);
                for span in &content.spans {
                    if let Some(id) = span.override_font {
                        referenced.insert(id);
                    }
                }
            }
        }
        let before = self.fonts.len();
        self.fonts.retain(|id, _| referenced.contains(id));
        let removed = before - self.fonts.len();
        if removed > 0 {
            self.generation += 1;
        }
        removed
    }

    pub fn set_mask(&mut self, layer_idx: usize, mask: MaskData) -> MaskId {
        let id = self.next_mask_id;
        self.next_mask_id += 1;
        self.masks.insert(id, mask);
        self.layers[layer_idx].mask = Some(id);
        self.generation += 1;
        id
    }

    pub fn set_mask_with_params(
        &mut self,
        layer_idx: usize,
        mask: MaskData,
        params: MaskParams,
    ) -> MaskId {
        let id = self.set_mask(layer_idx, mask);
        self.mask_params.insert(id, params);
        id
    }

    pub fn get_mask_params(&self, layer_idx: usize) -> Option<&MaskParams> {
        let id = self.layers[layer_idx].mask?;
        self.mask_params.get(&id)
    }

    pub fn remove_mask(&mut self, layer_idx: usize) {
        if let Some(id) = self.layers[layer_idx].mask.take() {
            self.masks.remove(&id);
            self.mask_params.remove(&id);
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mask_new_full_is_all_opaque() {
        let m = MaskData::new_full(4, 4);
        assert!(m.pixels.iter().all(|&p| p == 255));
    }

    #[test]
    fn mask_new_empty_is_all_transparent() {
        let m = MaskData::new_empty(4, 4);
        assert!(m.pixels.iter().all(|&p| p == 0));
    }

    // ── Linear gradient ──────────────────────────────────────────────────────

    #[test]
    fn linear_gradient_top_to_bottom() {
        let mut m = MaskData::new_empty(1, 256);
        m.fill_linear_gradient(0.0, 0.0, 0.0, 256.0);
        // First pixel near 0, last pixel near 255
        assert!(m.pixels[0] < 2, "top should be ~0, got {}", m.pixels[0]);
        assert!(
            m.pixels[255] > 253,
            "bottom should be ~255, got {}",
            m.pixels[255]
        );
        // Monotonically non-decreasing
        for i in 1..256 {
            assert!(m.pixels[i] >= m.pixels[i - 1]);
        }
    }

    #[test]
    fn linear_gradient_left_to_right() {
        let mut m = MaskData::new_empty(256, 1);
        m.fill_linear_gradient(0.0, 0.0, 256.0, 0.0);
        assert!(m.pixels[0] < 2);
        assert!(m.pixels[255] > 253);
        for i in 1..256 {
            assert!(m.pixels[i] >= m.pixels[i - 1]);
        }
    }

    #[test]
    fn linear_gradient_clamps_outside_range() {
        let mut m = MaskData::new_empty(100, 1);
        // Gradient from x=25 to x=75 — pixels before 25 should be 0, after 75 should be 255
        m.fill_linear_gradient(25.0, 0.0, 75.0, 0.0);
        assert_eq!(m.pixels[0], 0, "before gradient start should be 0");
        assert_eq!(m.pixels[99], 255, "after gradient end should be 255");
    }

    #[test]
    fn linear_gradient_reversed_direction() {
        let mut m = MaskData::new_empty(1, 100);
        // Bottom to top: y2 < y1
        m.fill_linear_gradient(0.0, 100.0, 0.0, 0.0);
        // First row (y=0) is the "end" → near 255, last row (y=99) is the "start" → near 0
        assert!(
            m.pixels[0] > 250,
            "top should be bright, got {}",
            m.pixels[0]
        );
        assert!(
            m.pixels[99] < 5,
            "bottom should be dark, got {}",
            m.pixels[99]
        );
    }

    // ── Radial gradient ──────────────────────────────────────────────────────

    #[test]
    fn radial_gradient_center_is_bright_edge_is_dark() {
        let mut m = MaskData::new_empty(101, 101);
        m.fill_radial_gradient(50.5, 50.5, 50.0);
        let center = m.pixels[50 * 101 + 50];
        let corner = m.pixels[0]; // (0,0)
        assert!(center > 250, "center should be ~255, got {center}");
        assert!(corner < 5, "corner should be ~0, got {corner}");
    }

    #[test]
    fn radial_gradient_symmetry() {
        let mut m = MaskData::new_empty(100, 100);
        m.fill_radial_gradient(50.0, 50.0, 40.0);
        // Check horizontal symmetry around center
        for y in 0..100 {
            let left = m.pixels[y * 100 + 10];
            let right = m.pixels[y * 100 + 89];
            assert!(
                (left as i16 - right as i16).unsigned_abs() <= 1,
                "row {y}: left={left}, right={right} should be symmetric"
            );
        }
    }

    #[test]
    fn radial_gradient_outside_radius_is_zero() {
        let mut m = MaskData::new_empty(200, 200);
        m.fill_radial_gradient(100.0, 100.0, 30.0);
        // Pixel at (0, 0) is well outside radius=30 from center=(100,100)
        assert_eq!(m.pixels[0], 0);
        // Pixel at (199, 199) also outside
        assert_eq!(m.pixels[199 * 200 + 199], 0);
    }

    // ── LayerStack mask management ───────────────────────────────────────────

    #[test]
    fn set_mask_attaches_to_layer() {
        let mut stack = LayerStack::new();
        stack.add_adjustment_layer(vec![]);
        let mask = MaskData::new_full(10, 10);
        let id = stack.set_mask(0, mask);
        assert_eq!(stack.layers[0].mask, Some(id));
        assert!(stack.masks.contains_key(&id));
    }

    #[test]
    fn remove_mask_detaches_from_layer() {
        let mut stack = LayerStack::new();
        stack.add_adjustment_layer(vec![]);
        let mask = MaskData::new_full(10, 10);
        let id = stack.set_mask(0, mask);
        stack.remove_mask(0);
        assert_eq!(stack.layers[0].mask, None);
        assert!(!stack.masks.contains_key(&id));
    }

    #[test]
    fn set_mask_bumps_generation() {
        let mut stack = LayerStack::new();
        stack.add_adjustment_layer(vec![]);
        let gen_before = stack.generation;
        stack.set_mask(0, MaskData::new_empty(1, 1));
        assert!(stack.generation > gen_before);
    }

    #[test]
    fn multiple_masks_get_unique_ids() {
        let mut stack = LayerStack::new();
        stack.add_adjustment_layer(vec![]);
        stack.add_adjustment_layer(vec![]);
        let id1 = stack.set_mask(0, MaskData::new_full(1, 1));
        let id2 = stack.set_mask(1, MaskData::new_empty(1, 1));
        assert_ne!(id1, id2);
    }

    // ── MaskParams storage ───────────────────────────────────────────────

    #[test]
    fn set_mask_with_params_stores_params() {
        let mut stack = LayerStack::new();
        stack.add_adjustment_layer(vec![]);
        let mask = MaskData::new_empty(100, 100);
        let params = MaskParams::Linear {
            x1: 0.0,
            y1: 0.0,
            x2: 0.0,
            y2: 100.0,
        };
        let id = stack.set_mask_with_params(0, mask, params);
        assert!(stack.mask_params.contains_key(&id));
        match stack.get_mask_params(0) {
            Some(MaskParams::Linear { y2, .. }) => assert_eq!(*y2, 100.0),
            other => panic!("expected Linear params, got {:?}", other),
        }
    }

    #[test]
    fn set_mask_with_params_radial() {
        let mut stack = LayerStack::new();
        stack.add_adjustment_layer(vec![]);
        let mask = MaskData::new_empty(100, 100);
        let params = MaskParams::Radial {
            cx: 50.0,
            cy: 50.0,
            radius: 40.0,
        };
        stack.set_mask_with_params(0, mask, params);
        match stack.get_mask_params(0) {
            Some(MaskParams::Radial { cx, cy, radius }) => {
                assert_eq!(*cx, 50.0);
                assert_eq!(*cy, 50.0);
                assert_eq!(*radius, 40.0);
            }
            other => panic!("expected Radial params, got {:?}", other),
        }
    }

    #[test]
    fn remove_mask_clears_params() {
        let mut stack = LayerStack::new();
        stack.add_adjustment_layer(vec![]);
        let mask = MaskData::new_empty(10, 10);
        let params = MaskParams::Linear {
            x1: 0.0,
            y1: 0.0,
            x2: 10.0,
            y2: 0.0,
        };
        let id = stack.set_mask_with_params(0, mask, params);
        stack.remove_mask(0);
        assert!(!stack.mask_params.contains_key(&id));
        assert!(stack.get_mask_params(0).is_none());
    }

    #[test]
    fn get_mask_params_returns_none_without_mask() {
        let mut stack = LayerStack::new();
        stack.add_adjustment_layer(vec![]);
        assert!(stack.get_mask_params(0).is_none());
    }

    #[test]
    fn set_mask_without_params_has_no_params() {
        let mut stack = LayerStack::new();
        stack.add_adjustment_layer(vec![]);
        stack.set_mask(0, MaskData::new_full(10, 10));
        // set_mask (not set_mask_with_params) should not store params
        assert!(stack.get_mask_params(0).is_none());
    }

    // ── Text layers & font cache ─────────────────────────────────────────

    #[test]
    fn add_font_returns_distinct_ids_for_different_blobs() {
        let mut stack = LayerStack::new();
        let a = stack.add_font("A", b"alpha".to_vec());
        let b = stack.add_font("B", b"beta".to_vec());
        assert_ne!(a, b);
        assert_eq!(stack.fonts.len(), 2);
    }

    #[test]
    fn add_font_dedups_identical_blobs() {
        let mut stack = LayerStack::new();
        let a = stack.add_font("First", b"same".to_vec());
        let b = stack.add_font("Second-call-different-label", b"same".to_vec());
        assert_eq!(a, b);
        assert_eq!(stack.fonts.len(), 1);
    }

    #[test]
    fn add_font_bumps_generation_only_when_new() {
        let mut stack = LayerStack::new();
        let g0 = stack.generation;
        stack.add_font("A", b"x".to_vec());
        let g1 = stack.generation;
        assert!(g1 > g0);
        stack.add_font("A2", b"x".to_vec()); // dedup hit
        assert_eq!(stack.generation, g1, "dedup hit should not bump generation");
    }

    #[test]
    fn add_text_layer_appends_with_defaults() {
        let mut stack = LayerStack::new();
        let font_id = stack.add_font("Sans", b"font-bytes".to_vec());
        let idx = stack
            .add_text_layer(TextContent::new("Hello"), TextStyle::new(font_id, 32.0));
        assert_eq!(idx, 0);
        let entry = &stack.layers[0];
        assert!(entry.visible);
        assert_eq!(entry.opacity, 1.0);
        assert_eq!(entry.blend_mode, BlendMode::Normal);
        match &entry.layer {
            Layer::Text { content, style, .. } => {
                assert_eq!(content.text, "Hello");
                assert_eq!(style.font_id, font_id);
                assert_eq!(style.size_px, 32.0);
            }
            other => panic!("expected text layer, got {other:?}"),
        }
    }

    #[test]
    fn remove_unused_fonts_keeps_referenced_and_drops_others() {
        let mut stack = LayerStack::new();
        let used = stack.add_font("Used", b"u".to_vec());
        let _orphan = stack.add_font("Orphan", b"o".to_vec());
        stack.add_text_layer(TextContent::new("hi"), TextStyle::new(used, 16.0));
        let removed = stack.remove_unused_fonts();
        assert_eq!(removed, 1);
        assert!(stack.fonts.contains_key(&used));
        assert_eq!(stack.fonts.len(), 1);
    }

    #[test]
    fn remove_unused_fonts_keeps_span_referenced_fonts() {
        let mut stack = LayerStack::new();
        let primary = stack.add_font("Primary", b"p".to_vec());
        let secondary = stack.add_font("Secondary", b"s".to_vec());
        let mut content = TextContent::new("ab");
        content.spans.push(TextSpan {
            range: 1..2,
            override_font: Some(secondary),
            override_color: None,
            override_size_px: None,
            override_weight: None,
            override_italic: None,
        });
        stack.add_text_layer(content, TextStyle::new(primary, 16.0));
        assert_eq!(stack.remove_unused_fonts(), 0);
        assert_eq!(stack.fonts.len(), 2);
    }

    #[test]
    fn layer_stack_serde_round_trip_with_text_layer() {
        let mut stack = LayerStack::new();
        let font_id = stack.add_font("Sans", b"abc".to_vec());
        stack.add_text_layer(TextContent::new("Hi"), TextStyle::new(font_id, 24.0));

        let json = serde_json::to_string(&stack).unwrap();
        let back: LayerStack = serde_json::from_str(&json).unwrap();
        assert_eq!(back.layers.len(), 1);
        assert_eq!(back.fonts.len(), 1);
        match &back.layers[0].layer {
            Layer::Text { content, style, .. } => {
                assert_eq!(content.text, "Hi");
                assert_eq!(style.font_id, font_id);
            }
            other => panic!("expected text layer, got {other:?}"),
        }
        assert_eq!(back.fonts[&font_id].blob, b"abc");
    }

    #[test]
    fn layer_stack_deserializes_from_legacy_json_without_fonts() {
        // Documents serialized before text layers had no `fonts`/`next_font_id`
        // fields; the `#[serde(default)]` attributes must absorb their absence.
        let legacy = r#"{
            "layers": [],
            "masks": {},
            "mask_params": {},
            "next_mask_id": 0,
            "generation": 0
        }"#;
        let stack: LayerStack = serde_json::from_str(legacy).unwrap();
        assert!(stack.fonts.is_empty());
    }

    #[test]
    fn curve_lut_respects_endpoint_clamps() {
        let lut = build_curve_lut_from_points(&[
            CurveControlPoint { x: 0.0, y: 0.2 },
            CurveControlPoint { x: 64.0, y: 0.25 },
            CurveControlPoint { x: 128.0, y: 0.5 },
            CurveControlPoint { x: 192.0, y: 0.75 },
            CurveControlPoint { x: 255.0, y: 0.8 },
        ]);
        assert!(
            (lut[0] - 0.2).abs() < 0.0001,
            "left clamp should drive lut[0]"
        );
        assert!(
            (lut[255] - 0.8).abs() < 0.0001,
            "right clamp should drive lut[255]"
        );
    }
}
