use serde::{Deserialize, Serialize};
use shade_core::{
    linear_lut, AdjustmentOp, ColorParams, GrainParams, LayerStack, SharpenParams, VignetteParams,
};
use shade_io::{load_image, load_image_bytes};
use std::sync::Mutex;

pub struct EditorState {
    pub stack: LayerStack,
    pub image_sources: std::collections::HashMap<shade_core::TextureId, (Vec<u8>, u32, u32)>,
    pub canvas_width: u32,
    pub canvas_height: u32,
    pub next_texture_id: u64,
}

impl Default for EditorState {
    fn default() -> Self {
        Self {
            stack: LayerStack::new(),
            image_sources: std::collections::HashMap::new(),
            canvas_width: 1920,
            canvas_height: 1080,
            next_texture_id: 1,
        }
    }
}

impl EditorState {
    pub fn replace_with_image(
        &mut self,
        pixels: Vec<u8>,
        width: u32,
        height: u32,
    ) -> LayerInfoResponse {
        let texture_id = self.next_texture_id;
        self.next_texture_id += 1;
        self.stack = LayerStack::new();
        self.image_sources
            .insert(texture_id, (pixels, width, height));
        self.canvas_width = width;
        self.canvas_height = height;
        self.stack.add_image_layer(texture_id, width, height);
        self.stack.add_adjustment_layer(vec![AdjustmentOp::Tone {
            exposure: 0.0,
            contrast: 0.0,
            blacks: 0.0,
            highlights: 0.0,
            shadows: 0.0,
        }]);
        LayerInfoResponse {
            layer_count: self.stack.layers.len(),
            canvas_width: width,
            canvas_height: height,
        }
    }
}

// Commands return Result<T, String> where Err is displayed to the user

#[derive(Serialize, Deserialize, Debug)]
pub struct LayerInfoResponse {
    pub layer_count: usize,
    pub canvas_width: u32,
    pub canvas_height: u32,
}

#[tauri::command]
pub async fn open_image(
    path: String,
    state: tauri::State<'_, Mutex<EditorState>>,
) -> Result<LayerInfoResponse, String> {
    let (pixels, w, h) = load_image(std::path::Path::new(&path)).map_err(|e| e.to_string())?;
    let mut st = state.lock().unwrap();
    Ok(st.replace_with_image(pixels, w, h))
}

#[tauri::command]
pub async fn open_image_encoded_bytes(
    bytes: Vec<u8>,
    file_name: Option<String>,
    state: tauri::State<'_, Mutex<EditorState>>,
) -> Result<LayerInfoResponse, String> {
    let (pixels, width, height) =
        load_image_bytes(&bytes, file_name.as_deref()).map_err(|e| e.to_string())?;
    let mut st = state.lock().unwrap();
    Ok(st.replace_with_image(pixels, width, height))
}

/// Accept raw RGBA8 bytes decoded in the webview (file picker / drag-drop).
/// This avoids needing a file path — the JS side decodes the image via
/// `createImageBitmap` and passes the pixel buffer directly.
#[tauri::command]
pub async fn open_image_bytes(
    pixels: Vec<u8>,
    width: u32,
    height: u32,
    state: tauri::State<'_, Mutex<EditorState>>,
) -> Result<LayerInfoResponse, String> {
    if pixels.len() != (width * height * 4) as usize {
        return Err(format!(
            "pixel buffer size mismatch: expected {}, got {}",
            width * height * 4,
            pixels.len()
        ));
    }
    let mut st = state.lock().unwrap();
    Ok(st.replace_with_image(pixels, width, height))
}

#[derive(Serialize, Deserialize, Debug)]
pub struct PreviewFrameResponse {
    pub pixels: Vec<u8>,
    pub width: u32,
    pub height: u32,
}

#[derive(Clone, Serialize, Deserialize, Debug)]
pub struct PreviewCrop {
    pub x: f32,
    pub y: f32,
    pub width: f32,
    pub height: f32,
}

#[derive(Clone, Serialize, Deserialize, Debug)]
pub struct PreviewRenderRequest {
    pub target_width: u32,
    pub target_height: u32,
    pub crop: Option<PreviewCrop>,
}

