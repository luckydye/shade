//! Preview render scheduler — multi-artboard render queue + priority + cancellation.
//!
//! The frontend sends viewport state via `update_preview_viewports`. The
//! scheduler:
//!   * snapshots the editor state
//!   * builds a `PreviewRenderRequest` per artboard
//!   * dispatches a `ViewportPreview` `RenderJob` for each, priority-sorted
//!
//! Cancellation is best-effort: the existing render worker coalesces
//! consecutive preview-class jobs (newer supersedes older), so a fresh
//! viewport update naturally discards work that hasn't started yet. The
//! frontend's generation counter discards stale frames that finish anyway.

use crate::channel_protocol::{ArtboardViewport, PreviewQuality};
use crate::commands::{
    snapshot_render_state, EditorState, PreviewCrop, PreviewRenderRequest, RenderJob,
};
use std::sync::Mutex;

#[tauri::command]
pub async fn update_preview_viewports(
    generation: u64,
    quality: PreviewQuality,
    viewports: Vec<ArtboardViewport>,
    use_float16: Option<bool>,
    render_service: tauri::State<'_, crate::RenderService>,
    preview_channel: tauri::State<'_, crate::PreviewChannelService>,
    editor: tauri::State<'_, Mutex<EditorState>>,
) -> Result<(), String> {
    let mut sorted = viewports;
    sorted.sort_by_key(|v| v.priority);

    let (stack, sources, canvas_width, canvas_height) =
        match snapshot_render_state(&editor) {
            Ok(s) => s,
            Err(_) => return Ok(()), // no image loaded — nothing to render
        };
    let use_float16 = use_float16.unwrap_or(false);

    for viewport in sorted {
        let request = PreviewRenderRequest {
            target_width: viewport.target_width.max(1),
            target_height: viewport.target_height.max(1),
            crop: Some(PreviewCrop {
                x: viewport.crop.x as f32,
                y: viewport.crop.y as f32,
                width: viewport.crop.width as f32,
                height: viewport.crop.height as f32,
            }),
            ignore_crop_layers: Some(viewport.ignore_crop_layers),
        };
        // Apply ignore_crop_layers by hiding crop layers in the cloned stack
        // (the renderer itself does not honor the request flag — it only
        // walks `stack.layers` with `visible` set).
        let mut job_stack = stack.clone();
        if viewport.ignore_crop_layers {
            for entry in &mut job_stack.layers {
                if matches!(entry.layer, shade_lib::Layer::Crop { .. }) {
                    entry.visible = false;
                }
            }
        }
        let job = RenderJob::ViewportPreview {
            artboard_id: viewport.artboard_id,
            generation,
            quality,
            stack: job_stack,
            sources: sources.clone(),
            canvas_width,
            canvas_height,
            request,
            use_float16,
            preview_channel: preview_channel.0.clone(),
        };
        render_service
            .0
            .send(job)
            .map_err(|e| format!("render queue closed: {e}"))?;
    }
    Ok(())
}
