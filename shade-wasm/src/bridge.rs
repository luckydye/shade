use crate::engine::WasmEngine;
use serde::Serialize;
use shade_core::{
    ColorParams, CropRect, CurveControlPoint, DenoiseParams, HslParams, ToneParams,
};
use shade_io::load_image_bytes_f32_with_info;
use std::cell::RefCell;
use wasm_bindgen::prelude::*;
use wasm_bindgen::JsValue;

thread_local! {
    static ENGINE: RefCell<WasmEngine> = RefCell::new(WasmEngine::new());
}

#[derive(Serialize)]
pub struct LayerInfo {
    pub layer_count: usize,
    pub canvas_width: u32,
    pub canvas_height: u32,
    pub source_bit_depth: String,
}

/// Load raw RGBA8 image data into the engine.
/// Returns the texture ID assigned.
#[wasm_bindgen]
pub fn load_image(pixels: &[u8], width: u32, height: u32) -> u64 {
    ENGINE.with(|e| {
        e.borrow_mut()
            .load_image_data(pixels.to_vec(), width, height)
    })
}

#[wasm_bindgen]
pub fn load_image_encoded(
    bytes: &[u8],
    file_name: Option<String>,
) -> Result<JsValue, JsValue> {
    ENGINE.with(|e| {
        let mut engine = e.borrow_mut();
        let (image, info) = load_image_bytes_f32_with_info(bytes, file_name.as_deref())
            .map_err(|err| JsValue::from_str(&err.to_string()))?;
        engine.load_image_data(
            image
                .pixels
                .iter()
                .map(|channel| (channel.clamp(0.0, 1.0) * 255.0).round() as u8)
                .collect(),
            image.width,
            image.height,
        );
        serde_wasm_bindgen::to_value(&LayerInfo {
            layer_count: engine.layer_count(),
            canvas_width: engine.canvas_width,
            canvas_height: engine.canvas_height,
            source_bit_depth: info.bit_depth,
        })
        .map_err(|err| JsValue::from_str(&err.to_string()))
    })
}

/// Apply tone adjustments to a layer.
#[wasm_bindgen]
pub fn apply_tone(
    layer_idx: usize,
    exposure: f32,
    contrast: f32,
    blacks: f32,
    whites: f32,
    highlights: f32,
    shadows: f32,
    gamma: f32,
) {
    ENGINE.with(|e| {
        e.borrow_mut().apply_tone(
            layer_idx,
            ToneParams {
                exposure,
                contrast,
                blacks,
                whites,
                highlights,
                shadows,
                gamma,
                _pad: 0.0,
            },
        )
    });
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
    ENGINE.with(|e| {
        e.borrow_mut().apply_color(
            layer_idx,
            ColorParams {
                saturation,
                vibrancy,
                temperature,
                tint,
            },
        )
    });
}

/// Apply HSL adjustments to a layer.
#[wasm_bindgen]
pub fn apply_hsl(
    layer_idx: usize,
    red_hue: f32,
    red_sat: f32,
    red_lum: f32,
    green_hue: f32,
    green_sat: f32,
    green_lum: f32,
    blue_hue: f32,
    blue_sat: f32,
    blue_lum: f32,
) {
    ENGINE.with(|e| {
        e.borrow_mut().apply_hsl(
            layer_idx,
            HslParams {
                red_hue,
                red_sat,
                red_lum,
                green_hue,
                green_sat,
                green_lum,
                blue_hue,
                blue_sat,
                blue_lum,
            },
        )
    });
}

#[wasm_bindgen]
pub fn apply_curves(layer_idx: usize, control_points: JsValue) -> Result<(), JsValue> {
    let points: Vec<CurveControlPoint> = serde_wasm_bindgen::from_value(control_points)
        .map_err(|err| JsValue::from_str(&err.to_string()))?;
    ENGINE.with(|e| {
        e.borrow_mut().apply_curves(layer_idx, points);
    });
    Ok(())
}

#[wasm_bindgen]
pub fn apply_vignette(layer_idx: usize, amount: f32) {
    ENGINE.with(|e| e.borrow_mut().apply_vignette(layer_idx, amount));
}

#[wasm_bindgen]
pub fn apply_sharpen(layer_idx: usize, amount: f32) {
    ENGINE.with(|e| e.borrow_mut().apply_sharpen(layer_idx, amount));
}

#[wasm_bindgen]
pub fn apply_grain(layer_idx: usize, amount: f32, size: f32) {
    ENGINE.with(|e| e.borrow_mut().apply_grain(layer_idx, amount, size));
}