/// Run the full GPU render pipeline and return raw RGBA8 pixels.
#[tauri::command]
pub async fn render_preview(
    request: Option<PreviewRenderRequest>,
    renderer: tauri::State<'_, crate::RendererState>,
    state: tauri::State<'_, Mutex<EditorState>>,
) -> Result<PreviewFrameResponse, String> {
    // Snapshot state without holding the lock during GPU work.
    let (stack, sources, w, h) = {
        let st = state.lock().unwrap();
        if st.canvas_width == 0 {
            return Ok(PreviewFrameResponse {
                pixels: Vec::new(),
                width: 0,
                height: 0,
            });
        }
        (
            st.stack.clone(),
            st.image_sources.clone(),
            st.canvas_width,
            st.canvas_height,
        )
    };

    let guard = renderer.0.lock().await;
    let r = guard.as_ref().ok_or("GPU renderer not ready yet")?;

    let request = request.unwrap_or(PreviewRenderRequest {
        target_width: w,
        target_height: h,
        crop: None,
    });
    let pixels = r
        .render_stack_preview(
            &stack,
            &sources,
            w,
            h,
            request.target_width,
            request.target_height,
            request.crop.map(|crop| shade_gpu::PreviewCrop {
                x: crop.x,
                y: crop.y,
                width: crop.width,
                height: crop.height,
            }),
        )
        .await
        .map_err(|e| e.to_string())?;
    Ok(PreviewFrameResponse {
        pixels,
        width: request.target_width,
        height: request.target_height,
    })
}

#[tauri::command]
pub async fn export_image(
    _path: String,
    _state: tauri::State<'_, Mutex<EditorState>>,
) -> Result<(), String> {
    // Placeholder — full GPU render would go here.
    // In a real implementation this would call renderer.render_stack()
    Ok(())
}

#[derive(Serialize, Deserialize, Debug)]
pub struct EditParams {
    pub layer_idx: usize,
    pub op: String, // "tone", "curves", "color", "vignette", "sharpen", "grain"
    pub exposure: Option<f32>,
    pub contrast: Option<f32>,
    pub blacks: Option<f32>,
    pub highlights: Option<f32>,
    pub shadows: Option<f32>,
    pub lut_r: Option<Vec<f32>>,
    pub lut_g: Option<Vec<f32>>,
    pub lut_b: Option<Vec<f32>>,
    pub lut_master: Option<Vec<f32>>,
    pub per_channel: Option<bool>,
    pub saturation: Option<f32>,
    pub vibrancy: Option<f32>,
    pub temperature: Option<f32>,
    pub tint: Option<f32>,
    pub vignette_amount: Option<f32>,
    pub sharpen_amount: Option<f32>,
    pub grain_amount: Option<f32>,
}

