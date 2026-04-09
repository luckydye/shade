use crate::engine::WasmEngine;
use js_sys::{Object, Reflect, Uint8Array};
use serde::{Deserialize, Serialize};
use shade_lib::{
    ColorParams, CropRect, CurveControlPoint, DenoiseParams, HslParams, MaskParams,
    PreviewCrop as GpuPreviewCrop, Renderer, ToneParams,
};
use shade_io::load_image_bytes_f32_with_info;
use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;
use wasm_bindgen::prelude::*;
use wasm_bindgen::JsValue;

thread_local! {
    static ENGINE: RefCell<WasmEngine> = RefCell::new(WasmEngine::new());
    static RENDERER: RefCell<Option<Rc<Renderer>>> = const { RefCell::new(None) };
}

#[derive(Serialize)]
pub struct LayerInfo {
    pub layer_count: usize,
    pub canvas_width: u32,
    pub canvas_height: u32,
    pub source_bit_depth: String,
}

#[derive(Clone, Deserialize)]
pub struct PreviewCrop {
    pub x: f32,
    pub y: f32,
    pub width: f32,
    pub height: f32,
}

#[derive(Clone, Deserialize)]
pub struct PreviewRenderRequest {
    pub target_width: u32,
    pub target_height: u32,
    pub crop: Option<PreviewCrop>,
    pub ignore_crop_layers: Option<bool>,
}

fn apply_preview_request(
    mut stack: shade_lib::LayerStack,
    canvas_width: u32,
    canvas_height: u32,
    request: Option<PreviewRenderRequest>,
) -> (shade_lib::LayerStack, PreviewRenderRequest) {
    let request = request.unwrap_or(PreviewRenderRequest {
        target_width: canvas_width,
        target_height: canvas_height,
        crop: None,
        ignore_crop_layers: None,
    });
    if request.ignore_crop_layers.unwrap_or(false) {
        for entry in &mut stack.layers {
            if matches!(entry.layer, shade_lib::Layer::Crop { .. }) {
                entry.visible = false;
            }
        }
    }
    (stack, request)
}

