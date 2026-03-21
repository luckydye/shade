use shade_core::{
    build_curve_lut_from_points, linear_lut, AdjustmentOp, ColorParams, CropRect,
    CurveControlPoint, DenoiseParams, FloatImage, GlowParams, GrainParams, HslParams,
    Layer, LayerStack, SharpenParams, TextureId, ToneParams, VignetteParams,
};
use shade_io::to_linear_srgb_f32;
use std::collections::HashMap;

/// Holds the in-memory editor state for the WASM context.
/// This lives in the worker thread.
pub struct WasmEngine {
    pub stack: LayerStack,
    pub image_sources: HashMap<TextureId, FloatImage>,
    pub canvas_width: u32,
    pub canvas_height: u32,
    pub next_texture_id: u64,
}

impl WasmEngine {
    pub fn new() -> Self {
        Self {
            stack: LayerStack::new(),
            image_sources: HashMap::new(),
            canvas_width: 0,
            canvas_height: 0,
            next_texture_id: 1,
        }
    }

    pub fn load_image_data(&mut self, image: FloatImage) -> u64 {
        let id = self.next_texture_id;
        self.next_texture_id += 1;
        self.stack = LayerStack::new();
        self.canvas_width = image.width;
        self.canvas_height = image.height;
        self.image_sources.insert(id, image.clone());
        self.stack.add_image_layer(id, image.width, image.height);
        self.stack.add_adjustment_layer(vec![AdjustmentOp::Tone {
            exposure: 0.0,
            contrast: 0.0,
            blacks: 0.0,
            whites: 0.0,
            highlights: 0.0,
            shadows: 0.0,
            gamma: 1.0,
        }]);
        id
    }

    pub fn load_rgba8_image_data(
        &mut self,
        pixels: Vec<u8>,
        width: u32,
        height: u32,
    ) -> u64 {
        let mut linear_pixels = pixels
                .chunks_exact(4)
                .flat_map(|rgba| {
                    [
                        rgba[0] as f32 / 255.0,
                        rgba[1] as f32 / 255.0,
                        rgba[2] as f32 / 255.0,
                        rgba[3] as f32 / 255.0,
                    ]
                })
                .collect::<Vec<_>>();
        to_linear_srgb_f32(&mut linear_pixels, &shade_core::ColorSpace::Srgb);
        let image = FloatImage {
            pixels: linear_pixels.into(),
            width,
            height,
        };
        self.load_image_data(image)
    }

    pub fn add_layer(&mut self, kind: &str) -> usize {
        match kind {
            "adjustment" => self.stack.add_adjustment_layer(vec![AdjustmentOp::Tone {
                exposure: 0.0,
                contrast: 0.0,
                blacks: 0.0,
                whites: 0.0,
                highlights: 0.0,
                shadows: 0.0,
                gamma: 1.0,
            }]),
            "curves" => self.stack.add_adjustment_layer(vec![AdjustmentOp::Curves {
                lut_r: linear_lut(),
                lut_g: linear_lut(),
                lut_b: linear_lut(),
                lut_master: linear_lut(),
                per_channel: false,
                control_points: None,
            }]),
            "crop" => self.stack.add_crop_layer(CropRect {
                x: 0.0,
                y: 0.0,
                width: self.canvas_width as f32,
                height: self.canvas_height as f32,
                rotation: 0.0,
            }),
            _ => panic!("unknown layer kind: {kind}"),
        }
    }

    pub fn delete_layer(&mut self, layer_idx: usize) {
        assert!(
            layer_idx < self.stack.layers.len(),
            "layer index out of bounds"
        );
        if let Some(mask_id) = self.stack.layers[layer_idx].mask {
            self.stack.masks.remove(&mask_id);
            self.stack.mask_params.remove(&mask_id);
        }
        self.stack.layers.remove(layer_idx);
        self.stack.generation += 1;
    }

    pub fn apply_tone(&mut self, layer_idx: usize, params: ToneParams) {
        if let Some(entry) = self.stack.layers.get_mut(layer_idx) {
            if let shade_core::Layer::Adjustment { ops } = &mut entry.layer {
                let new_op = AdjustmentOp::Tone {
                    exposure: params.exposure,
                    contrast: params.contrast,
                    blacks: params.blacks,
                    whites: params.whites,
                    highlights: params.highlights,
                    shadows: params.shadows,
                    gamma: params.gamma,
                };
                if let Some(op) = ops
                    .iter_mut()
                    .find(|o| matches!(o, AdjustmentOp::Tone { .. }))
                {
                    *op = new_op;
                } else {
                    ops.push(new_op);
                }
                self.stack.generation += 1;
            }
        }
    }

    pub fn apply_color(&mut self, layer_idx: usize, params: ColorParams) {
        if let Some(entry) = self.stack.layers.get_mut(layer_idx) {
            if let shade_core::Layer::Adjustment { ops } = &mut entry.layer {
                if let Some(op) =
                    ops.iter_mut().find(|o| matches!(o, AdjustmentOp::Color(_)))
                {
                    *op = AdjustmentOp::Color(params);
                } else {
                    ops.push(AdjustmentOp::Color(params));
                }
                self.stack.generation += 1;
            }
        }
    }

    pub fn apply_hsl(&mut self, layer_idx: usize, params: HslParams) {
        if let Some(entry) = self.stack.layers.get_mut(layer_idx) {
            if let shade_core::Layer::Adjustment { ops } = &mut entry.layer {
                let new_op = AdjustmentOp::Hsl(params);
                if let Some(op) =
                    ops.iter_mut().find(|o| matches!(o, AdjustmentOp::Hsl(_)))
                {
                    *op = new_op;
                } else {
                    ops.push(new_op);
                }
                self.stack.generation += 1;
            }
        }
    }

