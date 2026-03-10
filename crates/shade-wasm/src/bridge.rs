use wasm_bindgen::prelude::*;
use shade_core::{ToneParams, ColorParams};
use std::cell::RefCell;
use crate::engine::WasmEngine;

thread_local! {
    static ENGINE: RefCell<WasmEngine> = RefCell::new(WasmEngine::new());
}

#[wasm_bindgen]
pub struct LayerInfo {
    pub layer_count: usize,
    pub canvas_width: u32,
    pub canvas_height: u32,
}

/// Load raw RGBA8 image data into the engine.
/// Returns the texture ID assigned.
#[wasm_bindgen]
pub fn load_image(pixels: &[u8], width: u32, height: u32) -> u64 {
    ENGINE.with(|e| e.borrow_mut().load_image_data(pixels.to_vec(), width, height))
}

/// Apply tone adjustments to a layer.
#[wasm_bindgen]
pub fn apply_tone(
    layer_idx: usize,
    exposure: f32,
    contrast: f32,
    blacks: f32,
    highlights: f32,
    shadows: f32,
) {
    ENGINE.with(|e| e.borrow_mut().apply_tone(layer_idx, ToneParams {
        exposure, contrast, blacks, highlights, shadows,
    }));
}

/// Apply color adjustments to a layer.
#[wasm_bindgen]
pub fn apply_color(
    layer_idx: usize,
    saturation: f32,
    vibrancy: f32,
    temperature: f32,
    tint: f32,
) {
    ENGINE.with(|e| e.borrow_mut().apply_color(layer_idx, ColorParams {
        saturation, vibrancy, temperature, tint,
    }));
}

/// Get layer count.
#[wasm_bindgen]
pub fn get_layer_count() -> usize {
    ENGINE.with(|e| e.borrow().layer_count())
}

/// Get canvas dimensions as [width, height].
#[wasm_bindgen]
pub fn get_canvas_size() -> Vec<u32> {
    ENGINE.with(|e| {
        let eng = e.borrow();
        vec![eng.canvas_width, eng.canvas_height]
    })
}

/// Set layer visibility.
#[wasm_bindgen]
pub fn set_layer_visible(layer_idx: usize, visible: bool) {
    ENGINE.with(|e| {
        let mut eng = e.borrow_mut();
        if let Some(layer) = eng.stack.layers.get_mut(layer_idx) {
            layer.visible = visible;
            eng.stack.generation += 1;
        }
    });
}

/// Set layer opacity (0.0–1.0).
#[wasm_bindgen]
pub fn set_layer_opacity(layer_idx: usize, opacity: f32) {
    ENGINE.with(|e| {
        let mut eng = e.borrow_mut();
        if let Some(layer) = eng.stack.layers.get_mut(layer_idx) {
            layer.opacity = opacity.clamp(0.0, 1.0);
            eng.stack.generation += 1;
        }
    });
}

/// Returns a JSON string describing the current layer stack.
#[wasm_bindgen]
pub fn get_stack_json() -> String {
    ENGINE.with(|e| {
        let eng = e.borrow();
        let layers: Vec<serde_json::Value> = eng.stack.layers.iter().map(|l| {
            serde_json::json!({
                "kind": match &l.layer {
                    shade_core::Layer::Image { .. } => "image",
                    shade_core::Layer::Adjustment { .. } => "adjustment",
                },
                "visible": l.visible,
                "opacity": l.opacity,
            })
        }).collect();
        serde_json::json!({
            "layers": layers,
            "canvas_width": eng.canvas_width,
            "canvas_height": eng.canvas_height,
            "generation": eng.stack.generation,
        }).to_string()
    })
}
