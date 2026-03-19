use shade_core::{
    build_curve_lut_from_points, linear_lut, AdjustmentOp, ColorParams, CropRect,
    CurveControlPoint, DenoiseParams, FloatImage, GrainParams, HslParams, Layer,
    LayerStack, SharpenParams, TextureId, ToneParams, VignetteParams,
};
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
        let image = FloatImage {
            pixels: pixels
                .chunks_exact(4)
                .flat_map(|rgba| {
                    [
                        rgba[0] as f32 / 255.0,
                        rgba[1] as f32 / 255.0,
                        rgba[2] as f32 / 255.0,
                        rgba[3] as f32 / 255.0,
                    ]
                })
                .collect::<Vec<_>>()
                .into(),
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
        assert!(layer_idx < self.stack.layers.len(), "layer index out of bounds");
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
                if let Some(op) = ops
                    .iter_mut()
                    .find(|o| matches!(o, AdjustmentOp::Grain(_)))
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
        let width = rect
            .width
            .round()
            .clamp(1.0, self.canvas_width as f32 - x);
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

    pub fn apply_adjustment_ops(
        &self,
        pixels: &mut [f32],
        ops: &[AdjustmentOp],
        opacity: f32,
    ) {
        let opacity = opacity.clamp(0.0, 1.0);
        if opacity <= 0.0 {
            return;
        }
        let original = pixels.to_vec();
        for op in ops {
            match op {
                AdjustmentOp::Tone {
                    exposure,
                    contrast,
                    blacks,
                    whites,
                    highlights,
                    shadows,
                    gamma,
                } => self.apply_tone_op(
                    pixels,
                    ToneParams {
                        exposure: *exposure,
                        contrast: *contrast,
                        blacks: *blacks,
                        whites: *whites,
                        highlights: *highlights,
                        shadows: *shadows,
                        gamma: *gamma,
                        _pad: 0.0,
                    },
                ),
                AdjustmentOp::Curves {
                    lut_r,
                    lut_g,
                    lut_b,
                    lut_master,
                    per_channel,
                    ..
                } => self.apply_curves_op(
                    pixels,
                    lut_r,
                    lut_g,
                    lut_b,
                    lut_master,
                    *per_channel,
                ),
                AdjustmentOp::Color(params) => self.apply_color_op(pixels, *params),
                AdjustmentOp::Vignette(params) => self.apply_vignette_op(pixels, *params),
                AdjustmentOp::Sharpen(params) => self.apply_sharpen_op(pixels, *params),
                AdjustmentOp::Grain(params) => self.apply_grain_op(pixels, *params),
                AdjustmentOp::Hsl(params) => self.apply_hsl_op(pixels, *params),
                AdjustmentOp::Denoise(params) => self.apply_denoise_op(pixels, *params),
            }
        }
        if opacity < 1.0 {
            for (current, base) in pixels.iter_mut().zip(original.iter()) {
                *current = *base + (*current - *base) * opacity;
            }
        }
    }

    pub fn apply_tone_op(&self, pixels: &mut [f32], params: ToneParams) {
        fn luminance(rgb: [f32; 3]) -> f32 {
            rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722
        }

        fn smoothstep(edge0: f32, edge1: f32, x: f32) -> f32 {
            if edge0 == edge1 {
                return if x < edge0 { 0.0 } else { 1.0 };
            }
            let t = ((x - edge0) / (edge1 - edge0)).clamp(0.0, 1.0);
            t * t * (3.0 - 2.0 * t)
        }

        let exposure_scale = 2.0_f32.powf(params.exposure);
        let contrast_scale = 2.0_f32.powf(params.contrast);
        let gamma = params.gamma.max(0.0001);
        for rgba in pixels.chunks_exact_mut(4) {
            let mut rgb = [rgba[0], rgba[1], rgba[2]];

            rgb[0] *= exposure_scale;
            rgb[1] *= exposure_scale;
            rgb[2] *= exposure_scale;

            let mid_luma = 0.18;
            let luma = luminance(rgb);
            let contrast_luma = mid_luma + (luma - mid_luma) * contrast_scale;
            let contrast_delta = contrast_luma - luma;
            rgb[0] += contrast_delta;
            rgb[1] += contrast_delta;
            rgb[2] += contrast_delta;

            rgb[0] += params.blacks;
            rgb[1] += params.blacks;
            rgb[2] += params.blacks;

            let whites_mask = smoothstep(0.5, 1.0, luminance(rgb));
            rgb[0] += params.whites * whites_mask;
            rgb[1] += params.whites * whites_mask;
            rgb[2] += params.whites * whites_mask;

            let shadow_mask = 1.0 - smoothstep(0.0, 0.5, luminance(rgb));
            rgb[0] += params.shadows * shadow_mask * 0.5;
            rgb[1] += params.shadows * shadow_mask * 0.5;
            rgb[2] += params.shadows * shadow_mask * 0.5;

            let highlight_mask = smoothstep(0.5, 1.0, luminance(rgb));
            let highlight_scale = 1.0 - params.highlights * highlight_mask * 0.5;
            rgb[0] *= highlight_scale;
            rgb[1] *= highlight_scale;
            rgb[2] *= highlight_scale;

            rgba[0] = rgb[0].signum() * rgb[0].abs().powf(gamma);
            rgba[1] = rgb[1].signum() * rgb[1].abs().powf(gamma);
            rgba[2] = rgb[2].signum() * rgb[2].abs().powf(gamma);
        }
    }

    pub fn apply_color_op(&self, pixels: &mut [f32], params: ColorParams) {
        for rgba in pixels.chunks_exact_mut(4) {
            let mut rgb = [rgba[0], rgba[1], rgba[2]];
            let luma = 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
            let max_channel = rgb[0].max(rgb[1]).max(rgb[2]);
            let saturation_boost = params.saturation.max(0.0);
            let vibrancy_boost = 1.0 + params.vibrancy * (1.0 - max_channel);
            for channel in &mut rgb {
                *channel = luma + (*channel - luma) * saturation_boost * vibrancy_boost;
            }
            rgb[0] += params.temperature * 0.1 - params.tint * 0.05;
            rgb[1] += params.tint * 0.05;
            rgb[2] -= params.temperature * 0.1 + params.tint * 0.05;
            rgba[0] = rgb[0].clamp(0.0, 1.0);
            rgba[1] = rgb[1].clamp(0.0, 1.0);
            rgba[2] = rgb[2].clamp(0.0, 1.0);
        }
    }

    pub fn apply_curves_op(
        &self,
        pixels: &mut [f32],
        lut_r: &[f32],
        lut_g: &[f32],
        lut_b: &[f32],
        lut_master: &[f32],
        per_channel: bool,
    ) {
        fn sample_lut(lut: &[f32], value: f32) -> f32 {
            if lut.is_empty() {
                return value.clamp(0.0, 1.0);
            }
            let scaled = value.clamp(0.0, 1.0) * 255.0;
            let left = scaled.floor() as usize;
            let right = scaled.ceil() as usize;
            let l = lut[left.min(lut.len() - 1)];
            let r = lut[right.min(lut.len() - 1)];
            l + (r - l) * (scaled - left as f32)
        }

        for rgba in pixels.chunks_exact_mut(4) {
            let master_r = sample_lut(lut_master, rgba[0]);
            let master_g = sample_lut(lut_master, rgba[1]);
            let master_b = sample_lut(lut_master, rgba[2]);
            if per_channel {
                rgba[0] = sample_lut(lut_r, master_r);
                rgba[1] = sample_lut(lut_g, master_g);
                rgba[2] = sample_lut(lut_b, master_b);
            } else {
                rgba[0] = master_r;
                rgba[1] = master_g;
                rgba[2] = master_b;
            }
        }
    }

    pub fn apply_vignette_op(&self, pixels: &mut [f32], params: VignetteParams) {
        let width = self.canvas_width.max(1) as usize;
        let height = self.canvas_height.max(1) as usize;
        for (idx, rgba) in pixels.chunks_exact_mut(4).enumerate() {
            let x = idx % width;
            let y = idx / width;
            let uv_x = x as f32 / width as f32;
            let uv_y = y as f32 / height as f32;
            let centered_x = (uv_x - 0.5) * params.roundness;
            let centered_y = uv_y - 0.5;
            let dist = (centered_x * centered_x + centered_y * centered_y).sqrt();
            let edge0 = params.midpoint - params.feather;
            let edge1 = params.midpoint + params.feather;
            let t = if edge0 == edge1 {
                if dist < edge0 { 0.0 } else { 1.0 }
            } else {
                ((dist - edge0) / (edge1 - edge0)).clamp(0.0, 1.0)
            };
            let smooth = t * t * (3.0 - 2.0 * t);
            let multiplier = 1.0 - smooth * params.amount;
            rgba[0] *= multiplier;
            rgba[1] *= multiplier;
            rgba[2] *= multiplier;
        }
    }

    pub fn apply_sharpen_op(&self, pixels: &mut [f32], params: SharpenParams) {
        let width = self.canvas_width.max(1) as usize;
        let height = self.canvas_height.max(1) as usize;
        let source = pixels.to_vec();
        for y in 0..height {
            for x in 0..width {
                for channel in 0..3 {
                    let mut sum = 0.0;
                    let mut count = 0.0;
                    for dy in -1..=1 {
                        for dx in -1..=1 {
                            let sx = (x as isize + dx).clamp(0, (width - 1) as isize) as usize;
                            let sy =
                                (y as isize + dy).clamp(0, (height - 1) as isize) as usize;
                            sum += source[(sy * width + sx) * 4 + channel];
                            count += 1.0;
                        }
                    }
                    let idx = (y * width + x) * 4 + channel;
                    let blur = sum / count;
                    let detail = source[idx] - blur;
                    pixels[idx] = (source[idx] + detail * params.amount * 1.5).clamp(0.0, 1.0);
                }
            }
        }
    }

    pub fn apply_grain_op(&self, pixels: &mut [f32], params: GrainParams) {
        let width = self.canvas_width.max(1) as usize;
        let scale = params.size.max(1.0);
        for (idx, rgba) in pixels.chunks_exact_mut(4).enumerate() {
            let x = idx % width;
            let y = idx / width;
            let fx = x as f32 / scale;
            let fy = y as f32 / scale;
            let noise = ((fx * 12.9898 + fy * 78.233 + params.seed * 37.719).sin()
                * 43_758.547)
                .fract()
                - 0.5;
            let delta = noise * params.amount * 0.12;
            rgba[0] = (rgba[0] + delta).clamp(0.0, 1.0);
            rgba[1] = (rgba[1] + delta).clamp(0.0, 1.0);
            rgba[2] = (rgba[2] + delta).clamp(0.0, 1.0);
        }
    }

    pub fn apply_denoise_op(&self, pixels: &mut [f32], params: DenoiseParams) {
        let width = self.canvas_width.max(1) as usize;
        let height = self.canvas_height.max(1) as usize;
        let source = pixels.to_vec();
        for y in 0..height {
            for x in 0..width {
                let mut avg = [0.0; 3];
                let mut count = 0.0;
                for dy in -1..=1 {
                    for dx in -1..=1 {
                        let sx = (x as isize + dx).clamp(0, (width - 1) as isize) as usize;
                        let sy = (y as isize + dy).clamp(0, (height - 1) as isize) as usize;
                        let base = (sy * width + sx) * 4;
                        avg[0] += source[base];
                        avg[1] += source[base + 1];
                        avg[2] += source[base + 2];
                        count += 1.0;
                    }
                }
                avg[0] /= count;
                avg[1] /= count;
                avg[2] /= count;
                let base = (y * width + x) * 4;
                let src = [source[base], source[base + 1], source[base + 2]];
                let src_luma = 0.2126 * src[0] + 0.7152 * src[1] + 0.0722 * src[2];
                let avg_luma = 0.2126 * avg[0] + 0.7152 * avg[1] + 0.0722 * avg[2];
                let luma_mix = params.luma_strength.clamp(0.0, 1.0);
                let chroma_mix = params.chroma_strength.clamp(0.0, 1.0);
                let luma_adjust = avg_luma - src_luma;
                for channel in 0..3 {
                    let chroma = avg[channel] - avg_luma;
                    let source_chroma = src[channel] - src_luma;
                    pixels[base + channel] = (src[channel]
                        + luma_adjust * luma_mix
                        + (chroma - source_chroma) * chroma_mix)
                        .clamp(0.0, 1.0);
                }
            }
        }
    }

    pub fn apply_hsl_op(&self, pixels: &mut [f32], params: HslParams) {
        for rgba in pixels.chunks_exact_mut(4) {
            let mut rgb = [rgba[0], rgba[1], rgba[2]];
            let red_weight = (rgb[0] - rgb[1].max(rgb[2])).max(0.0);
            let green_weight = (rgb[1] - rgb[0].max(rgb[2])).max(0.0);
            let blue_weight = (rgb[2] - rgb[0].max(rgb[1])).max(0.0);
            self.apply_hsl_band(
                &mut rgb,
                red_weight,
                params.red_hue,
                params.red_sat,
                params.red_lum,
                [0, 1, 2],
            );
            self.apply_hsl_band(
                &mut rgb,
                green_weight,
                params.green_hue,
                params.green_sat,
                params.green_lum,
                [1, 2, 0],
            );
            self.apply_hsl_band(
                &mut rgb,
                blue_weight,
                params.blue_hue,
                params.blue_sat,
                params.blue_lum,
                [2, 0, 1],
            );
            rgba[0] = rgb[0].clamp(0.0, 1.0);
            rgba[1] = rgb[1].clamp(0.0, 1.0);
            rgba[2] = rgb[2].clamp(0.0, 1.0);
        }
    }

    pub fn apply_hsl_band(
        &self,
        rgb: &mut [f32; 3],
        weight: f32,
        hue: f32,
        saturation: f32,
        luminance: f32,
        order: [usize; 3],
    ) {
        if weight <= 0.0 {
            return;
        }
        let primary = order[0];
        let secondary = order[1];
        let tertiary = order[2];
        let strength = weight.clamp(0.0, 1.0);
        rgb[primary] += luminance * 0.15 * strength;
        rgb[secondary] += hue * 0.08 * strength;
        rgb[tertiary] -= hue * 0.08 * strength;
        let average = (rgb[0] + rgb[1] + rgb[2]) / 3.0;
        rgb[primary] = average + (rgb[primary] - average) * (1.0 + saturation * strength);
        rgb[secondary] =
            average + (rgb[secondary] - average) * (1.0 - saturation * strength * 0.5);
        rgb[tertiary] =
            average + (rgb[tertiary] - average) * (1.0 - saturation * strength * 0.5);
    }
}
