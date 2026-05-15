use serde::{Deserialize, Serialize};
use shade_lib::{
    FloatImage, LayerStack, PreviewCrop as GpuPreviewCrop, Renderer,
};
use std::sync::Arc;
use tauri::Manager;
use crate::editor_state::{build_persisted_layer_stack, texture_id_for_fingerprint};
use crate::image_loaders::{decode_image_bytes_with_info, load_camera_image_from_tauri, load_photo_image_from_tauri, load_s3_image_from_tauri, open_local_image_sync};
use crate::snapshots::{has_snapshot_for_source, load_latest_edit_version, load_latest_edit_version_by_source};


pub enum RenderJob {
    /// Push-based preview render. Result is pushed to the preview channel
    /// instead of returned via oneshot. Carries `artboard_id` + `generation`
    /// so the frontend can discard stale frames.
    ViewportPreview {
        artboard_id: String,
        generation: u64,
        quality: crate::channel_protocol::PreviewQuality,
        stack: LayerStack,
        sources: Arc<std::collections::HashMap<shade_lib::TextureId, FloatImage>>,
        canvas_width: u32,
        canvas_height: u32,
        request: PreviewRenderRequest,
        use_float16: bool,
        preview_channel: std::sync::Arc<crate::PreviewChannel>,
    },
    Export {
        stack: LayerStack,
        sources: Arc<std::collections::HashMap<shade_lib::TextureId, FloatImage>>,
        canvas_width: u32,
        canvas_height: u32,
        request: PreviewRenderRequest,
        response: tokio::sync::oneshot::Sender<Result<Vec<u8>, String>>,
    },
}
pub struct ThumbnailRenderJob {
    pub(crate) stack: LayerStack,
    pub(crate) sources: Arc<std::collections::HashMap<shade_lib::TextureId, FloatImage>>,
    pub(crate) canvas_width: u32,
    pub(crate) canvas_height: u32,
    pub(crate) request: PreviewRenderRequest,
    pub(crate) response: tokio::sync::oneshot::Sender<Result<Vec<u8>, String>>,
}
pub(crate) fn panic_to_string(payload: Box<dyn std::any::Any + Send>) -> String {
    if let Some(s) = payload.downcast_ref::<&str>() {
        return (*s).to_string();
    }
    if let Some(s) = payload.downcast_ref::<String>() {
        return s.clone();
    }
    "render worker panic".to_string()
}
pub fn spawn_render_worker() -> crossbeam_channel::Sender<RenderJob> {
    let (sender, receiver) = crossbeam_channel::unbounded::<RenderJob>();
    std::thread::Builder::new()
        .name("shade-render".into())
        .spawn(move || {
            let runtime = match tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
            {
                Ok(r) => r,
                Err(e) => {
                    eprintln!("render worker: failed to create runtime: {e}");
                    return;
                }
            };
            let renderer = match runtime.block_on(Renderer::new()) {
                Ok(r) => r,
                Err(e) => {
                    eprintln!("render worker: Renderer::new() failed: {e}");
                    return;
                }
            };
            eprintln!("render worker: ready");
            let mut deferred_job = None;
            loop {
                let mut job = match deferred_job.take() {
                    Some(job) => job,
                    None => match receiver.recv() {
                        Ok(job) => job,
                        Err(_) => break,
                    },
                };
                if matches!(job, RenderJob::ViewportPreview { .. }) {
                    loop {
                        match receiver.try_recv() {
                            Ok(next_job) => match next_job {
                                RenderJob::ViewportPreview { .. } => {
                                    job = next_job;
                                }
                                _ => {
                                    deferred_job = Some(next_job);
                                    break;
                                }
                            },
                            Err(crossbeam_channel::TryRecvError::Empty) => break,
                            Err(crossbeam_channel::TryRecvError::Disconnected) => break,
                        }
                    }
                }
                match job {
                    RenderJob::ViewportPreview {
                        artboard_id,
                        generation,
                        quality,
                        stack,
                        sources,
                        canvas_width,
                        canvas_height,
                        request,
                        use_float16,
                        preview_channel,
                    } => {
                        let crop = request.crop.clone().map(|c| GpuPreviewCrop {
                            x: c.x,
                            y: c.y,
                            width: c.width,
                            height: c.height,
                        });
                        let crop_rect = request.crop.clone();
                        let target_w = request.target_width;
                        let target_h = request.target_height;
                        let frame_result = if use_float16 {
                            std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                                runtime
                                    .block_on(renderer.render_stack_preview_f16(
                                        &stack,
                                        sources.as_ref(),
                                        canvas_width,
                                        canvas_height,
                                        target_w,
                                        target_h,
                                        crop,
                                    ))
                                    .map(|pixels: Vec<u16>| {
                                        let mut bytes =
                                            Vec::with_capacity(pixels.len() * 2);
                                        for word in pixels {
                                            bytes.extend_from_slice(&word.to_le_bytes());
                                        }
                                        bytes
                                    })
                                    .map_err(|e| e.to_string())
                            }))
                            .unwrap_or_else(|e| Err(panic_to_string(e)))
                        } else {
                            std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                                runtime
                                    .block_on(renderer.render_stack_preview(
                                        &stack,
                                        sources.as_ref(),
                                        canvas_width,
                                        canvas_height,
                                        target_w,
                                        target_h,
                                        crop,
                                    ))
                                    .map_err(|e| e.to_string())
                            }))
                            .unwrap_or_else(|e| Err(panic_to_string(e)))
                        };
                        match frame_result {
                            Ok(pixels) => {
                                let (crop_x, crop_y, crop_w, crop_h) = crop_rect
                                    .as_ref()
                                    .map(|c| {
                                        (
                                            c.x as f64,
                                            c.y as f64,
                                            c.width as f64,
                                            c.height as f64,
                                        )
                                    })
                                    .unwrap_or((
                                        0.0,
                                        0.0,
                                        canvas_width as f64,
                                        canvas_height as f64,
                                    ));
                                let frame = crate::preview_channel::PreviewFrame {
                                    artboard_id,
                                    generation,
                                    quality,
                                    width: target_w,
                                    height: target_h,
                                    crop_x,
                                    crop_y,
                                    crop_width: crop_w,
                                    crop_height: crop_h,
                                    kind: if use_float16 {
                                        crate::preview_channel::PreviewFrameKind::RgbaFloat16
                                    } else {
                                        crate::preview_channel::PreviewFrameKind::Rgba
                                    },
                                    color_space: if use_float16 {
                                        crate::preview_channel::PreviewColorSpace::DisplayP3
                                    } else {
                                        crate::preview_channel::PreviewColorSpace::Srgb
                                    },
                                    pixels,
                                };
                                runtime.block_on(preview_channel.send(frame));
                            }
                            Err(error) => {
                                eprintln!(
                                    "viewport preview render failed: {error}"
                                );
                            }
                        }
                    }
                    RenderJob::Export {
                        stack,
                        sources,
                        canvas_width,
                        canvas_height,
                        request,
                        response,
                    } => {
                        let result = std::panic::catch_unwind(
                            std::panic::AssertUnwindSafe(|| {
                                runtime
                                    .block_on(renderer.render_stack_preview(
                                        &stack,
                                        sources.as_ref(),
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
                                    ))
                                    .map_err(|e| e.to_string())
                            }),
                        )
                        .unwrap_or_else(|e| Err(panic_to_string(e)));
                        let _ = response.send(result);
                    }
                }
            }
        })
        .expect("failed to spawn render worker thread");
    sender
}
pub fn spawn_thumbnail_render_worker() -> crossbeam_channel::Sender<ThumbnailRenderJob> {
    let (sender, receiver) = crossbeam_channel::unbounded::<ThumbnailRenderJob>();
    std::thread::Builder::new()
        .name("shade-thumbnail-render".into())
        .spawn(move || {
            let runtime = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .expect("failed to create thumbnail render runtime");
            let renderer = runtime.block_on(Renderer::new()).map_err(|e| e.to_string());
            while let Ok(job) = receiver.recv() {
                let result = match &renderer {
                    Ok(renderer) => {
                        std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                            runtime
                                .block_on(renderer.render_stack_preview(
                                    &job.stack,
                                    job.sources.as_ref(),
                                    job.canvas_width,
                                    job.canvas_height,
                                    job.request.target_width,
                                    job.request.target_height,
                                    job.request.crop.map(|crop| GpuPreviewCrop {
                                        x: crop.x,
                                        y: crop.y,
                                        width: crop.width,
                                        height: crop.height,
                                    }),
                                ))
                                .map_err(|e| e.to_string())
                                .and_then(|pixels| {
                                    encode_jpeg_thumbnail(
                                        pixels,
                                        job.request.target_width,
                                        job.request.target_height,
                                    )
                                })
                        }))
                        .unwrap_or_else(|e| Err(panic_to_string(e)))
                    }
                    Err(error) => Err(error.clone()),
                };
                let _ = job.response.send(result);
                if let Ok(renderer) = &renderer {
                    renderer.clear_image_cache();
                }
            }
        })
        .expect("failed to spawn thumbnail render worker thread");
    sender
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
    pub ignore_crop_layers: Option<bool>,
}
pub(crate) fn export_dimension(value: f32, axis: &str) -> Result<u32, String> {
    if !value.is_finite() {
        return Err(format!("crop {axis} must be finite"));
    }
    let rounded = value.round();
    if rounded < 1.0 || rounded > u32::MAX as f32 {
        return Err(format!("crop {axis} is out of range"));
    }
    Ok(rounded as u32)
}
pub(crate) fn export_render_request(
    stack: &LayerStack,
    canvas_width: u32,
    canvas_height: u32,
) -> Result<PreviewRenderRequest, String> {
    let crop = stack.layers.iter().find_map(|entry| {
        if !entry.visible {
            return None;
        }
        let shade_lib::Layer::Crop { rect } = &entry.layer else {
            return None;
        };
        Some(PreviewCrop {
            x: rect.x,
            y: rect.y,
            width: rect.width,
            height: rect.height,
        })
    });
    let target_width = match &crop {
        Some(crop) => export_dimension(crop.width, "width")?,
        None => canvas_width,
    };
    let target_height = match &crop {
        Some(crop) => export_dimension(crop.height, "height")?,
        None => canvas_height,
    };
    Ok(PreviewRenderRequest {
        target_width,
        target_height,
        crop,
        ignore_crop_layers: None,
    })
}
pub(crate) fn thumbnail_render_request(
    stack: &LayerStack,
    canvas_width: u32,
    canvas_height: u32,
) -> Result<PreviewRenderRequest, String> {
    let request = export_render_request(stack, canvas_width, canvas_height)?;
    let longest_edge = request.target_width.max(request.target_height);
    if longest_edge <= 320 {
        return Ok(request);
    }
    Ok(PreviewRenderRequest {
        target_width: std::cmp::max(
            1,
            ((request.target_width as f64 * 320.0) / longest_edge as f64).round() as u32,
        ),
        target_height: std::cmp::max(
            1,
            ((request.target_height as f64 * 320.0) / longest_edge as f64).round() as u32,
        ),
        crop: request.crop,
        ignore_crop_layers: request.ignore_crop_layers,
    })
}
pub(crate) fn encode_jpeg_thumbnail(
    pixels: Vec<u8>,
    width: u32,
    height: u32,
) -> Result<Vec<u8>, String> {
    let image = image::RgbaImage::from_raw(width, height, pixels)
        .ok_or("failed to wrap rendered thumbnail pixels")?;
    let mut jpeg = Vec::new();
    image::DynamicImage::ImageRgba8(image)
        .write_to(
            &mut std::io::Cursor::new(&mut jpeg),
            image::ImageFormat::Jpeg,
        )
        .map_err(|error| error.to_string())?;
    Ok(jpeg)
}
pub(crate) async fn render_snapshot_thumbnail_bytes<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    picture_id: &str,
) -> Result<Option<(Vec<u8>, String)>, String> {
    if !has_snapshot_for_source(picture_id).await? {
        return Ok(None);
    }
    let semaphore = app
        .state::<crate::ThumbnailService>()
        .decode_semaphore
        .clone();
    let _permit = semaphore.acquire().await.map_err(|e| e.to_string())?;
    let photo_app = app.clone();
    let is_local = !picture_id.starts_with("ccapi://") && !picture_id.starts_with("s3://");
    let opened = if is_local {
        let photo_bytes = {
            let app = photo_app.clone();
            load_photo_image_from_tauri(&app, picture_id).await?
        };
        if let Some(bytes) = photo_bytes {
            let picture_id_owned = picture_id.to_string();
            tokio::task::spawn_blocking(move || -> Result<shade_io::OpenedImage, String> {
                let fingerprint = shade_io::fingerprint_from_bytes(&bytes).to_hex();
                let (image, info) = decode_image_bytes_with_info(&bytes, Some(&picture_id_owned))?;
                Ok(shade_io::OpenedImage {
                    fingerprint,
                    source_name: Some(picture_id_owned),
                    image,
                    info,
                })
            })
            .await
            .map_err(|e| e.to_string())??
        } else {
            let picture_id = picture_id.to_string();
            tokio::task::spawn_blocking(move || open_local_image_sync(&picture_id))
                .await
                .map_err(|e| e.to_string())??
        }
    } else {
        shade_io::open_image(
            picture_id,
            |host, file_path| async move {
                load_camera_image_from_tauri(&host, &file_path).await
            },
            |s3_path| async move { load_s3_image_from_tauri(&s3_path).await },
            move |photo_id| {
                let app = photo_app.clone();
                async move { load_photo_image_from_tauri(&app, &photo_id).await }
            },
        )
        .await?
    };
    let persisted = match load_latest_edit_version(&opened.fingerprint).await? {
        Some(p) => p,
        None => match load_latest_edit_version_by_source(picture_id).await? {
            Some(p) => p,
            None => return Ok(None),
        },
    };
    let image = FloatImage {
        pixels: opened.image.pixels.clone(),
        width: opened.image.width,
        height: opened.image.height,
    };
    let texture_id = texture_id_for_fingerprint(&opened.fingerprint)?;
    let canvas_width = image.width;
    let canvas_height = image.height;
    let stack =
        build_persisted_layer_stack(texture_id, canvas_width, canvas_height, &persisted)?;
    let request = thumbnail_render_request(&stack, canvas_width, canvas_height)?;
    let sources = Arc::new(std::collections::HashMap::from([(texture_id, image)]));
    let render_sender = app.state::<crate::ThumbnailService>().render_sender.clone();
    let (response_tx, response_rx) = tokio::sync::oneshot::channel();
    render_sender
        .send(ThumbnailRenderJob {
            stack,
            sources,
            canvas_width,
            canvas_height,
            request,
            response: response_tx,
        })
        .map_err(|e| e.to_string())?;
    let bytes = response_rx.await.map_err(|error| error.to_string())??;
    Ok(Some((bytes, opened.fingerprint)))
}

#[cfg(test)]
mod tests {
    use super::export_render_request;
    use shade_lib::{CropRect, LayerStack};

    #[test]
    fn export_render_request_uses_canvas_when_crop_is_absent() {
        let mut stack = LayerStack::new();
        stack.add_adjustment_layer(vec![]);
        let request = export_render_request(&stack, 400, 300).expect("export request");
        assert_eq!(request.target_width, 400);
        assert_eq!(request.target_height, 300);
        assert!(request.crop.is_none());
    }

    #[test]
    fn export_render_request_uses_visible_crop_dimensions() {
        let mut stack = LayerStack::new();
        stack.add_crop_layer(CropRect {
            x: 10.0,
            y: 20.0,
            width: 123.0,
            height: 77.0,
            rotation: 0.25,
        });
        let request = export_render_request(&stack, 400, 300).expect("export request");
        let crop = request.crop.expect("crop request");
        assert_eq!(request.target_width, 123);
        assert_eq!(request.target_height, 77);
        assert_eq!(crop.x, 10.0);
        assert_eq!(crop.y, 20.0);
        assert_eq!(crop.width, 123.0);
        assert_eq!(crop.height, 77.0);
    }
}
