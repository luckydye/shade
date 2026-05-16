use crate::layers::{
    AdjustmentValues, ColorValues, CropValues, CurvesValues, DenoiseValues, GlowValues,
    GrainValues, HslValues, LayerEntryInfo, LayerStackInfo, LsCurveValues,
    MaskParamsInfo, SharpenValues, ToneValues, VignetteValues,
};
use crate::snapshots::persist_current_edit_version;
use crate::text_layers::{
    text_align_str, text_anchor_str, TextBoundsValues, TextLayerValues, TextStyleValues,
    TextTransformValues,
};
use serde::{Deserialize, Serialize};
use shade_lib::{to_acescct_f32, AdjustmentOp, FloatImage, LayerStack};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

pub struct EditorState {
    pub stack: LayerStack,
    pub image_sources: Arc<std::collections::HashMap<shade_lib::TextureId, FloatImage>>,
    pub canvas_width: u32,
    pub canvas_height: u32,
    pub next_texture_id: u64,
    pub source_bit_depth: String,
    pub current_image_hash: Option<String>,
    pub current_image_source: Option<String>,
    pub current_snapshot_id: Option<String>,
    pub next_open_request_id: u64,
    pub active_open_request_id: u64,
}
pub(crate) fn lock_editor_state<'a>(
    state: &'a tauri::State<'_, Mutex<EditorState>>,
) -> Result<std::sync::MutexGuard<'a, EditorState>, String> {
    state
        .lock()
        .map_err(|_| "editor state lock poisoned".to_string())
}
pub(crate) fn texture_id_for_fingerprint(
    fingerprint: &str,
) -> Result<shade_lib::TextureId, String> {
    let prefix = fingerprint
        .get(..16)
        .ok_or_else(|| format!("invalid file hash: {fingerprint}"))?;
    u64::from_str_radix(prefix, 16).map_err(|e| e.to_string())
}
pub(crate) fn non_image_layer_data(stack: &LayerStack) -> PersistedLayerData {
    let layers: Vec<_> = stack
        .layers
        .iter()
        .filter(|entry| !matches!(entry.layer, shade_lib::Layer::Image { .. }))
        .cloned()
        .collect();
    let mask_params: HashMap<shade_lib::MaskId, shade_lib::MaskParams> = layers
        .iter()
        .filter_map(|entry| entry.mask)
        .filter_map(|id| {
            let params = stack.mask_params.get(&id)?;
            // For brush masks, sync current pixel data from the mask store into params
            let synced = match params {
                shade_lib::MaskParams::Brush { .. } => {
                    let data = stack.masks.get(&id)?;
                    shade_lib::MaskParams::Brush {
                        width: data.width,
                        height: data.height,
                        pixels: data.pixels.to_vec(),
                    }
                }
                _ => params.clone(),
            };
            Some((id, synced))
        })
        .collect();
    PersistedLayerData {
        layers,
        mask_params,
    }
}
pub(crate) fn ensure_non_image_layers(
    layers: &[shade_lib::LayerEntry],
) -> Result<(), String> {
    if layers
        .iter()
        .any(|entry| matches!(entry.layer, shade_lib::Layer::Image { .. }))
    {
        return Err("persisted edit versions cannot contain image layers".into());
    }
    Ok(())
}
pub(crate) fn parse_layer_data(json: &str) -> Result<PersistedLayerData, String> {
    if let Ok(data) = serde_json::from_str::<PersistedLayerData>(json) {
        return Ok(data);
    }
    let layers: Vec<shade_lib::LayerEntry> =
        serde_json::from_str(json).map_err(|e| e.to_string())?;
    Ok(PersistedLayerData {
        layers,
        mask_params: HashMap::new(),
    })
}
pub(crate) fn restore_masks_from_params(
    stack: &mut LayerStack,
    base_idx: usize,
    saved_params: &HashMap<shade_lib::MaskId, shade_lib::MaskParams>,
    width: u32,
    height: u32,
) {
    for i in base_idx..stack.layers.len() {
        let Some(old_id) = stack.layers[i].mask else {
            continue;
        };
        let Some(params) = saved_params.get(&old_id) else {
            stack.layers[i].mask = None;
            continue;
        };
        let mask = match params {
            shade_lib::MaskParams::Linear { x1, y1, x2, y2 } => {
                let mut m = shade_lib::MaskData::new_empty(width, height);
                m.fill_linear_gradient(*x1, *y1, *x2, *y2);
                m
            }
            shade_lib::MaskParams::Radial { cx, cy, radius } => {
                let mut m = shade_lib::MaskData::new_empty(width, height);
                m.fill_radial_gradient(*cx, *cy, *radius);
                m
            }
            shade_lib::MaskParams::Brush {
                width: bw,
                height: bh,
                pixels,
            } => shade_lib::MaskData {
                width: *bw,
                height: *bh,
                pixels: pixels.clone().into(),
            },
        };
        stack.set_mask_with_params(i, mask, params.clone());
    }
}
pub(crate) fn restore_persisted_layers(
    state: &mut EditorState,
    fingerprint: String,
    source_name: Option<String>,
    persisted: Option<PersistedEditVersion>,
) -> Result<(), String> {
    state.current_image_hash = Some(fingerprint);
    state.current_image_source = source_name;
    state.current_snapshot_id = persisted.as_ref().map(|v| v.id.clone());
    let Some(persisted) = persisted else {
        return Ok(());
    };
    ensure_non_image_layers(&persisted.data.layers)?;
    let image_layers: Vec<_> = state
        .stack
        .layers
        .iter()
        .filter(|entry| matches!(entry.layer, shade_lib::Layer::Image { .. }))
        .cloned()
        .collect();
    if image_layers.is_empty() {
        return Err("cannot restore persisted edits without an image layer".into());
    }
    state.stack.layers = image_layers;
    state.stack.masks.clear();
    state.stack.mask_params.clear();
    let base_idx = state.stack.layers.len();
    state.stack.layers.extend(persisted.data.layers.clone());
    restore_masks_from_params(
        &mut state.stack,
        base_idx,
        &persisted.data.mask_params,
        state.canvas_width,
        state.canvas_height,
    );
    state.stack.generation += 1;
    Ok(())
}
pub(crate) fn build_persisted_layer_stack(
    texture_id: shade_lib::TextureId,
    width: u32,
    height: u32,
    persisted: &PersistedEditVersion,
) -> Result<LayerStack, String> {
    ensure_non_image_layers(&persisted.data.layers)?;
    let mut stack = LayerStack::new();
    stack.add_image_layer(texture_id, width, height);
    let base_idx = stack.layers.len();
    stack.layers.extend(persisted.data.layers.clone());
    restore_masks_from_params(
        &mut stack,
        base_idx,
        &persisted.data.mask_params,
        width,
        height,
    );
    stack.generation += 1;
    Ok(stack)
}
#[derive(Serialize, Deserialize, Debug)]
pub(crate) struct PersistedLayerData {
    pub(crate) layers: Vec<shade_lib::LayerEntry>,
    #[serde(default)]
    pub(crate) mask_params: HashMap<shade_lib::MaskId, shade_lib::MaskParams>,
}
#[derive(Debug)]
pub(crate) struct PersistedEditVersion {
    pub(crate) id: String,
    pub(crate) data: PersistedLayerData,
}
impl Default for EditorState {
    fn default() -> Self {
        Self {
            stack: LayerStack::new(),
            image_sources: Arc::new(std::collections::HashMap::new()),
            canvas_width: 1920,
            canvas_height: 1080,
            next_texture_id: 1,
            source_bit_depth: "Unknown".into(),
            current_image_hash: None,
            current_image_source: None,
            current_snapshot_id: None,
            next_open_request_id: 0,
            active_open_request_id: 0,
        }
    }
}
impl EditorState {
    pub fn begin_open_request(&mut self) -> u64 {
        self.next_open_request_id += 1;
        self.active_open_request_id = self.next_open_request_id;
        self.active_open_request_id
    }

