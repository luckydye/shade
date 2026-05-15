use serde::{Deserialize, Serialize};
use shade_lib::{
    build_curve_lut_from_points, linear_lut, AdjustmentOp, ColorParams,
    CropRect, CurveControlPoint, DenoiseParams, GlowParams, GrainParams,
    HslParams,
    SharpenParams, VignetteParams,
};
use std::sync::Mutex;
use crate::editor_state::{EditorState, finalize_layer_stack_mutation, lock_editor_state};
use crate::masks::normalize_crop_rect;


#[derive(Serialize, Deserialize, Debug)]
pub struct EditParams {
    pub layer_idx: usize,
    pub op: String, // "tone", "curves", "ls_curve", "color", "vignette", "sharpen", "grain"
    pub exposure: Option<f32>,
    pub contrast: Option<f32>,
    pub blacks: Option<f32>,
    pub whites: Option<f32>,
    pub highlights: Option<f32>,
    pub shadows: Option<f32>,
    pub gamma: Option<f32>,

    pub lut_r: Option<Vec<f32>>,
    pub lut_g: Option<Vec<f32>>,
    pub lut_b: Option<Vec<f32>>,
    pub lut_master: Option<Vec<f32>>,
    pub per_channel: Option<bool>,
    pub curve_points: Option<Vec<CurveControlPoint>>,
    pub saturation: Option<f32>,
    pub vibrancy: Option<f32>,
    pub temperature: Option<f32>,
    pub tint: Option<f32>,
    pub vignette_amount: Option<f32>,
    pub sharpen_amount: Option<f32>,
    pub grain_amount: Option<f32>,
    pub grain_size: Option<f32>,
    pub glow_amount: Option<f32>,
    pub red_hue: Option<f32>,
    pub red_sat: Option<f32>,
    pub red_lum: Option<f32>,
    pub green_hue: Option<f32>,
    pub green_sat: Option<f32>,
    pub green_lum: Option<f32>,
    pub blue_hue: Option<f32>,
    pub blue_sat: Option<f32>,
    pub blue_lum: Option<f32>,
    pub crop_x: Option<f32>,
    pub crop_y: Option<f32>,
    pub crop_width: Option<f32>,
    pub crop_height: Option<f32>,
    pub crop_rotation: Option<f32>,
    pub denoise_luma_strength: Option<f32>,
    pub denoise_chroma_strength: Option<f32>,
    pub denoise_mode: Option<u32>,
}
#[tauri::command]
pub async fn apply_edit<R: tauri::Runtime>(
    params: EditParams,
    state: tauri::State<'_, Mutex<EditorState>>,
    app: tauri::AppHandle<R>,
) -> Result<(), String> {
    {
        let mut st = lock_editor_state(&state)?;
        let canvas_width = st.canvas_width;
        let canvas_height = st.canvas_height;
        if params.layer_idx >= st.stack.layers.len() {
            return Err("layer index out of bounds".into());
        }
        let layer = &mut st.stack.layers[params.layer_idx];
        match &mut layer.layer {
            shade_lib::Layer::Crop { rect } => {
                if params.op != "crop" {
                    return Err("target layer is a crop layer".into());
                }
                *rect = normalize_crop_rect(
                    CropRect {
                        x: params.crop_x.ok_or("missing crop_x")?,
                        y: params.crop_y.ok_or("missing crop_y")?,
                        width: params.crop_width.ok_or("missing crop_width")?,
                        height: params.crop_height.ok_or("missing crop_height")?,
                        rotation: params.crop_rotation.unwrap_or(rect.rotation),
                    },
                    canvas_width,
                    canvas_height,
                )?;
                st.stack.generation += 1;
            }
            shade_lib::Layer::Adjustment { ops } => {
                match params.op.as_str() {
                    "tone" => {
                        let next = AdjustmentOp::Tone {
                            exposure: params.exposure.unwrap_or(0.0),
                            contrast: params.contrast.unwrap_or(0.0),
                            blacks: params.blacks.unwrap_or(0.0),
                            whites: params.whites.unwrap_or(0.0),
                            highlights: params.highlights.unwrap_or(0.0),
                            shadows: params.shadows.unwrap_or(0.0),
                            gamma: params.gamma.unwrap_or(1.0),
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
                        let curve_points =
                            params.curve_points.ok_or("missing curve_points")?;
                        let next = AdjustmentOp::Curves {
                            lut_r: linear_lut(),
                            lut_g: linear_lut(),
                            lut_b: linear_lut(),
                            lut_master: build_curve_lut_from_points(&curve_points),
                            per_channel: false,
                            control_points: Some(curve_points),
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
                    "ls_curve" => {
                        let curve_points =
                            params.curve_points.ok_or("missing curve_points")?;
                        let next = AdjustmentOp::LsCurve {
                            lut: build_curve_lut_from_points(&curve_points),
                            control_points: Some(curve_points),
                        };
                        if let Some(op) = ops
                            .iter_mut()
                            .find(|op| matches!(op, AdjustmentOp::LsCurve { .. }))
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
                        let existing = ops
                            .iter()
                            .find_map(|op| {
                                if let AdjustmentOp::Grain(p) = op {
                                    Some(*p)
                                } else {
                                    None
                                }
                            })
                            .unwrap_or_default();
                        let next = AdjustmentOp::Grain(GrainParams {
                            amount: params.grain_amount.unwrap_or(existing.amount),
                            size: params.grain_size.unwrap_or(existing.size),
                            ..existing
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
                    "glow" => {
                        let next = AdjustmentOp::Glow(GlowParams {
                            amount: params.glow_amount.unwrap_or(0.0),
                            ..GlowParams::default()
                        });
                        if let Some(op) = ops
                            .iter_mut()
                            .find(|op| matches!(op, AdjustmentOp::Glow(_)))
                        {
                            *op = next;
                        } else {
                            ops.push(next);
                        }
                    }
                    "hsl" => {
                        let next = AdjustmentOp::Hsl(HslParams {
                            red_hue: params.red_hue.unwrap_or(0.0),
                            red_sat: params.red_sat.unwrap_or(0.0),
                            red_lum: params.red_lum.unwrap_or(0.0),
                            green_hue: params.green_hue.unwrap_or(0.0),
                            green_sat: params.green_sat.unwrap_or(0.0),
                            green_lum: params.green_lum.unwrap_or(0.0),
                            blue_hue: params.blue_hue.unwrap_or(0.0),
                            blue_sat: params.blue_sat.unwrap_or(0.0),
                            blue_lum: params.blue_lum.unwrap_or(0.0),
                        });
                        if let Some(op) =
                            ops.iter_mut().find(|op| matches!(op, AdjustmentOp::Hsl(_)))
                        {
                            *op = next;
                        } else {
                            ops.push(next);
                        }
                    }
                    "denoise" => {
                        let next = AdjustmentOp::Denoise(DenoiseParams {
                            luma_strength: params.denoise_luma_strength.unwrap_or(0.0),
                            chroma_strength: params
                                .denoise_chroma_strength
                                .unwrap_or(0.0),
                            mode: params.denoise_mode.unwrap_or(0),
                            _pad: 0.0,
                        });
                        if let Some(op) = ops
                            .iter_mut()
                            .find(|op| matches!(op, AdjustmentOp::Denoise(_)))
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
            _ => return Err("target layer is not editable by apply_edit".into()),
        }
    }
    finalize_layer_stack_mutation(&app, &state).await?;
    Ok(())
}
