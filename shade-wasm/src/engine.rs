use shade_core::{
    build_curve_lut_from_points, linear_lut, AdjustmentOp, ColorParams, CropRect,
    CurveControlPoint, DenoiseParams, GrainParams, HslParams, Layer, LayerStack,
    SharpenParams, TextureId, ToneParams, VignetteParams,
};
use std::collections::HashMap;

/// Holds the in-memory editor state for the WASM context.
/// This lives in the worker thread.
pub struct WasmEngine {
    pub stack: LayerStack,
    pub image_sources: HashMap<TextureId, (Vec<u8>, u32, u32)>,
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

    pub fn load_image_data(&mut self, pixels: Vec<u8>, width: u32, height: u32) -> u64 {
        let id = self.next_texture_id;
        self.next_texture_id += 1;
        self.stack = LayerStack::new();
        self.image_sources.insert(id, (pixels, width, height));
        self.canvas_width = width;
        self.canvas_height = height;
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

    pub fn render_preview_data_url(&self) -> String {
        let pixels = self.render_preview_rgba();
        if pixels.is_empty() {
            return String::new();
        }

        let Some(image) =
            image::RgbaImage::from_raw(self.canvas_width, self.canvas_height, pixels)
        else {
            return String::new();
        };

        let mut buf = Vec::new();
        if image::DynamicImage::ImageRgba8(image)
            .write_to(&mut std::io::Cursor::new(&mut buf), image::ImageFormat::Png)
            .is_err()
        {
            return String::new();
        }

        use base64::{engine::general_purpose::STANDARD, Engine};
        format!("data:image/png;base64,{}", STANDARD.encode(&buf))
    }

    pub fn render_preview_rgba(&self) -> Vec<u8> {
        let Some(image_layer) = self.stack.layers.iter().find_map(|entry| match &entry.layer {
            Layer::Image { texture_id, .. } if entry.visible => Some((*texture_id, entry.opacity)),
            _ => None,
        }) else {
            return Vec::new();
        };
        let Some((source_pixels, _, _)) = self.image_sources.get(&image_layer.0) else {
            return Vec::new();
        };

        let mut pixels: Vec<f32> = source_pixels
            .iter()
            .map(|channel| *channel as f32 / 255.0)
            .collect();

        for entry in &self.stack.layers {
            if !entry.visible {
                continue;
            }
            let Layer::Adjustment { ops } = &entry.layer else {
                continue;
            };
            self.apply_adjustment_ops(&mut pixels, ops, entry.opacity);
        }

        pixels
            .chunks_exact(4)
            .flat_map(|rgba| {
                [
                    (rgba[0].clamp(0.0, 1.0) * 255.0).round() as u8,
                    (rgba[1].clamp(0.0, 1.0) * 255.0).round() as u8,
                    (rgba[2].clamp(0.0, 1.0) * 255.0).round() as u8,
                    (rgba[3].clamp(0.0, 1.0) * 255.0).round() as u8,
                ]
            })
            .collect()
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
        let exposure_scale = 2.0_f32.powf(params.exposure);
        for rgba in pixels.chunks_exact_mut(4) {
            let mut rgb = [rgba[0], rgba[1], rgba[2]];
            for channel in &mut rgb {
                let original = *channel;
                let shadows_weight = (1.0 - original).powi(2);
                let highlights_weight = original.powi(2);
                *channel *= exposure_scale;
                *channel += params.blacks * 0.25;
                *channel += params.whites * 0.25 * highlights_weight;
                *channel += params.shadows * 0.35 * shadows_weight;
                *channel -= params.highlights * 0.35 * highlights_weight;
                *channel = ((*channel - 0.5) * (1.0 + params.contrast) + 0.5).clamp(0.0, 1.0);
                let gamma = params.gamma.max(0.01);
                *channel = channel.clamp(0.0, 1.0).powf(1.0 / gamma);
            }
            rgba[0] = rgb[0];
            rgba[1] = rgb[1];
            rgba[2] = rgb[2];
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
        let half_w = width as f32 * 0.5;
        let half_h = height as f32 * 0.5;
        for (idx, rgba) in pixels.chunks_exact_mut(4).enumerate() {
            let x = (idx % width) as f32 - half_w;
            let y = (idx / width) as f32 - half_h;
            let nx = if half_w > 0.0 { x / half_w } else { 0.0 };
            let ny = if half_h > 0.0 { y / half_h } else { 0.0 };
            let distance = (nx * nx + ny * ny).sqrt().clamp(0.0, 1.5);
            let start = params.midpoint.clamp(0.0, 1.0);
            let feather = params.feather.max(0.001);
            let edge = ((distance - start) / feather).clamp(0.0, 1.0);
            let falloff = 1.0 - edge * params.amount.clamp(0.0, 1.0) * 0.85;
            rgba[0] *= falloff;
            rgba[1] *= falloff;
            rgba[2] *= falloff;
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