    pub fn is_current_open_request(&self, request_id: u64) -> bool {
        self.active_open_request_id == request_id
    }

    pub fn replace_with_image(
        &mut self,
        mut pixels: Vec<f32>,
        width: u32,
        height: u32,
        source_bit_depth: String,
        color_space: shade_lib::ColorSpace,
    ) -> LayerInfoResponse {
        // Convert source pixels to ACEScct (the internal working space).
        to_acescct_f32(&mut pixels, &color_space);
        let texture_id = self.next_texture_id;
        self.next_texture_id += 1;
        self.stack = LayerStack::new();
        self.image_sources = Arc::new(std::collections::HashMap::from([(
            texture_id,
            FloatImage {
                pixels: pixels.into(),
                width,
                height,
            },
        )]));
        self.canvas_width = width;
        self.canvas_height = height;
        self.source_bit_depth = source_bit_depth.clone();
        self.current_image_hash = None;
        self.current_image_source = None;
        self.current_snapshot_id = None;
        self.stack.add_image_layer(texture_id, width, height);
        self.stack.add_adjustment_layer(vec![AdjustmentOp::Tone {
            exposure: 0.0,
            contrast: 0.0,
            blacks: 0.0,
            whites: 0.0,
            highlights: 0.0,
            shadows: 0.0,
            gamma: 1.0,
        }]);
        LayerInfoResponse {
            layer_count: self.stack.layers.len(),
            canvas_width: width,
            canvas_height: height,
            source_bit_depth,
            fingerprint: None,
        }
    }

