use crate::editor_state::{
    finalize_layer_stack_mutation, lock_editor_state, EditorState,
};
use serde::{Deserialize, Serialize};
use shade_lib::{CropRect, MaskData, MaskParams};
use std::sync::Mutex;

#[derive(Serialize, Deserialize, Debug)]
pub struct GradientMaskParams {
    pub layer_idx: usize,
    pub kind: String,
    // linear: x1, y1, x2, y2
    pub x1: Option<f32>,
    pub y1: Option<f32>,
    pub x2: Option<f32>,
    pub y2: Option<f32>,
    // radial: cx, cy, radius
    pub cx: Option<f32>,
    pub cy: Option<f32>,
    pub radius: Option<f32>,
}
#[tauri::command]
pub async fn apply_gradient_mask<R: tauri::Runtime>(
    params: GradientMaskParams,
    state: tauri::State<'_, Mutex<EditorState>>,
    app: tauri::AppHandle<R>,
) -> Result<(), String> {
    {
        let mut st = lock_editor_state(&state)?;
        if params.layer_idx >= st.stack.layers.len() {
            return Err("index out of bounds".into());
        }
        let w = st.canvas_width;
        let h = st.canvas_height;
        let mut mask = MaskData::new_empty(w, h);
        let mp = match params.kind.as_str() {
            "linear" => {
                let x1 = params.x1.ok_or("linear gradient requires x1")?;
                let y1 = params.y1.ok_or("linear gradient requires y1")?;
                let x2 = params.x2.ok_or("linear gradient requires x2")?;
                let y2 = params.y2.ok_or("linear gradient requires y2")?;
                mask.fill_linear_gradient(x1, y1, x2, y2);
                MaskParams::Linear { x1, y1, x2, y2 }
            }
            "radial" => {
                let cx = params.cx.ok_or("radial gradient requires cx")?;
                let cy = params.cy.ok_or("radial gradient requires cy")?;
                let radius = params.radius.ok_or("radial gradient requires radius")?;
                mask.fill_radial_gradient(cx, cy, radius);
                MaskParams::Radial { cx, cy, radius }
            }
            other => return Err(format!("unknown gradient kind: {other}")),
        };
        st.stack.set_mask_with_params(params.layer_idx, mask, mp);
    }
    finalize_layer_stack_mutation(&app, &state).await?;
    Ok(())
}
#[derive(Serialize, Deserialize, Debug)]
pub struct RemoveMaskParams {
    pub layer_idx: usize,
}
#[tauri::command]
pub async fn remove_mask<R: tauri::Runtime>(
    params: RemoveMaskParams,
    state: tauri::State<'_, Mutex<EditorState>>,
    app: tauri::AppHandle<R>,
) -> Result<(), String> {
    {
        let mut st = lock_editor_state(&state)?;
        if params.layer_idx >= st.stack.layers.len() {
            return Err("index out of bounds".into());
        }
        st.stack.remove_mask(params.layer_idx);
    }
    finalize_layer_stack_mutation(&app, &state).await?;
    Ok(())
}
#[derive(Serialize, Deserialize, Debug)]
pub struct CreateBrushMaskParams {
    pub layer_idx: usize,
}
#[tauri::command]
pub async fn create_brush_mask<R: tauri::Runtime>(
    params: CreateBrushMaskParams,
    state: tauri::State<'_, Mutex<EditorState>>,
    app: tauri::AppHandle<R>,
) -> Result<(), String> {
    {
        let mut st = lock_editor_state(&state)?;
        if params.layer_idx >= st.stack.layers.len() {
            return Err("index out of bounds".into());
        }
        let w = st.canvas_width;
        let h = st.canvas_height;
        let mask = shade_lib::MaskData::new_empty(w, h);
        let mp = shade_lib::MaskParams::Brush {
            width: w,
            height: h,
            pixels: vec![0u8; (w * h) as usize],
        };
        st.stack.set_mask_with_params(params.layer_idx, mask, mp);
    }
    finalize_layer_stack_mutation(&app, &state).await?;
    Ok(())
}
#[derive(Serialize, Deserialize, Debug)]
pub struct StampBrushMaskParams {
    pub layer_idx: usize,
    pub cx: f32,
    pub cy: f32,
    pub radius: f32,
    pub softness: f32,
    pub erase: bool,
}
#[tauri::command]
pub async fn stamp_brush_mask(
    params: StampBrushMaskParams,
    state: tauri::State<'_, Mutex<EditorState>>,
) -> Result<(), String> {
    {
        let mut st = lock_editor_state(&state)?;
        if params.layer_idx >= st.stack.layers.len() {
            return Err("index out of bounds".into());
        }
        let mask_id = st.stack.layers[params.layer_idx]
            .mask
            .ok_or("layer has no mask")?;
        let data = st
            .stack
            .masks
            .get_mut(&mask_id)
            .ok_or("mask data missing")?;
        data.stamp_brush(
            params.cx,
            params.cy,
            params.radius,
            params.softness,
            params.erase,
        );
        st.stack.generation += 1;
    }
    Ok(())
}
#[derive(Serialize, Deserialize, Debug)]
pub struct GetMaskThumbnailParams {
    pub layer_idx: usize,
    pub max_w: u32,
    pub max_h: u32,
}
#[derive(Serialize, Deserialize, Debug)]
pub struct MaskThumbnail {
    pub pixels: Vec<u8>,
    pub width: u32,
    pub height: u32,
}
#[tauri::command]
pub async fn get_mask_thumbnail(
    params: GetMaskThumbnailParams,
    state: tauri::State<'_, Mutex<EditorState>>,
) -> Result<MaskThumbnail, String> {
    let st = lock_editor_state(&state)?;
    if params.layer_idx >= st.stack.layers.len() {
        return Err("index out of bounds".into());
    }
    let mask_id = st.stack.layers[params.layer_idx]
        .mask
        .ok_or("layer has no mask")?;
    let data = st.stack.masks.get(&mask_id).ok_or("mask data missing")?;
    let (pixels, width, height) = data.get_thumbnail(params.max_w, params.max_h);
    Ok(MaskThumbnail {
        pixels,
        width,
        height,
    })
}
pub(crate) fn normalize_crop_rect(
    rect: CropRect,
    canvas_width: u32,
    canvas_height: u32,
) -> Result<CropRect, String> {
    if canvas_width == 0 || canvas_height == 0 {
        return Err("cannot edit crop without a loaded image".into());
    }
    let max_width = canvas_width as f32;
    let max_height = canvas_height as f32;
    let width = rect.width.clamp(1.0, max_width);
    let height = rect.height.clamp(1.0, max_height);
    let x = rect.x.clamp(0.0, max_width - width);
    let y = rect.y.clamp(0.0, max_height - height);
    Ok(CropRect {
        x,
        y,
        width,
        height,
        rotation: rect.rotation,
    })
}
