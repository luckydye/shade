use serde::{Deserialize, Serialize};

/// Tone adjustment parameters — must match the WGSL uniform struct layout.
#[repr(C)]
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct ToneParams {
    /// Exposure in EV stops; applied as 2^exposure multiplier.
    pub exposure: f32,
    /// Contrast adjustment, pivoted around 0.18 mid-grey.
    pub contrast: f32,
    /// Black level lift.
    pub blacks: f32,
    /// Highlights compression amount.
    pub highlights: f32,
    /// Shadows lift amount.
    pub shadows: f32,
}

impl Default for ToneParams {
    fn default() -> Self {
        Self {
            exposure: 0.0,
            contrast: 0.0,
            blacks: 0.0,
            highlights: 0.0,
            shadows: 0.0,
        }
    }
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
    },
}

/// A unique identifier for a texture resource.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct TextureId(pub u64);

/// An affine transform (identity by default).
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct AffineTransform {
    pub matrix: [[f32; 3]; 3],
}

impl Default for AffineTransform {
    fn default() -> Self {
        // Identity matrix
        Self {
            matrix: [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]],
        }
    }
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
    Normal,
    Multiply,
    Screen,
    Overlay,
    SoftLight,
    Luminosity,
}

/// A layer entry in the edit graph with compositing metadata.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LayerEntry {
    pub layer: Layer,
    pub blend_mode: BlendMode,
    pub opacity: f32,
    pub visible: bool,
}

impl LayerEntry {
    pub fn new_adjustment(ops: Vec<AdjustmentOp>) -> Self {
        Self {
            layer: Layer::Adjustment { ops },
            blend_mode: BlendMode::Normal,
            opacity: 1.0,
            visible: true,
        }
    }

    pub fn new_image(texture_id: TextureId) -> Self {
        Self {
            layer: Layer::Image {
                texture_id,
                transform: AffineTransform::default(),
            },
            blend_mode: BlendMode::Normal,
            opacity: 1.0,
            visible: true,
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