#[wasm_bindgen]
pub fn apply_denoise(
    layer_idx: usize,
    luma_strength: f32,
    chroma_strength: f32,
    mode: u32,
) {
    ENGINE.with(|e| {
        e.borrow_mut().apply_denoise(
            layer_idx,
            DenoiseParams {
                luma_strength,
                chroma_strength,
                mode,
                _pad: 0.0,
            },
        )
    });
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

#[wasm_bindgen]
pub fn move_layer(from_idx: usize, to_idx: usize) -> usize {
    ENGINE.with(|e| {
        let mut eng = e.borrow_mut();
        let len = eng.stack.layers.len();
        assert!(from_idx < len, "source index out of bounds");
        assert!(to_idx <= len, "target index out of bounds");
        if to_idx == from_idx || to_idx == from_idx + 1 {
            return from_idx;
        }
        let entry = eng.stack.layers.remove(from_idx);
        let insert_idx = if to_idx > from_idx { to_idx - 1 } else { to_idx };
        eng.stack.layers.insert(insert_idx, entry);
        eng.stack.generation += 1;
        insert_idx
    })
}

#[wasm_bindgen]
pub fn add_layer(kind: String) -> usize {
    ENGINE.with(|e| e.borrow_mut().add_layer(&kind))
}

#[wasm_bindgen]
pub fn delete_layer(layer_idx: usize) {
    ENGINE.with(|e| e.borrow_mut().delete_layer(layer_idx));
}

#[wasm_bindgen]
pub fn apply_crop(
    layer_idx: usize,
    crop_x: f32,
    crop_y: f32,
    crop_width: f32,
    crop_height: f32,
    crop_rotation: f32,
) {
    ENGINE.with(|e| {
        e.borrow_mut().apply_crop(
            layer_idx,
            CropRect {
                x: crop_x,
                y: crop_y,
                width: crop_width,
                height: crop_height,
                rotation: crop_rotation,
            },
        )
    });
}

/// Returns a JSON string describing the current layer stack.
#[wasm_bindgen]
pub fn get_stack_json() -> String {
    ENGINE.with(|e| {
        let eng = e.borrow();
        let layers: Vec<serde_json::Value> = eng
            .stack
            .layers
            .iter()
            .map(|l| {
                let adjustments = match &l.layer {
                    shade_core::Layer::Adjustment { ops } => {
                        let mut tone = None;
                        let mut color = None;
                        let mut hsl = None;
                        let mut curves = None;
                        let mut vignette = None;
                        let mut sharpen = None;
                        let mut grain = None;
                        let mut denoise = None;
                        for op in ops {
                            match op {
                                shade_core::AdjustmentOp::Tone {
                                    exposure,
                                    contrast,
                                    blacks,
                                    whites,
                                    highlights,
                                    shadows,
                                    gamma,
                                } => {
                                    tone = Some(serde_json::json!({
                                        "exposure": exposure,
                                        "contrast": contrast,
                                        "blacks": blacks,
                                        "whites": whites,
                                        "highlights": highlights,
                                        "shadows": shadows,
                                        "gamma": gamma,
                                    }));
                                }
                                shade_core::AdjustmentOp::Color(params) => {
                                    color = Some(serde_json::json!({
                                        "saturation": params.saturation,
                                        "vibrancy": params.vibrancy,
                                        "temperature": params.temperature,
                                        "tint": params.tint,
                                    }));
                                }
                                shade_core::AdjustmentOp::Hsl(params) => {
                                    hsl = Some(serde_json::json!({
                                        "red_hue": params.red_hue,
                                        "red_sat": params.red_sat,
                                        "red_lum": params.red_lum,
                                        "green_hue": params.green_hue,
                                        "green_sat": params.green_sat,
                                        "green_lum": params.green_lum,
                                        "blue_hue": params.blue_hue,
                                        "blue_sat": params.blue_sat,
                                        "blue_lum": params.blue_lum,
                                    }));
                                }
                                shade_core::AdjustmentOp::Curves {
                                    lut_r,
                                    lut_g,
                                    lut_b,
                                    lut_master,
                                    per_channel,
                                    control_points,
                                } => {
                                    curves = Some(serde_json::json!({
                                        "lut_r": lut_r,
                                        "lut_g": lut_g,
                                        "lut_b": lut_b,
                                        "lut_master": lut_master,
                                        "per_channel": per_channel,
                                        "control_points": control_points,
                                    }));
                                }
                                shade_core::AdjustmentOp::Vignette(params) => {
                                    vignette = Some(serde_json::json!({
                                        "amount": params.amount,
                                    }));
                                }
                                shade_core::AdjustmentOp::Sharpen(params) => {
                                    sharpen = Some(serde_json::json!({
                                        "amount": params.amount,
                                    }));
                                }
                                shade_core::AdjustmentOp::Grain(params) => {
                                    grain = Some(serde_json::json!({
                                        "amount": params.amount,
                                        "size": params.size,
                                    }));
                                }
                                shade_core::AdjustmentOp::Denoise(params) => {
                                    denoise = Some(serde_json::json!({
                                        "luma_strength": params.luma_strength,
                                        "chroma_strength": params.chroma_strength,
                                        "mode": params.mode,
                                    }));
                                }
                            }
                        }
                        Some(serde_json::json!({
                            "tone": tone,
                            "curves": curves,
                            "color": color,
                            "vignette": vignette,
                            "sharpen": sharpen,
                            "grain": grain,
                            "hsl": hsl,
                            "denoise": denoise,
                        }))
                    }
                    _ => None,
                };
                serde_json::json!({
                    "kind": match &l.layer {
                        shade_core::Layer::Image { .. } => "image",
                        shade_core::Layer::Crop { .. } => "crop",
                        shade_core::Layer::Adjustment { .. } => "adjustment",
                    },
                    "visible": l.visible,
                    "opacity": l.opacity,
                    "crop": match &l.layer {
                        shade_core::Layer::Crop { rect } => Some(serde_json::json!({
                            "x": rect.x,
                            "y": rect.y,
                            "width": rect.width,
                            "height": rect.height,
                            "rotation": rect.rotation,
                        })),
                        _ => None,
                    },
                    "adjustments": adjustments,
                })
            })
            .collect();
        serde_json::json!({
            "layers": layers,
            "canvas_width": eng.canvas_width,
            "canvas_height": eng.canvas_height,
            "generation": eng.stack.generation,
        })
        .to_string()
    })
}

#[wasm_bindgen]
pub fn render_preview() -> String {
    ENGINE.with(|e| e.borrow().render_preview_data_url())
}

#[wasm_bindgen]
pub fn render_preview_rgba() -> Vec<u8> {
    ENGINE.with(|e| e.borrow().render_preview_rgba())
}
