use shade_core::{AdjustmentOp, ColorParams, LayerStack, TextureId, ToneParams};
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
            highlights: 0.0,
            shadows: 0.0,
            gamma: 1.0,
        }]);
        id
    }

    pub fn apply_tone(&mut self, layer_idx: usize, params: ToneParams) {
        if let Some(entry) = self.stack.layers.get_mut(layer_idx) {
            if let shade_core::Layer::Adjustment { ops } = &mut entry.layer {
                let new_op = AdjustmentOp::Tone {
                    exposure: params.exposure,
                    contrast: params.contrast,
                    blacks: params.blacks,
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
                if let Some(op) = ops.iter_mut().find(|o| matches!(o, AdjustmentOp::Color(_))) {
                    *op = AdjustmentOp::Color(params);
                } else {
                    ops.push(AdjustmentOp::Color(params));
                }
                self.stack.generation += 1;
            }
        }
    }

    pub fn layer_count(&self) -> usize {
        self.stack.layers.len()
    }

    pub fn render_preview_data_url(&self) -> String {
        let Some((pixels, width, height)) = self.image_sources.values().next() else {
            return String::new();
        };

        let Some(image) = image::RgbaImage::from_raw(*width, *height, pixels.clone()) else {
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
        let Some((pixels, _, _)) = self.image_sources.values().next() else {
            return Vec::new();
        };
        pixels.clone()
    }
}