    pub fn replace_with_linear_image(
        &mut self,
        pixels: Vec<f32>,
        width: u32,
        height: u32,
        source_bit_depth: String,
    ) -> LayerInfoResponse {
        let texture_id = self.next_texture_id;
        self.next_texture_id += 1;
        self.stack = LayerStack::new();
        self.image_sources = Arc::new(std::collections::HashMap::from([(
            texture_id,
            FloatImage {
                pixels: pixels.into(),
                width,
                height,
            },
        )]));
        self.canvas_width = width;
        self.canvas_height = height;
        self.source_bit_depth = source_bit_depth.clone();
        self.current_image_hash = None;
        self.current_image_source = None;
        self.current_snapshot_id = None;
        self.stack.add_image_layer(texture_id, width, height);
        self.stack.add_adjustment_layer(vec![AdjustmentOp::Tone {
            exposure: 0.0,
            contrast: 0.0,
            blacks: 0.0,
            whites: 0.0,
            highlights: 0.0,
            shadows: 0.0,
            gamma: 1.0,
        }]);
        LayerInfoResponse {
            layer_count: self.stack.layers.len(),
            canvas_width: width,
            canvas_height: height,
            source_bit_depth,
            fingerprint: None,
        }
    }
}
#[derive(Serialize, Deserialize, Debug)]
pub struct LayerInfoResponse {
    pub layer_count: usize,
    pub canvas_width: u32,
    pub canvas_height: u32,
    pub source_bit_depth: String,
    pub fingerprint: Option<String>,
}
pub(crate) fn snapshot_render_state(
    state: &tauri::State<'_, Mutex<EditorState>>,
) -> Result<
    (
        LayerStack,
        Arc<std::collections::HashMap<shade_lib::TextureId, FloatImage>>,
        u32,
        u32,
    ),
    String,
