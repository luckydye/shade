use shade_lib::{
    build_curve_lut_from_points, linear_lut, AdjustmentOp, ColorParams, CropRect,
    CurveControlPoint, DenoiseParams, FloatImage, FontEntry, FontId, GlowParams, GrainParams,
    HslParams, Layer, LayerStack, MaskData, MaskParams, SharpenParams, TextAlign, TextAnchor,
    TextContent, TextStyle, TextureId, ToneParams, VignetteParams,
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
        let width = image.width;
        let height = image.height;
        self.stack = LayerStack::new();
        self.canvas_width = width;
        self.canvas_height = height;
        self.image_sources.clear();
        self.image_sources.insert(id, image);
        self.stack.add_image_layer(id, width, height);
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
        to_linear_srgb_f32(&mut linear_pixels, &shade_lib::ColorSpace::Srgb);
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
            "ls_curve" => self.stack.add_adjustment_layer(vec![AdjustmentOp::LsCurve {
                lut: linear_lut(),
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

    pub fn rename_layer(&mut self, layer_idx: usize, name: Option<String>) {
        let Some(layer) = self.stack.layers.get_mut(layer_idx) else {
            panic!("layer index out of bounds");
        };
        layer.name = name
            .as_ref()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty());
        self.stack.generation += 1;
    }

    pub fn apply_gradient_mask(&mut self, layer_idx: usize, params: MaskParams) {
        assert!(
            layer_idx < self.stack.layers.len(),
            "layer index out of bounds"
        );
        let mut mask = MaskData::new_empty(self.canvas_width, self.canvas_height);
        match &params {
            MaskParams::Linear { x1, y1, x2, y2 } => {
                mask.fill_linear_gradient(*x1, *y1, *x2, *y2);
            }
            MaskParams::Radial { cx, cy, radius } => {
                mask.fill_radial_gradient(*cx, *cy, *radius);
            }
            MaskParams::Brush { .. } => {
                panic!("brush masks must be created via create_brush_mask");
            }
        }
        self.stack.set_mask_with_params(layer_idx, mask, params);
    }

    pub fn create_brush_mask(&mut self, layer_idx: usize) {
        assert!(
            layer_idx < self.stack.layers.len(),
            "layer index out of bounds"
        );
        let mask = MaskData::new_empty(self.canvas_width, self.canvas_height);
        let params = MaskParams::Brush {
            width: self.canvas_width,
            height: self.canvas_height,
            pixels: Vec::new(),
        };
        self.stack.set_mask_with_params(layer_idx, mask, params);
    }

    pub fn stamp_brush_mask(
        &mut self,
        layer_idx: usize,
        cx: f32,
        cy: f32,
        radius: f32,
        softness: f32,
        erase: bool,
    ) {
        assert!(
            layer_idx < self.stack.layers.len(),
            "layer index out of bounds"
        );
        let mask_id = self.stack.layers[layer_idx]
            .mask
            .expect("layer has no mask");
        let mask = self
            .stack
            .masks
            .get_mut(&mask_id)
            .expect("mask data missing");
        mask.stamp_brush(cx, cy, radius, softness, erase);
        let params = self
            .stack
            .mask_params
            .get_mut(&mask_id)
            .expect("mask params missing");
        match params {
            MaskParams::Brush { width, height, .. } => {
                *width = mask.width;
                *height = mask.height;
            }
            _ => panic!("brush mask stamp requires a brush mask"),
        }
        self.stack.generation += 1;
    }

    pub fn remove_mask(&mut self, layer_idx: usize) {
        assert!(
            layer_idx < self.stack.layers.len(),
            "layer index out of bounds"
        );
        self.stack.remove_mask(layer_idx);
    }

    pub fn apply_tone(&mut self, layer_idx: usize, params: ToneParams) {
        if let Some(entry) = self.stack.layers.get_mut(layer_idx) {
            if let shade_lib::Layer::Adjustment { ops } = &mut entry.layer {
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
            if let shade_lib::Layer::Adjustment { ops } = &mut entry.layer {
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
            if let shade_lib::Layer::Adjustment { ops } = &mut entry.layer {
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
            if let shade_lib::Layer::Adjustment { ops } = &mut entry.layer {
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

    pub fn apply_ls_curve(
        &mut self,
        layer_idx: usize,
        control_points: Vec<CurveControlPoint>,
    ) {
        if let Some(entry) = self.stack.layers.get_mut(layer_idx) {
            if let shade_lib::Layer::Adjustment { ops } = &mut entry.layer {
                let lut = build_curve_lut_from_points(&control_points);
                let new_op = AdjustmentOp::LsCurve {
                    lut,
                    control_points: Some(control_points),
                };
                if let Some(op) = ops
                    .iter_mut()
                    .find(|o| matches!(o, AdjustmentOp::LsCurve { .. }))
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
            if let shade_lib::Layer::Adjustment { ops } = &mut entry.layer {
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
            if let shade_lib::Layer::Adjustment { ops } = &mut entry.layer {
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
            if let shade_lib::Layer::Adjustment { ops } = &mut entry.layer {
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
            if let shade_lib::Layer::Adjustment { ops } = &mut entry.layer {
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
            if let shade_lib::Layer::Adjustment { ops } = &mut entry.layer {
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

    pub fn replace_non_image_layers(
        &mut self,
        layers: Vec<shade_lib::LayerEntry>,
        saved_mask_params: HashMap<shade_lib::MaskId, shade_lib::MaskParams>,
    ) {
        let image_layers: Vec<_> = self
            .stack
            .layers
            .iter()
            .filter(|l| matches!(l.layer, Layer::Image { .. }))
            .cloned()
            .collect();
        assert!(!image_layers.is_empty(), "no image layers to preserve");
        self.stack.layers = image_layers;
        self.stack.masks.clear();
        self.stack.mask_params.clear();
        let base_idx = self.stack.layers.len();
        self.stack.layers.extend(layers);
        for i in base_idx..self.stack.layers.len() {
            let Some(old_id) = self.stack.layers[i].mask else {
                continue;
            };
            let Some(params) = saved_mask_params.get(&old_id) else {
                self.stack.layers[i].mask = None;
                continue;
            };
            let mask = match params {
                MaskParams::Linear { x1, y1, x2, y2 } => {
                    let mut m = MaskData::new_empty(self.canvas_width, self.canvas_height);
                    m.fill_linear_gradient(*x1, *y1, *x2, *y2);
                    m
                }
                MaskParams::Radial { cx, cy, radius } => {
                    let mut m = MaskData::new_empty(self.canvas_width, self.canvas_height);
                    m.fill_radial_gradient(*cx, *cy, *radius);
                    m
                }
                MaskParams::Brush {
                    width,
                    height,
                    pixels,
                } => MaskData {
                    width: *width,
                    height: *height,
                    pixels: pixels.clone().into(),
                },
            };
            self.stack.set_mask_with_params(i, mask, params.clone());
        }
        self.stack.generation += 1;
    }

    pub fn layer_count(&self) -> usize {
        self.stack.layers.len()
    }

    // ── Text layers & fonts ─────────────────────────────────────────────

    /// Register a font blob, returning its FontId. Idempotent on contents.
    pub fn add_font(&mut self, family: &str, blob: Vec<u8>) -> FontId {
        self.stack.add_font(family, blob)
    }

    /// `(font_id, family, blob_hash)` for every registered font.
    pub fn list_fonts(&self) -> Vec<(FontId, String, u64)> {
        let mut out: Vec<_> = self
            .stack
            .fonts
            .iter()
            .map(|(id, e)| (*id, e.family.clone(), e.blob_hash))
            .collect();
        out.sort_by_key(|(id, _, _)| *id);
        out
    }

    pub fn add_text_layer(&mut self, content: &str, font_id: FontId, size_px: f32) -> usize {
        let mut style = TextStyle::new(font_id, size_px);
        style.color = [1.0, 1.0, 1.0, 1.0];
        self.stack
            .add_text_layer(TextContent::new(content), style)
    }

    pub fn update_text_content(&mut self, layer_idx: usize, content: &str) {
        if let Some(entry) = self.stack.layers.get_mut(layer_idx) {
            if let Layer::Text { content: c, .. } = &mut entry.layer {
                *c = TextContent::new(content);
                self.stack.generation += 1;
            }
        }
    }

    /// Update fields on a text layer's `TextStyle`. `None` arguments leave
    /// the corresponding field unchanged.
    #[allow(clippy::too_many_arguments)]
    pub fn update_text_style(
        &mut self,
        layer_idx: usize,
        font_id: Option<FontId>,
        size_px: Option<f32>,
        line_height: Option<f32>,
        letter_spacing: Option<f32>,
        max_width: Option<Option<f32>>,
        align: Option<TextAlign>,
        anchor: Option<TextAnchor>,
        weight: Option<u16>,
        italic: Option<bool>,
        color: Option<[f32; 4]>,
    ) {
        let Some(entry) = self.stack.layers.get_mut(layer_idx) else {
            return;
        };
        let Layer::Text { style, .. } = &mut entry.layer else {
            return;
        };
        if let Some(v) = font_id {
            style.font_id = v;
        }
        if let Some(v) = size_px {
            style.size_px = v;
        }
        if let Some(v) = line_height {
            style.line_height = v;
        }
        if let Some(v) = letter_spacing {
            style.letter_spacing = v;
        }
        if let Some(v) = max_width {
            style.max_width = v;
        }
        if let Some(v) = align {
            style.align = v;
        }
        if let Some(v) = anchor {
            style.anchor = v;
        }
        if let Some(v) = weight {
            style.weight = v;
        }
        if let Some(v) = italic {
            style.italic = v;
        }
        if let Some(v) = color {
            style.color = v;
        }
        self.stack.generation += 1;
    }

    pub fn set_text_transform(
        &mut self,
        layer_idx: usize,
        tx: f32,
        ty: f32,
        scale_x: f32,
        scale_y: f32,
        rotation: f32,
    ) {
        if let Some(entry) = self.stack.layers.get_mut(layer_idx) {
            if let Layer::Text { transform, .. } = &mut entry.layer {
                transform.tx = tx;
                transform.ty = ty;
                transform.scale_x = scale_x;
                transform.scale_y = scale_y;
                transform.rotation = rotation;
                self.stack.generation += 1;
            }
        }
    }

    /// Drop fonts not referenced by any text layer. Returns count removed.
    pub fn prune_unused_fonts(&mut self) -> usize {
        self.stack.remove_unused_fonts()
    }

    #[allow(dead_code)]
    pub fn font_entry(&self, font_id: FontId) -> Option<&FontEntry> {
        self.stack.fonts.get(&font_id)
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

#[cfg(test)]
mod tests {
    use super::WasmEngine;
    use shade_lib::MaskParams;

    fn create_engine() -> WasmEngine {
        let mut engine = WasmEngine::new();
        engine.load_rgba8_image_data(vec![0, 0, 0, 255, 0, 0, 0, 255], 1, 2);
        engine
    }

    #[test]
    fn apply_gradient_mask_stores_mask_params() {
        let mut engine = create_engine();

        engine.apply_gradient_mask(
            1,
            MaskParams::Linear {
                x1: 0.0,
                y1: 0.0,
                x2: 0.0,
                y2: 2.0,
            },
        );

        let mask_id = engine.stack.layers[1]
            .mask
            .expect("mask should be attached");
        let params = engine
            .stack
            .mask_params
            .get(&mask_id)
            .expect("mask params should be stored");
        match params {
            MaskParams::Linear { x1, y1, x2, y2 } => {
                assert_eq!((*x1, *y1, *x2, *y2), (0.0, 0.0, 0.0, 2.0));
            }
            MaskParams::Radial { .. } => panic!("expected a linear mask"),
            MaskParams::Brush { .. } => panic!("expected a linear mask"),
        }
    }

    #[test]
    fn remove_mask_clears_attached_mask() {
        let mut engine = create_engine();
        engine.apply_gradient_mask(
            1,
            MaskParams::Radial {
                cx: 0.5,
                cy: 1.0,
                radius: 1.0,
            },
        );

        engine.remove_mask(1);

        assert!(engine.stack.layers[1].mask.is_none());
        assert!(engine.stack.mask_params.is_empty());
    }

    #[test]
    fn create_brush_mask_stores_brush_metadata_without_pixels() {
        let mut engine = create_engine();

        engine.create_brush_mask(1);

        let mask_id = engine.stack.layers[1]
            .mask
            .expect("mask should be attached");
        let params = engine
            .stack
            .mask_params
            .get(&mask_id)
            .expect("mask params should be stored");
        match params {
            MaskParams::Brush {
                width,
                height,
                pixels,
            } => {
                assert_eq!((*width, *height), (1, 2));
                assert!(pixels.is_empty());
            }
            _ => panic!("expected a brush mask"),
        }
    }

    #[test]
    fn stamp_brush_mask_keeps_brush_params_metadata_lightweight() {
        let mut engine = create_engine();
        engine.create_brush_mask(1);

        engine.stamp_brush_mask(1, 0.5, 0.5, 1.0, 0.0, false);

        let mask_id = engine.stack.layers[1]
            .mask
            .expect("mask should be attached");
        let params = engine
            .stack
            .mask_params
            .get(&mask_id)
            .expect("mask params should be stored");
        match params {
            MaskParams::Brush { width, height, pixels } => {
                assert_eq!((*width, *height), (1, 2));
                assert!(pixels.is_empty());
            }
            _ => panic!("expected a brush mask"),
        }
    }
}