#[tauri::command]
pub async fn apply_edit(
    params: EditParams,
    state: tauri::State<'_, Mutex<EditorState>>,
) -> Result<(), String> {
    let mut st = state.lock().unwrap();
    if params.layer_idx >= st.stack.layers.len() {
        return Err("layer index out of bounds".into());
    }
    let layer = &mut st.stack.layers[params.layer_idx];
    match &mut layer.layer {
        shade_core::Layer::Adjustment { ops } => {
            match params.op.as_str() {
                "tone" => {
                    let next = AdjustmentOp::Tone {
                        exposure: params.exposure.unwrap_or(0.0),
                        contrast: params.contrast.unwrap_or(0.0),
                        blacks: params.blacks.unwrap_or(0.0),
                        highlights: params.highlights.unwrap_or(0.0),
                        shadows: params.shadows.unwrap_or(0.0),
                    };
                    if let Some(op) = ops
                        .iter_mut()
                        .find(|op| matches!(op, AdjustmentOp::Tone { .. }))
                    {
                        *op = next;
                    } else {
                        ops.push(next);
                    }
                }
                "color" => {
                    let next = AdjustmentOp::Color(ColorParams {
                        saturation: params.saturation.unwrap_or(1.0),
                        vibrancy: params.vibrancy.unwrap_or(0.0),
                        temperature: params.temperature.unwrap_or(0.0),
                        tint: params.tint.unwrap_or(0.0),
                    });
                    if let Some(op) = ops
                        .iter_mut()
                        .find(|op| matches!(op, AdjustmentOp::Color(_)))
                    {
                        *op = next;
                    } else {
                        ops.push(next);
                    }
                }
                "curves" => {
                    let next = AdjustmentOp::Curves {
                        lut_r: params.lut_r.ok_or("missing lut_r")?,
                        lut_g: params.lut_g.ok_or("missing lut_g")?,
                        lut_b: params.lut_b.ok_or("missing lut_b")?,
                        lut_master: params.lut_master.ok_or("missing lut_master")?,
                        per_channel: params.per_channel.unwrap_or(false),
                    };
                    if let Some(op) = ops
                        .iter_mut()
                        .find(|op| matches!(op, AdjustmentOp::Curves { .. }))
                    {
                        *op = next;
                    } else {
                        ops.push(next);
                    }
                }
                "vignette" => {
                    let next = AdjustmentOp::Vignette(VignetteParams {
                        amount: params.vignette_amount.unwrap_or(0.0),
                        ..Default::default()
                    });
                    if let Some(op) = ops
                        .iter_mut()
                        .find(|op| matches!(op, AdjustmentOp::Vignette(_)))
                    {
                        *op = next;
                    } else {
                        ops.push(next);
                    }
                }
                "sharpen" => {
                    let next = AdjustmentOp::Sharpen(SharpenParams {
                        amount: params.sharpen_amount.unwrap_or(0.0),
                        threshold: 0.1,
                    });
                    if let Some(op) = ops
                        .iter_mut()
                        .find(|op| matches!(op, AdjustmentOp::Sharpen(_)))
                    {
                        *op = next;
                    } else {
                        ops.push(next);
                    }
                }
                "grain" => {
                    let next = AdjustmentOp::Grain(GrainParams {
                        amount: params.grain_amount.unwrap_or(0.0),
                        ..Default::default()
                    });
                    if let Some(op) = ops
                        .iter_mut()
                        .find(|op| matches!(op, AdjustmentOp::Grain(_)))
                    {
                        *op = next;
                    } else {
                        ops.push(next);
                    }
                }
                _ => return Err(format!("unknown op: {}", params.op)),
            }
            st.stack.generation += 1;
        }
        _ => return Err("target layer is not an adjustment layer".into()),
    }
    Ok(())
}

#[tauri::command]
pub async fn add_layer(
    kind: String,
    state: tauri::State<'_, Mutex<EditorState>>,
) -> Result<usize, String> {
    let mut st = state.lock().unwrap();
    let idx = match kind.as_str() {
        "adjustment" => st.stack.add_adjustment_layer(vec![AdjustmentOp::Tone {
            exposure: 0.0,
            contrast: 0.0,
            blacks: 0.0,
            highlights: 0.0,
            shadows: 0.0,
        }]),
        "curves" => st.stack.add_adjustment_layer(vec![AdjustmentOp::Curves {
            lut_r: linear_lut(),
            lut_g: linear_lut(),
            lut_b: linear_lut(),
            lut_master: linear_lut(),
            per_channel: false,
        }]),
        _ => return Err(format!("unknown layer kind: {kind}")),
    };
    Ok(idx)
}

#[derive(Serialize, Deserialize, Debug)]
pub struct LayerVisibility {
    pub layer_idx: usize,
    pub visible: bool,
}

#[tauri::command]
pub async fn set_layer_visible(
    params: LayerVisibility,
    state: tauri::State<'_, Mutex<EditorState>>,
) -> Result<(), String> {
    let mut st = state.lock().unwrap();
    if params.layer_idx >= st.stack.layers.len() {
        return Err("index out of bounds".into());
    }
    st.stack.layers[params.layer_idx].visible = params.visible;
    st.stack.generation += 1;
    Ok(())
}

#[derive(Serialize, Deserialize, Debug)]
pub struct LayerOpacityParams {
    pub layer_idx: usize,
    pub opacity: f32,
}

#[tauri::command]
pub async fn set_layer_opacity(
    params: LayerOpacityParams,
    state: tauri::State<'_, Mutex<EditorState>>,
) -> Result<(), String> {
    let mut st = state.lock().unwrap();
    if params.layer_idx >= st.stack.layers.len() {
        return Err("index out of bounds".into());
    }
    st.stack.layers[params.layer_idx].opacity = params.opacity.clamp(0.0, 1.0);
    st.stack.generation += 1;
    Ok(())
}

#[derive(Serialize, Deserialize, Debug)]
pub struct LayerStackInfo {
    pub layers: Vec<LayerEntryInfo>,
    pub canvas_width: u32,
    pub canvas_height: u32,
    pub generation: u64,
}