    pub fn apply_curves(
        &mut self,
        layer_idx: usize,
        control_points: Vec<CurveControlPoint>,
    ) {
        if let Some(entry) = self.stack.layers.get_mut(layer_idx) {
            if let shade_core::Layer::Adjustment { ops } = &mut entry.layer {
                let lut = build_curve_lut_from_points(&control_points);
                let new_op = AdjustmentOp::Curves {
                    lut_r: lut.clone(),
                    lut_g: lut.clone(),
                    lut_b: lut.clone(),
                    lut_master: lut,
                    per_channel: false,
                    control_points: Some(control_points),
                };
                if let Some(op) = ops
                    .iter_mut()
                    .find(|o| matches!(o, AdjustmentOp::Curves { .. }))
                {
                    *op = new_op;
                } else {
                    ops.push(new_op);
                }
                self.stack.generation += 1;
            }
        }
    }

    pub fn apply_vignette(&mut self, layer_idx: usize, amount: f32) {
        if let Some(entry) = self.stack.layers.get_mut(layer_idx) {
            if let shade_core::Layer::Adjustment { ops } = &mut entry.layer {
                let new_op = AdjustmentOp::Vignette(VignetteParams {
                    amount,
                    ..VignetteParams::default()
                });
                if let Some(op) = ops
                    .iter_mut()
                    .find(|o| matches!(o, AdjustmentOp::Vignette(_)))
                {
                    *op = new_op;
                } else {
                    ops.push(new_op);
                }
                self.stack.generation += 1;
            }
        }
    }

    pub fn apply_sharpen(&mut self, layer_idx: usize, amount: f32) {
        if let Some(entry) = self.stack.layers.get_mut(layer_idx) {
            if let shade_core::Layer::Adjustment { ops } = &mut entry.layer {
                let new_op = AdjustmentOp::Sharpen(SharpenParams {
                    amount,
                    threshold: 0.0,
                });
                if let Some(op) = ops
                    .iter_mut()
                    .find(|o| matches!(o, AdjustmentOp::Sharpen(_)))
                {
                    *op = new_op;
                } else {
                    ops.push(new_op);
                }
                self.stack.generation += 1;
            }
        }
    }

    pub fn apply_grain(&mut self, layer_idx: usize, amount: f32, size: f32) {
        if let Some(entry) = self.stack.layers.get_mut(layer_idx) {
            if let shade_core::Layer::Adjustment { ops } = &mut entry.layer {
                let existing = ops.iter().find_map(|op| match op {
                    AdjustmentOp::Grain(params) => Some(*params),
                    _ => None,
                });
                let new_op = AdjustmentOp::Grain(GrainParams {
                    amount,
                    size,
                    ..existing.unwrap_or_default()
                });
                if let Some(op) =
                    ops.iter_mut().find(|o| matches!(o, AdjustmentOp::Grain(_)))
                {
                    *op = new_op;
                } else {
                    ops.push(new_op);
                }
                self.stack.generation += 1;
            }
        }
    }

    pub fn apply_glow(&mut self, layer_idx: usize, amount: f32) {
        if let Some(entry) = self.stack.layers.get_mut(layer_idx) {
            if let shade_core::Layer::Adjustment { ops } = &mut entry.layer {
                let new_op = AdjustmentOp::Glow(GlowParams {
                    amount,
                    ..GlowParams::default()
                });
                if let Some(op) =
                    ops.iter_mut().find(|o| matches!(o, AdjustmentOp::Glow(_)))
                {
                    *op = new_op;
                } else {
                    ops.push(new_op);
                }
                self.stack.generation += 1;
            }
        }
    }

    pub fn apply_denoise(&mut self, layer_idx: usize, params: DenoiseParams) {
        if let Some(entry) = self.stack.layers.get_mut(layer_idx) {
            if let shade_core::Layer::Adjustment { ops } = &mut entry.layer {
                if let Some(op) = ops
                    .iter_mut()
                    .find(|o| matches!(o, AdjustmentOp::Denoise(_)))
                {
                    *op = AdjustmentOp::Denoise(params);
                } else {
                    ops.push(AdjustmentOp::Denoise(params));
                }
                self.stack.generation += 1;
            }
        }
    }

    pub fn apply_crop(&mut self, layer_idx: usize, rect: CropRect) {
        let normalized = self.normalize_crop_rect(rect);
        let Some(entry) = self.stack.layers.get_mut(layer_idx) else {
            panic!("layer index out of bounds");
        };
        let Layer::Crop { rect: current } = &mut entry.layer else {
            panic!("target layer is not a crop layer");
        };
        *current = normalized;
        self.stack.generation += 1;
    }

    pub fn normalize_crop_rect(&self, rect: CropRect) -> CropRect {
        assert!(
            self.canvas_width > 0 && self.canvas_height > 0,
            "cannot normalize crop without a loaded image"
        );
        let max_x = self.canvas_width.saturating_sub(1) as f32;
        let max_y = self.canvas_height.saturating_sub(1) as f32;
        let x = rect.x.round().clamp(0.0, max_x);
        let y = rect.y.round().clamp(0.0, max_y);
        let width = rect.width.round().clamp(1.0, self.canvas_width as f32 - x);
        let height = rect
            .height
            .round()
            .clamp(1.0, self.canvas_height as f32 - y);
        CropRect {
            x,
            y,
            width,
            height,
            rotation: rect.rotation,
        }
    }

    pub fn layer_count(&self) -> usize {
        self.stack.layers.len()
    }

    pub fn snapshot_render_state(
        &self,
    ) -> (LayerStack, HashMap<TextureId, FloatImage>, u32, u32) {
        (
            self.stack.clone(),
            self.image_sources.clone(),
            self.canvas_width,
            self.canvas_height,
        )
    }
}