> {
    let st = lock_editor_state(state)?;
    if st.canvas_width == 0 {
        return Err("no image loaded".to_string());
    }
    Ok((
        st.stack.clone(),
        st.image_sources.clone(),
        st.canvas_width,
        st.canvas_height,
    ))
}
pub(crate) fn build_layer_stack_info(st: &EditorState) -> LayerStackInfo {
    // Build a single layout engine for all text layers in this snapshot pass.
    // cosmic-text/fontdb init dominates per-call cost (~ms), so amortizing it
    // matters when a document has several text layers.
    let has_text = st
        .stack
        .layers
        .iter()
        .any(|l| matches!(l.layer, shade_lib::Layer::Text { .. }));
    let mut layout_engine = if has_text {
        shade_lib::TextLayoutEngine::new(&st.stack.fonts).ok()
    } else {
        None
    };
    let layers = st
        .stack
        .layers
        .iter()
        .map(|l| LayerEntryInfo {
            kind: match &l.layer {
                shade_lib::Layer::Image { .. } => "image".into(),
                shade_lib::Layer::Crop { .. } => "crop".into(),
                shade_lib::Layer::Adjustment { .. } => "adjustment".into(),
                shade_lib::Layer::Text { .. } => "text".into(),
            },
            name: l.name.clone(),
            visible: l.visible,
            opacity: l.opacity,
            blend_mode: format!("{:?}", l.blend_mode),
            has_mask: l.mask.is_some(),
            mask_params: l
                .mask
                .and_then(|id| st.stack.mask_params.get(&id))
                .map(MaskParamsInfo::from),
            crop: match &l.layer {
                shade_lib::Layer::Crop { rect } => Some(CropValues {
                    x: rect.x,
                    y: rect.y,
                    width: rect.width,
                    height: rect.height,
                    rotation: rect.rotation,
                }),
                _ => None,
            },
            text: match &l.layer {
                shade_lib::Layer::Text {
                    content,
                    style,
                    transform,
                } => {
                    let bounds = layout_engine
                        .as_mut()
                        .and_then(|e| e.layout(content, style).ok())
                        .and_then(|placed| shade_lib::compute_text_aabb(&placed))
                        .map(|b| TextBoundsValues {
                            // Renderer applies only the translation component
                            // of the transform today; mirror that here so the
                            // bbox lines up with the rendered glyphs.
                            x: b.x + transform.tx,
                            y: b.y + transform.ty,
                            width: b.width,
                            height: b.height,
                        });
                    Some(TextLayerValues {
                        content: content.text.clone(),
                        style: TextStyleValues {
                            font_id: style.font_id,
                            size_px: style.size_px,
                            line_height: style.line_height,
                            letter_spacing: style.letter_spacing,
                            max_width: style.max_width,
                            align: text_align_str(style.align).into(),
                            anchor: text_anchor_str(style.anchor).into(),
                            weight: style.weight,
                            italic: style.italic,
                            color: style.color,
                        },
                        transform: TextTransformValues {
                            tx: transform.tx,
                            ty: transform.ty,
                            scale_x: transform.scale_x,
                            scale_y: transform.scale_y,
                            rotation: transform.rotation,
                        },
                        bounds,
                    })
                }
                _ => None,
            },
            adjustments: match &l.layer {
                shade_lib::Layer::Image { .. } => None,
                shade_lib::Layer::Crop { .. } => None,
                shade_lib::Layer::Text { .. } => None,
                shade_lib::Layer::Adjustment { ops } => {
                    let mut adjustments = AdjustmentValues::default();
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
                            } => {
                                adjustments.tone = Some(ToneValues {
                                    exposure: *exposure,
                                    contrast: *contrast,
                                    blacks: *blacks,
                                    whites: *whites,
                                    highlights: *highlights,
                                    shadows: *shadows,
                                    gamma: *gamma,
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
                                control_points,
                            } => {
                                adjustments.curves = Some(CurvesValues {
                                    lut_r: lut_r.clone(),
                                    lut_g: lut_g.clone(),
                                    lut_b: lut_b.clone(),
                                    lut_master: lut_master.clone(),
                                    per_channel: *per_channel,
                                    control_points: control_points.clone(),
                                });
                            }
                            AdjustmentOp::LsCurve {
                                lut,
                                control_points,
                            } => {
                                adjustments.ls_curve = Some(LsCurveValues {
                                    lut: lut.clone(),
                                    control_points: control_points.clone(),
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
                                    size: params.size,
                                });
                            }
                            AdjustmentOp::Glow(params) => {
                                adjustments.glow = Some(GlowValues {
                                    amount: params.amount,
                                });
                            }
                            AdjustmentOp::Hsl(params) => {
                                adjustments.hsl = Some(HslValues {
                                    red_hue: params.red_hue,
                                    red_sat: params.red_sat,
                                    red_lum: params.red_lum,
                                    green_hue: params.green_hue,
                                    green_sat: params.green_sat,
                                    green_lum: params.green_lum,
                                    blue_hue: params.blue_hue,
                                    blue_sat: params.blue_sat,
                                    blue_lum: params.blue_lum,
                                });
                            }
                            AdjustmentOp::Denoise(params) => {
                                adjustments.denoise = Some(DenoiseValues {
                                    luma_strength: params.luma_strength,
                                    chroma_strength: params.chroma_strength,
                                    mode: params.mode,
                                });
                            }
                        }
                    }
                    Some(adjustments)
                }
            },
        })
        .collect();
    LayerStackInfo {
        layers,
        canvas_width: st.canvas_width,
        canvas_height: st.canvas_height,
        generation: st.stack.generation,
    }
}
/// Build the current layer stack snapshot and push it over the coordination
/// channel. Called from every mutation site (centralised through
/// `finalize_layer_stack_mutation`).
pub(crate) async fn broadcast_layer_stack<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    state: &tauri::State<'_, Mutex<EditorState>>,
) {
    let info = match lock_editor_state(state) {
        Ok(st) => build_layer_stack_info(&st),
        Err(_) => return,
    };
    let value = match serde_json::to_value(&info) {
        Ok(v) => v,
        Err(_) => return,
    };
    crate::channel_server::channel_from_app(app)
        .send(crate::ChannelMessage::LayerStackSnapshot { stack: value })
        .await;
}
/// Persist the in-progress edit version AND broadcast the resulting stack
/// snapshot. Mutation commands should call this in place of
/// `persist_current_edit_version` so the frontend reactively learns about
/// the new state without needing to re-invoke `get_layer_stack`.
pub(crate) async fn finalize_layer_stack_mutation<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    state: &tauri::State<'_, Mutex<EditorState>>,
) -> Result<String, String> {
    let id = persist_current_edit_version(state).await?;
    broadcast_layer_stack(app, state).await;
    Ok(id)
}