#[derive(Serialize, Deserialize, Debug)]
pub struct LayerEntryInfo {
    pub kind: String,
    pub visible: bool,
    pub opacity: f32,
    pub blend_mode: String,
    pub adjustments: Option<AdjustmentValues>,
}

#[derive(Serialize, Deserialize, Debug, Default)]
pub struct AdjustmentValues {
    pub tone: Option<ToneValues>,
    pub curves: Option<CurvesValues>,
    pub color: Option<ColorValues>,
    pub vignette: Option<VignetteValues>,
    pub sharpen: Option<SharpenValues>,
    pub grain: Option<GrainValues>,
}

#[derive(Serialize, Deserialize, Debug)]
pub struct ToneValues {
    pub exposure: f32,
    pub contrast: f32,
    pub blacks: f32,
    pub highlights: f32,
    pub shadows: f32,
}

#[derive(Serialize, Deserialize, Debug)]
pub struct CurvesValues {
    pub lut_r: Vec<f32>,
    pub lut_g: Vec<f32>,
    pub lut_b: Vec<f32>,
    pub lut_master: Vec<f32>,
    pub per_channel: bool,
}

#[derive(Serialize, Deserialize, Debug)]
pub struct ColorValues {
    pub saturation: f32,
    pub temperature: f32,
    pub tint: f32,
}

#[derive(Serialize, Deserialize, Debug)]
pub struct VignetteValues {
    pub amount: f32,
}

#[derive(Serialize, Deserialize, Debug)]
pub struct SharpenValues {
    pub amount: f32,
}

#[derive(Serialize, Deserialize, Debug)]
pub struct GrainValues {
    pub amount: f32,
}

#[tauri::command]
pub async fn get_layer_stack(
    state: tauri::State<'_, Mutex<EditorState>>,
) -> Result<LayerStackInfo, String> {
    let st = state.lock().unwrap();
    let layers = st
        .stack
        .layers
        .iter()
        .map(|l| LayerEntryInfo {
            kind: match &l.layer {
                shade_core::Layer::Image { .. } => "image".into(),
                shade_core::Layer::Adjustment { .. } => "adjustment".into(),
            },
            visible: l.visible,
            opacity: l.opacity,
            blend_mode: format!("{:?}", l.blend_mode),
            adjustments: match &l.layer {
                shade_core::Layer::Image { .. } => None,
                shade_core::Layer::Adjustment { ops } => {
                    let mut adjustments = AdjustmentValues::default();
                    for op in ops {
                        match op {
                            AdjustmentOp::Tone {
                                exposure,
                                contrast,
                                blacks,
                                highlights,
                                shadows,
                            } => {
                                adjustments.tone = Some(ToneValues {
                                    exposure: *exposure,
                                    contrast: *contrast,
                                    blacks: *blacks,
                                    highlights: *highlights,
                                    shadows: *shadows,
                                });
                            }
                            AdjustmentOp::Color(params) => {
                                adjustments.color = Some(ColorValues {
                                    saturation: params.saturation,
                                    temperature: params.temperature,
                                    tint: params.tint,
                                });
                            }
                            AdjustmentOp::Curves {
                                lut_r,
                                lut_g,
                                lut_b,
                                lut_master,
                                per_channel,
                            } => {
                                adjustments.curves = Some(CurvesValues {
                                    lut_r: lut_r.clone(),
                                    lut_g: lut_g.clone(),
                                    lut_b: lut_b.clone(),
                                    lut_master: lut_master.clone(),
                                    per_channel: *per_channel,
                                });
                            }
                            AdjustmentOp::Vignette(params) => {
                                adjustments.vignette = Some(VignetteValues {
                                    amount: params.amount,
                                });
                            }
                            AdjustmentOp::Sharpen(params) => {
                                adjustments.sharpen = Some(SharpenValues {
                                    amount: params.amount,
                                });
                            }
                            AdjustmentOp::Grain(params) => {
                                adjustments.grain = Some(GrainValues {
                                    amount: params.amount,
                                });
                            }
                        }
                    }
                    Some(adjustments)
                }
            },
        })
        .collect();
    Ok(LayerStackInfo {
        layers,
        canvas_width: st.canvas_width,
        canvas_height: st.canvas_height,
        generation: st.stack.generation,
    })
}
