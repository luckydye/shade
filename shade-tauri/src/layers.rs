use serde::{Deserialize, Serialize};
use shade_lib::{
    linear_lut, AdjustmentOp,
    CropRect, CurveControlPoint, MaskParams,
};
use std::collections::HashMap;
use std::sync::Mutex;
use crate::editor_state::{EditorState, broadcast_layer_stack, finalize_layer_stack_mutation, lock_editor_state, restore_masks_from_params};
use crate::text_layers::TextLayerValues;


#[tauri::command]
pub async fn add_layer<R: tauri::Runtime>(
    kind: String,
    state: tauri::State<'_, Mutex<EditorState>>,
    app: tauri::AppHandle<R>,
) -> Result<usize, String> {
    let idx = {
        let mut st = lock_editor_state(&state)?;
        let canvas_width = st.canvas_width;
        let canvas_height = st.canvas_height;
        match kind.as_str() {
            "adjustment" => st.stack.add_adjustment_layer(vec![AdjustmentOp::Tone {
                exposure: 0.0,
                contrast: 0.0,
                blacks: 0.0,
                whites: 0.0,
                highlights: 0.0,
                shadows: 0.0,
                gamma: 1.0,
            }]),
            "curves" => st.stack.add_adjustment_layer(vec![AdjustmentOp::Curves {
                lut_r: linear_lut(),
                lut_g: linear_lut(),
                lut_b: linear_lut(),
                lut_master: linear_lut(),
                per_channel: false,
                control_points: None,
            }]),
            "ls_curve" => st.stack.add_adjustment_layer(vec![AdjustmentOp::LsCurve {
                lut: linear_lut(),
                control_points: None,
            }]),
            "crop" => st.stack.add_crop_layer(CropRect {
                x: 0.0,
                y: 0.0,
                width: canvas_width as f32,
                height: canvas_height as f32,
                rotation: 0.0,
            }),
            _ => return Err(format!("unknown layer kind: {kind}")),
        }
    };
    finalize_layer_stack_mutation(&app, &state).await?;
    Ok(idx)
}
#[derive(Serialize, Deserialize, Debug)]
pub struct LayerVisibility {
    pub layer_idx: usize,
    pub visible: bool,
}
#[tauri::command]
pub async fn set_layer_visible<R: tauri::Runtime>(
    params: LayerVisibility,
    state: tauri::State<'_, Mutex<EditorState>>,
    app: tauri::AppHandle<R>,
) -> Result<(), String> {
    {
        let mut st = lock_editor_state(&state)?;
        if params.layer_idx >= st.stack.layers.len() {
            return Err("index out of bounds".into());
        }
        st.stack.layers[params.layer_idx].visible = params.visible;
        st.stack.generation += 1;
    }
    finalize_layer_stack_mutation(&app, &state).await?;
    Ok(())
}
#[derive(Serialize, Deserialize, Debug)]
pub struct LayerOpacityParams {
    pub layer_idx: usize,
    pub opacity: f32,
}
#[derive(Serialize, Deserialize, Debug)]
pub struct RenameLayerParams {
    pub layer_idx: usize,
    pub name: Option<String>,
}
#[tauri::command]
pub async fn set_layer_opacity<R: tauri::Runtime>(
    params: LayerOpacityParams,
    state: tauri::State<'_, Mutex<EditorState>>,
    app: tauri::AppHandle<R>,
) -> Result<(), String> {
    {
        let mut st = lock_editor_state(&state)?;
        if params.layer_idx >= st.stack.layers.len() {
            return Err("index out of bounds".into());
        }
        st.stack.layers[params.layer_idx].opacity = params.opacity.clamp(0.0, 1.0);
        st.stack.generation += 1;
    }
    finalize_layer_stack_mutation(&app, &state).await?;
    Ok(())
}
#[tauri::command]
pub async fn rename_layer<R: tauri::Runtime>(
    params: RenameLayerParams,
    state: tauri::State<'_, Mutex<EditorState>>,
    app: tauri::AppHandle<R>,
) -> Result<(), String> {
    {
        let mut st = lock_editor_state(&state)?;
        if params.layer_idx >= st.stack.layers.len() {
            return Err("index out of bounds".into());
        }
        st.stack.layers[params.layer_idx].name = params
            .name
            .as_ref()
            .map(|name| name.trim().to_string())
            .filter(|name| !name.is_empty());
        st.stack.generation += 1;
    }
    finalize_layer_stack_mutation(&app, &state).await?;
    Ok(())
}
#[derive(Serialize, Deserialize, Debug)]
pub struct DeleteLayerParams {
    pub layer_idx: usize,
}
#[tauri::command]
pub async fn delete_layer<R: tauri::Runtime>(
    params: DeleteLayerParams,
    state: tauri::State<'_, Mutex<EditorState>>,
    app: tauri::AppHandle<R>,
) -> Result<(), String> {
    {
        let mut st = lock_editor_state(&state)?;
        if params.layer_idx >= st.stack.layers.len() {
            return Err("index out of bounds".into());
        }
        if let Some(mask_id) = st.stack.layers[params.layer_idx].mask {
            st.stack.masks.remove(&mask_id);
        }
        st.stack.layers.remove(params.layer_idx);
        st.stack.generation += 1;
    }
    finalize_layer_stack_mutation(&app, &state).await?;
    Ok(())
}
#[derive(Serialize, Deserialize, Debug)]
pub struct MoveLayerParams {
    pub from_idx: usize,
    pub to_idx: usize,
}
#[tauri::command]
pub async fn move_layer<R: tauri::Runtime>(
    params: MoveLayerParams,
    state: tauri::State<'_, Mutex<EditorState>>,
    app: tauri::AppHandle<R>,
) -> Result<usize, String> {
    let new_idx = {
        let mut st = lock_editor_state(&state)?;
        let len = st.stack.layers.len();
        if params.from_idx >= len {
            return Err("source index out of bounds".into());
        }
        if params.to_idx > len {
            return Err("target index out of bounds".into());
        }
        if params.to_idx == params.from_idx || params.to_idx == params.from_idx + 1 {
            return Ok(params.from_idx);
        }
        let entry = st.stack.layers.remove(params.from_idx);
        let insert_idx = if params.to_idx > params.from_idx {
            params.to_idx - 1
        } else {
            params.to_idx
        };
        st.stack.layers.insert(insert_idx, entry);
        st.stack.generation += 1;
        insert_idx
    };
    finalize_layer_stack_mutation(&app, &state).await?;
    Ok(new_idx)
}
#[derive(Serialize, Deserialize, Debug)]
pub struct LayerStackInfo {
    pub layers: Vec<LayerEntryInfo>,
    pub canvas_width: u32,
    pub canvas_height: u32,
    pub generation: u64,
}
#[derive(Serialize, Deserialize, Debug)]
pub struct MaskParamsInfo {
    pub kind: String,
    // linear
    pub x1: Option<f32>,
    pub y1: Option<f32>,
    pub x2: Option<f32>,
    pub y2: Option<f32>,
    // radial
    pub cx: Option<f32>,
    pub cy: Option<f32>,
    pub radius: Option<f32>,
}
impl From<&MaskParams> for MaskParamsInfo {
    fn from(p: &MaskParams) -> Self {
        match p {
            MaskParams::Linear { x1, y1, x2, y2 } => MaskParamsInfo {
                kind: "linear".into(),
                x1: Some(*x1),
                y1: Some(*y1),
                x2: Some(*x2),
                y2: Some(*y2),
                cx: None,
                cy: None,
                radius: None,
            },
            MaskParams::Radial { cx, cy, radius } => MaskParamsInfo {
                kind: "radial".into(),
                x1: None,
                y1: None,
                x2: None,
                y2: None,
                cx: Some(*cx),
                cy: Some(*cy),
                radius: Some(*radius),
            },
            MaskParams::Brush { .. } => MaskParamsInfo {
                kind: "brush".into(),
                x1: None,
                y1: None,
                x2: None,
                y2: None,
                cx: None,
                cy: None,
                radius: None,
            },
        }
    }
}
#[derive(Serialize, Deserialize, Debug)]
pub struct LayerEntryInfo {
    pub kind: String,
    pub name: Option<String>,
    pub visible: bool,
    pub opacity: f32,
    pub blend_mode: String,
    pub has_mask: bool,
    pub mask_params: Option<MaskParamsInfo>,
    pub adjustments: Option<AdjustmentValues>,
    pub crop: Option<CropValues>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<TextLayerValues>,
}
#[derive(Serialize, Deserialize, Debug)]
pub struct CropValues {
    pub x: f32,
    pub y: f32,
    pub width: f32,
    pub height: f32,
    pub rotation: f32,
}
#[derive(Serialize, Deserialize, Debug, Default)]
pub struct AdjustmentValues {
    pub tone: Option<ToneValues>,
    pub curves: Option<CurvesValues>,
    pub ls_curve: Option<LsCurveValues>,
    pub color: Option<ColorValues>,
    pub vignette: Option<VignetteValues>,
    pub sharpen: Option<SharpenValues>,
    pub grain: Option<GrainValues>,
    pub glow: Option<GlowValues>,
    pub hsl: Option<HslValues>,
    pub denoise: Option<DenoiseValues>,
}
#[derive(Serialize, Deserialize, Debug)]
pub struct DenoiseValues {
    pub luma_strength: f32,
    pub chroma_strength: f32,
    pub mode: u32,
}
#[derive(Serialize, Deserialize, Debug)]
pub struct ToneValues {
    pub exposure: f32,
    pub contrast: f32,
    pub blacks: f32,
    pub whites: f32,
    pub highlights: f32,
    pub shadows: f32,
    pub gamma: f32,
}
#[derive(Serialize, Deserialize, Debug)]
pub struct CurvesValues {
    pub lut_r: Vec<f32>,
    pub lut_g: Vec<f32>,
    pub lut_b: Vec<f32>,
    pub lut_master: Vec<f32>,
    pub per_channel: bool,
    pub control_points: Option<Vec<CurveControlPoint>>,
}
#[derive(Serialize, Deserialize, Debug)]
pub struct LsCurveValues {
    pub lut: Vec<f32>,
    pub control_points: Option<Vec<CurveControlPoint>>,
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
    pub size: f32,
}
#[derive(Serialize, Deserialize, Debug)]
pub struct GlowValues {
    pub amount: f32,
}
#[derive(Serialize, Deserialize, Debug)]
pub struct HslValues {
    pub red_hue: f32,
    pub red_sat: f32,
    pub red_lum: f32,
    pub green_hue: f32,
    pub green_sat: f32,
    pub green_lum: f32,
    pub blue_hue: f32,
    pub blue_sat: f32,
    pub blue_lum: f32,
}
#[derive(Serialize, Deserialize)]
pub(crate) struct StackSnapshot {
    pub(crate) layers: Vec<shade_lib::LayerEntry>,
    pub(crate) mask_params: HashMap<shade_lib::MaskId, shade_lib::MaskParams>,
}
#[tauri::command]
pub fn get_stack_snapshot(
    state: tauri::State<'_, Mutex<EditorState>>,
) -> Result<String, String> {
    let st = lock_editor_state(&state)?;
    let non_image: Vec<_> = st
        .stack
        .layers
        .iter()
        .filter(|l| !matches!(l.layer, shade_lib::Layer::Image { .. }))
        .cloned()
        .collect();
    let mut mp = HashMap::new();
    for layer in &non_image {
        if let Some(mask_id) = layer.mask {
            if let Some(params) = st.stack.mask_params.get(&mask_id) {
                mp.insert(mask_id, params.clone());
            }
        }
    }
    serde_json::to_string(&StackSnapshot {
        layers: non_image,
        mask_params: mp,
    })
    .map_err(|e| e.to_string())
}
#[tauri::command]
pub async fn replace_stack<R: tauri::Runtime>(
    layers_json: String,
    state: tauri::State<'_, Mutex<EditorState>>,
    app: tauri::AppHandle<R>,
) -> Result<(), String> {
    let snap: StackSnapshot =
        serde_json::from_str(&layers_json).map_err(|e| e.to_string())?;
    {
        let mut st = lock_editor_state(&state)?;
        let image_layers: Vec<_> = st
            .stack
            .layers
            .iter()
            .filter(|entry| matches!(entry.layer, shade_lib::Layer::Image { .. }))
            .cloned()
            .collect();
        if image_layers.is_empty() {
            return Err("no image layers to preserve".into());
        }
        st.stack.layers = image_layers;
        st.stack.masks.clear();
        st.stack.mask_params.clear();
        let base_idx = st.stack.layers.len();
        st.stack.layers.extend(snap.layers);
        let w = st.canvas_width;
        let h = st.canvas_height;
        restore_masks_from_params(&mut st.stack, base_idx, &snap.mask_params, w, h);
        st.stack.generation += 1;
    }
    broadcast_layer_stack(&app, &state).await;
    Ok(())
}