/// Load raw RGBA8 image data into the engine.
/// Returns the texture ID assigned.
#[wasm_bindgen]
pub fn load_image(pixels: &[u8], width: u32, height: u32) -> u64 {
    ENGINE.with(|e| {
        e.borrow_mut()
            .load_rgba8_image_data(pixels.to_vec(), width, height)
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
        engine.load_image_data(image);
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
    let points: Vec<CurveControlPoint> =
        serde_wasm_bindgen::from_value(control_points)
            .map_err(|err| JsValue::from_str(&err.to_string()))?;
    ENGINE.with(|e| {
        e.borrow_mut().apply_curves(layer_idx, points);
    });
    Ok(())
}

#[wasm_bindgen]
pub fn apply_ls_curve(layer_idx: usize, control_points: JsValue) -> Result<(), JsValue> {
    let points: Vec<CurveControlPoint> =
        serde_wasm_bindgen::from_value(control_points)
            .map_err(|err| JsValue::from_str(&err.to_string()))?;
    ENGINE.with(|e| {
        e.borrow_mut().apply_ls_curve(layer_idx, points);
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
pub fn apply_glow(layer_idx: usize, amount: f32) {
    ENGINE.with(|e| e.borrow_mut().apply_glow(layer_idx, amount));
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

#[wasm_bindgen]
pub async fn init_renderer() -> Result<(), JsValue> {
    if RENDERER.with(|renderer| renderer.borrow().is_some()) {
        return Ok(());
    }
    let renderer = Rc::new(
        Renderer::new()
            .await
            .map_err(|err| JsValue::from_str(&err.to_string()))?,
    );
    RENDERER.with(|slot| {
        if slot.borrow().is_none() {
            slot.replace(Some(renderer));
        }
    });
    Ok(())
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
        let insert_idx = if to_idx > from_idx {
            to_idx - 1
        } else {
            to_idx
        };
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
pub fn rename_layer(layer_idx: usize, name: Option<String>) {
    ENGINE.with(|e| e.borrow_mut().rename_layer(layer_idx, name));
}

#[wasm_bindgen]
pub fn apply_linear_gradient_mask(layer_idx: usize, x1: f32, y1: f32, x2: f32, y2: f32) {
    ENGINE.with(|e| {
        e.borrow_mut()
            .apply_gradient_mask(layer_idx, MaskParams::Linear { x1, y1, x2, y2 })
    });
}

#[wasm_bindgen]
pub fn apply_radial_gradient_mask(layer_idx: usize, cx: f32, cy: f32, radius: f32) {
    ENGINE.with(|e| {
        e.borrow_mut()
            .apply_gradient_mask(layer_idx, MaskParams::Radial { cx, cy, radius })
    });
}

#[wasm_bindgen]
pub fn remove_mask(layer_idx: usize) {
    ENGINE.with(|e| e.borrow_mut().remove_mask(layer_idx));
}

#[wasm_bindgen]
pub fn create_brush_mask(layer_idx: usize) {
    ENGINE.with(|e| e.borrow_mut().create_brush_mask(layer_idx));
}

#[wasm_bindgen]
pub fn stamp_brush_mask(
    layer_idx: usize,
    cx: f32,
    cy: f32,
    radius: f32,
    softness: f32,
    erase: bool,
) {
    ENGINE.with(|e| {
        e.borrow_mut()
            .stamp_brush_mask(layer_idx, cx, cy, radius, softness, erase)
    });
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
                let mask_params = l
                    .mask
                    .and_then(|id| eng.stack.mask_params.get(&id))
                    .map(|params| match params {
                        MaskParams::Linear { x1, y1, x2, y2 } => serde_json::json!({
                            "kind": "linear",
                            "x1": x1,
                            "y1": y1,
                            "x2": x2,
                            "y2": y2,
                            "cx": serde_json::Value::Null,
                            "cy": serde_json::Value::Null,
                            "radius": serde_json::Value::Null,
                        }),
                        MaskParams::Radial { cx, cy, radius } => serde_json::json!({
                            "kind": "radial",
                            "x1": serde_json::Value::Null,
                            "y1": serde_json::Value::Null,
                            "x2": serde_json::Value::Null,
                            "y2": serde_json::Value::Null,
                            "cx": cx,
                            "cy": cy,
                            "radius": radius,
                        }),
                        MaskParams::Brush { .. } => serde_json::json!({
                            "kind": "brush",
                            "x1": serde_json::Value::Null,
                            "y1": serde_json::Value::Null,
                            "x2": serde_json::Value::Null,
                            "y2": serde_json::Value::Null,
                            "cx": serde_json::Value::Null,
                            "cy": serde_json::Value::Null,
                            "radius": serde_json::Value::Null,
                        }),
                    });
                let adjustments = match &l.layer {
                    shade_lib::Layer::Adjustment { ops } => {
                        let mut tone = None;
                        let mut color = None;
                        let mut hsl = None;
                        let mut curves = None;
                        let mut ls_curve = None;
                        let mut vignette = None;
                        let mut sharpen = None;
                        let mut grain = None;
                        let mut glow = None;
                        let mut denoise = None;
                        for op in ops {
                            match op {
                                shade_lib::AdjustmentOp::Tone {
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
                                shade_lib::AdjustmentOp::Color(params) => {
                                    color = Some(serde_json::json!({
                                        "saturation": params.saturation,
                                        "vibrancy": params.vibrancy,
                                        "temperature": params.temperature,
                                        "tint": params.tint,
                                    }));
                                }
                                shade_lib::AdjustmentOp::Hsl(params) => {
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
                                shade_lib::AdjustmentOp::Curves {
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
                                shade_lib::AdjustmentOp::LsCurve {
                                    lut,
                                    control_points,
                                } => {
                                    ls_curve = Some(serde_json::json!({
                                        "lut": lut,
                                        "control_points": control_points,
                                    }));
                                }
                                shade_lib::AdjustmentOp::Vignette(params) => {
                                    vignette = Some(serde_json::json!({
                                        "amount": params.amount,
                                    }));
                                }
                                shade_lib::AdjustmentOp::Sharpen(params) => {
                                    sharpen = Some(serde_json::json!({
                                        "amount": params.amount,
                                    }));
                                }
                                shade_lib::AdjustmentOp::Grain(params) => {
                                    grain = Some(serde_json::json!({
                                        "amount": params.amount,
                                        "size": params.size,
                                    }));
                                }
                                shade_lib::AdjustmentOp::Glow(params) => {
                                    glow = Some(serde_json::json!({
                                        "amount": params.amount,
                                    }));
                                }
                                shade_lib::AdjustmentOp::Denoise(params) => {
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
                            "ls_curve": ls_curve,
                            "color": color,
                            "vignette": vignette,
                            "sharpen": sharpen,
                            "grain": grain,
                            "glow": glow,
                            "hsl": hsl,
                            "denoise": denoise,
                        }))
                    }
                    _ => None,
                };
                serde_json::json!({
                    "kind": match &l.layer {
                        shade_lib::Layer::Image { .. } => "image",
                        shade_lib::Layer::Crop { .. } => "crop",
                        shade_lib::Layer::Adjustment { .. } => "adjustment",
                    },
                    "name": l.name.clone(),
                    "visible": l.visible,
                    "opacity": l.opacity,
                    "has_mask": l.mask.is_some(),
                    "mask_params": mask_params,
                    "crop": match &l.layer {
                        shade_lib::Layer::Crop { rect } => Some(serde_json::json!({
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

#[derive(Serialize, Deserialize)]
struct StackSnapshot {
    layers: Vec<shade_lib::LayerEntry>,
    mask_params: HashMap<shade_lib::MaskId, shade_lib::MaskParams>,
}

#[wasm_bindgen]
pub fn get_stack_snapshot_json() -> String {
    ENGINE.with(|e| {
        let eng = e.borrow();
        let non_image: Vec<_> = eng
            .stack
            .layers
            .iter()
            .filter(|l| !matches!(l.layer, shade_lib::Layer::Image { .. }))
            .cloned()
            .collect();
        let mut mp = HashMap::new();
        for layer in &non_image {
            if let Some(mask_id) = layer.mask {
                if let Some(params) = eng.stack.mask_params.get(&mask_id) {
                    mp.insert(mask_id, params.clone());
                }
            }
        }
        serde_json::to_string(&StackSnapshot {
            layers: non_image,
            mask_params: mp,
        })
        .expect("stack snapshot serialization failed")
    })
}

#[wasm_bindgen]
pub fn replace_stack_json(json: &str) -> Result<(), JsValue> {
    let snap: StackSnapshot =
        serde_json::from_str(json).map_err(|err| JsValue::from_str(&err.to_string()))?;
    ENGINE.with(|e| {
        e.borrow_mut()
            .replace_non_image_layers(snap.layers, snap.mask_params);
    });
    Ok(())
}

#[wasm_bindgen]
pub async fn render_preview_rgba(request: JsValue) -> Result<JsValue, JsValue> {
    let request: Option<PreviewRenderRequest> =
        if request.is_undefined() || request.is_null() {
            None
        } else {
            Some(
                serde_wasm_bindgen::from_value(request)
                    .map_err(|err| JsValue::from_str(&err.to_string()))?,
            )
        };
    let renderer = RENDERER
        .with(|slot| slot.borrow().clone())
        .ok_or_else(|| JsValue::from_str("renderer is not initialized"))?;
    let (stack, sources, canvas_width, canvas_height) =
        ENGINE.with(|engine| engine.borrow().snapshot_render_state());
    if canvas_width == 0 || canvas_height == 0 {
        return Err(JsValue::from_str("no image loaded"));
    }
    let (stack, request) =
        apply_preview_request(stack, canvas_width, canvas_height, request);
    let pixels = renderer
        .render_stack_preview(
            &stack,
            &sources,
            canvas_width,
            canvas_height,
            request.target_width,
            request.target_height,
            request.crop.map(|crop| GpuPreviewCrop {
                x: crop.x,
                y: crop.y,
                width: crop.width,
                height: crop.height,
            }),
        )
        .await
        .map_err(|err| JsValue::from_str(&err.to_string()))?;
    let frame = Object::new();
    Reflect::set(
        &frame,
        &JsValue::from_str("pixels"),
        &Uint8Array::from(pixels.as_slice()),
    )?;
    Reflect::set(
        &frame,
        &JsValue::from_str("width"),
        &JsValue::from_f64(request.target_width as f64),
    )?;
    Reflect::set(
        &frame,
        &JsValue::from_str("height"),
        &JsValue::from_f64(request.target_height as f64),
    )?;
    Ok(frame.into())
}
