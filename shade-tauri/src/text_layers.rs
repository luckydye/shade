use crate::editor_state::{
    finalize_layer_stack_mutation, lock_editor_state, EditorState,
};
use serde::{Deserialize, Serialize};
use std::sync::Mutex;

#[derive(Serialize, Deserialize, Debug)]
pub struct AddTextLayerParams {
    pub content: String,
    pub font_id: u64,
    pub size_px: f32,
}
pub async fn add_text_layer<R: tauri::Runtime>(
    params: AddTextLayerParams,
    state: tauri::State<'_, Mutex<EditorState>>,
    app: tauri::AppHandle<R>,
) -> Result<usize, String> {
    let idx = {
        let mut st = lock_editor_state(&state)?;
        // If the caller passed a font id that isn't registered (e.g. the UI
        // placeholder `0` when the user hasn't uploaded a font yet), lazily
        // register the bundled default so the layer renders something.
        let font_id = if st.stack.fonts.contains_key(&params.font_id) {
            params.font_id
        } else {
            st.stack.ensure_default_font()
        };
        let mut style = shade_lib::TextStyle::new(font_id, params.size_px);
        style.color = [1.0, 1.0, 1.0, 1.0];
        st.stack
            .add_text_layer(shade_lib::TextContent::new(params.content), style)
    };
    finalize_layer_stack_mutation(&app, &state).await?;
    Ok(idx)
}
#[derive(Serialize, Deserialize, Debug)]
pub struct UpdateTextContentParams {
    pub layer_idx: usize,
    pub content: String,
}
pub async fn update_text_content<R: tauri::Runtime>(
    params: UpdateTextContentParams,
    state: tauri::State<'_, Mutex<EditorState>>,
    app: tauri::AppHandle<R>,
) -> Result<(), String> {
    {
        let mut st = lock_editor_state(&state)?;
        let entry = st
            .stack
            .layers
            .get_mut(params.layer_idx)
            .ok_or_else(|| "layer index out of bounds".to_string())?;
        let shade_lib::Layer::Text { content, .. } = &mut entry.layer else {
            return Err("target layer is not a text layer".into());
        };
        *content = shade_lib::TextContent::new(params.content);
        st.stack.generation += 1;
    }
    finalize_layer_stack_mutation(&app, &state).await?;
    Ok(())
}
#[derive(Serialize, Deserialize, Debug, Default)]
pub struct UpdateTextStyleParams {
    pub layer_idx: usize,
    #[serde(default)]
    pub font_id: Option<u64>,
    #[serde(default)]
    pub size_px: Option<f32>,
    #[serde(default)]
    pub line_height: Option<f32>,
    #[serde(default)]
    pub letter_spacing: Option<f32>,
    /// `None` = leave; serde default omits the field. To clear `max_width`,
    /// the JS client passes `max_width: null` which becomes `Some(None)`.
    #[serde(default, deserialize_with = "deser_double_option_f32")]
    pub max_width: Option<Option<f32>>,
    #[serde(default)]
    pub align: Option<String>,
    #[serde(default)]
    pub anchor: Option<String>,
    #[serde(default)]
    pub weight: Option<u16>,
    #[serde(default)]
    pub italic: Option<bool>,
    #[serde(default)]
    pub color: Option<[f32; 4]>,
}
pub(crate) fn deser_double_option_f32<'de, D>(
    d: D,
) -> Result<Option<Option<f32>>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    Option::<f32>::deserialize(d).map(Some)
}
pub(crate) fn parse_text_align(s: &str) -> Result<shade_lib::TextAlign, String> {
    Ok(match s {
        "left" => shade_lib::TextAlign::Left,
        "center" => shade_lib::TextAlign::Center,
        "right" => shade_lib::TextAlign::Right,
        "justify" => shade_lib::TextAlign::Justify,
        other => return Err(format!("unknown text align: {other}")),
    })
}
pub(crate) fn parse_text_anchor(s: &str) -> Result<shade_lib::TextAnchor, String> {
    Ok(match s {
        "top-left" => shade_lib::TextAnchor::TopLeft,
        "top-center" => shade_lib::TextAnchor::TopCenter,
        "top-right" => shade_lib::TextAnchor::TopRight,
        "center-left" => shade_lib::TextAnchor::CenterLeft,
        "center" => shade_lib::TextAnchor::Center,
        "center-right" => shade_lib::TextAnchor::CenterRight,
        "bottom-left" => shade_lib::TextAnchor::BottomLeft,
        "bottom-center" => shade_lib::TextAnchor::BottomCenter,
        "bottom-right" => shade_lib::TextAnchor::BottomRight,
        "baseline-left" => shade_lib::TextAnchor::BaselineLeft,
        "baseline-center" => shade_lib::TextAnchor::BaselineCenter,
        "baseline-right" => shade_lib::TextAnchor::BaselineRight,
        other => return Err(format!("unknown text anchor: {other}")),
    })
}
pub async fn update_text_style<R: tauri::Runtime>(
    params: UpdateTextStyleParams,
    state: tauri::State<'_, Mutex<EditorState>>,
    app: tauri::AppHandle<R>,
) -> Result<(), String> {
    {
        let mut st = lock_editor_state(&state)?;
        let entry = st
            .stack
            .layers
            .get_mut(params.layer_idx)
            .ok_or_else(|| "layer index out of bounds".to_string())?;
        let shade_lib::Layer::Text { style, .. } = &mut entry.layer else {
            return Err("target layer is not a text layer".into());
        };
        if let Some(v) = params.font_id {
            style.font_id = v;
        }
        if let Some(v) = params.size_px {
            style.size_px = v;
        }
        if let Some(v) = params.line_height {
            style.line_height = v;
        }
        if let Some(v) = params.letter_spacing {
            style.letter_spacing = v;
        }
        if let Some(v) = params.max_width {
            style.max_width = v;
        }
        if let Some(v) = params.align.as_deref() {
            style.align = parse_text_align(v)?;
        }
        if let Some(v) = params.anchor.as_deref() {
            style.anchor = parse_text_anchor(v)?;
        }
        if let Some(v) = params.weight {
            style.weight = v;
        }
        if let Some(v) = params.italic {
            style.italic = v;
        }
        if let Some(v) = params.color {
            style.color = v;
        }
        st.stack.generation += 1;
    }
    finalize_layer_stack_mutation(&app, &state).await?;
    Ok(())
}
#[derive(Serialize, Deserialize, Debug)]
pub struct SetTextTransformParams {
    pub layer_idx: usize,
    pub tx: f32,
    pub ty: f32,
    pub scale_x: f32,
    pub scale_y: f32,
    pub rotation: f32,
}
pub async fn set_text_transform<R: tauri::Runtime>(
    params: SetTextTransformParams,
    state: tauri::State<'_, Mutex<EditorState>>,
    app: tauri::AppHandle<R>,
) -> Result<(), String> {
    {
        let mut st = lock_editor_state(&state)?;
        let entry = st
            .stack
            .layers
            .get_mut(params.layer_idx)
            .ok_or_else(|| "layer index out of bounds".to_string())?;
        let shade_lib::Layer::Text { transform, .. } = &mut entry.layer else {
            return Err("target layer is not a text layer".into());
        };
        transform.tx = params.tx;
        transform.ty = params.ty;
        transform.scale_x = params.scale_x;
        transform.scale_y = params.scale_y;
        transform.rotation = params.rotation;
        st.stack.generation += 1;
    }
    finalize_layer_stack_mutation(&app, &state).await?;
    Ok(())
}
#[derive(Serialize, Deserialize, Debug)]
pub struct AddFontParams {
    pub family: String,
    /// Raw OTF/TTF/TTC bytes.
    pub bytes: Vec<u8>,
}
pub async fn add_font<R: tauri::Runtime>(
    params: AddFontParams,
    state: tauri::State<'_, Mutex<EditorState>>,
    app: tauri::AppHandle<R>,
) -> Result<u64, String> {
    let id = {
        let mut st = lock_editor_state(&state)?;
        st.stack.add_font(params.family, params.bytes)
    };
    finalize_layer_stack_mutation(&app, &state).await?;
    Ok(id)
}
#[derive(Serialize, Deserialize, Debug)]
pub struct FontInfo {
    pub font_id: u64,
    pub family: String,
    pub blob_hash: String,
}
pub fn list_fonts(
    state: tauri::State<'_, Mutex<EditorState>>,
) -> Result<Vec<FontInfo>, String> {
    let st = lock_editor_state(&state)?;
    let mut out: Vec<FontInfo> = st
        .stack
        .fonts
        .iter()
        .map(|(id, e)| FontInfo {
            font_id: *id,
            family: e.family.clone(),
            blob_hash: e.blob_hash.to_string(),
        })
        .collect();
    out.sort_by_key(|f| f.font_id);
    Ok(out)
}
pub async fn prune_unused_fonts<R: tauri::Runtime>(
    state: tauri::State<'_, Mutex<EditorState>>,
    app: tauri::AppHandle<R>,
) -> Result<usize, String> {
    let removed = {
        let mut st = lock_editor_state(&state)?;
        st.stack.remove_unused_fonts()
    };
    if removed > 0 {
        finalize_layer_stack_mutation(&app, &state).await?;
    }
    Ok(removed)
}
#[derive(Serialize, Deserialize, Debug)]
pub struct TextLayerValues {
    pub content: String,
    pub style: TextStyleValues,
    pub transform: TextTransformValues,
    /// Layout-derived AABB in canvas pixels, with the layer's translation
    /// already applied. `None` when the layer is empty or no font is
    /// registered. Used by the viewport for hit-testing and selection chrome.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bounds: Option<TextBoundsValues>,
}
#[derive(Serialize, Deserialize, Debug, Clone, Copy)]
pub struct TextBoundsValues {
    pub x: f32,
    pub y: f32,
    pub width: f32,
    pub height: f32,
}
#[derive(Serialize, Deserialize, Debug)]
pub struct TextStyleValues {
    pub font_id: u64,
    pub size_px: f32,
    pub line_height: f32,
    pub letter_spacing: f32,
    pub max_width: Option<f32>,
    pub align: String,
    pub anchor: String,
    pub weight: u16,
    pub italic: bool,
    pub color: [f32; 4],
}
#[derive(Serialize, Deserialize, Debug)]
pub struct TextTransformValues {
    pub tx: f32,
    pub ty: f32,
    pub scale_x: f32,
    pub scale_y: f32,
    pub rotation: f32,
}
pub(crate) fn text_align_str(a: shade_lib::TextAlign) -> &'static str {
    match a {
        shade_lib::TextAlign::Left => "left",
        shade_lib::TextAlign::Center => "center",
        shade_lib::TextAlign::Right => "right",
        shade_lib::TextAlign::Justify => "justify",
    }
}
pub(crate) fn text_anchor_str(a: shade_lib::TextAnchor) -> &'static str {
    match a {
        shade_lib::TextAnchor::TopLeft => "top-left",
        shade_lib::TextAnchor::TopCenter => "top-center",
        shade_lib::TextAnchor::TopRight => "top-right",
        shade_lib::TextAnchor::CenterLeft => "center-left",
        shade_lib::TextAnchor::Center => "center",
        shade_lib::TextAnchor::CenterRight => "center-right",
        shade_lib::TextAnchor::BottomLeft => "bottom-left",
        shade_lib::TextAnchor::BottomCenter => "bottom-center",
        shade_lib::TextAnchor::BottomRight => "bottom-right",
        shade_lib::TextAnchor::BaselineLeft => "baseline-left",
        shade_lib::TextAnchor::BaselineCenter => "baseline-center",
        shade_lib::TextAnchor::BaselineRight => "baseline-right",
    }
}
