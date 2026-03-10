use std::sync::Mutex;
use shade_core::{
    LayerStack, AdjustmentOp, ColorParams, VignetteParams, SharpenParams, GrainParams,
};
use shade_io::load_image;
use serde::{Deserialize, Serialize};

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
    let (pixels, w, h) = load_image(std::path::Path::new(&path))
        .map_err(|e| e.to_string())?;
    let mut st = state.lock().unwrap();
    let tid = st.next_texture_id;
    st.next_texture_id += 1;
    st.image_sources.insert(tid, (pixels, w, h));
    st.canvas_width = w;
    st.canvas_height = h;
    st.stack.add_image_layer(tid, w, h);
    // Add a default adjustment layer on top
    st.stack.add_adjustment_layer(vec![AdjustmentOp::Tone {
        exposure: 0.0,
        contrast: 0.0,
        blacks: 0.0,
        highlights: 0.0,
        shadows: 0.0,
    }]);
    Ok(LayerInfoResponse {
        layer_count: st.stack.layers.len(),
        canvas_width: w,
        canvas_height: h,
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
    pub op: String,     // "tone", "color", "vignette", "sharpen", "grain"
    pub exposure: Option<f32>,
    pub contrast: Option<f32>,
    pub blacks: Option<f32>,
    pub highlights: Option<f32>,
    pub shadows: Option<f32>,
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
            ops.clear();
            match params.op.as_str() {
                "tone" => ops.push(AdjustmentOp::Tone {
                    exposure: params.exposure.unwrap_or(0.0),
                    contrast: params.contrast.unwrap_or(0.0),
                    blacks: params.blacks.unwrap_or(0.0),
                    highlights: params.highlights.unwrap_or(0.0),
                    shadows: params.shadows.unwrap_or(0.0),
                }),
                "color" => ops.push(AdjustmentOp::Color(ColorParams {
                    saturation: params.saturation.unwrap_or(1.0),
                    vibrancy: params.vibrancy.unwrap_or(0.0),
                    temperature: params.temperature.unwrap_or(0.0),
                    tint: params.tint.unwrap_or(0.0),
                })),
                "vignette" => ops.push(AdjustmentOp::Vignette(VignetteParams {
                    amount: params.vignette_amount.unwrap_or(0.0),
                    ..Default::default()
                })),
                "sharpen" => ops.push(AdjustmentOp::Sharpen(SharpenParams {
                    amount: params.sharpen_amount.unwrap_or(0.0),
                    threshold: 0.1,
                })),
                "grain" => ops.push(AdjustmentOp::Grain(GrainParams {
                    amount: params.grain_amount.unwrap_or(0.0),
                    ..Default::default()
                })),
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
        })
        .collect();
    Ok(LayerStackInfo {
        layers,
        canvas_width: st.canvas_width,
        canvas_height: st.canvas_height,
        generation: st.stack.generation,
    })
}
