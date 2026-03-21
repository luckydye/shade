/// End-to-end test that replicates the frontend viewport pipeline (editor-preview.ts)
/// in Rust, then renders through the full GPU pipeline and saves PNGs.
///
/// Run with:  cargo test -p shade-gpu --test crop_rotation_e2e -- --nocapture
///
/// Produces PNGs in /tmp/shade_e2e_*.png for visual inspection.
use shade_core::{CropRect, FloatImage, LayerStack};
use shade_gpu::{PreviewCrop, Renderer};
use std::collections::HashMap;
use std::path::Path;

// ---------------------------------------------------------------------------
// Frontend viewport logic (ported from ui/src/store/editor-preview.ts)
// ---------------------------------------------------------------------------

fn clamp(value: f64, min: f64, max: f64) -> f64 {
    value.min(max).max(min)
}

/// Equivalent to `getPreviewBounds()` when NOT editing the crop layer.
/// Returns the committed crop rect's axis-aligned bounds (ignoring rotation).
struct Bounds {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

/// Equivalent to `fitPreviewSize()`.
fn fit_preview_size(
    container_w: f64,
    container_h: f64,
    image_w: f64,
    image_h: f64,
) -> (f64, f64) {
    let scale = (container_w / image_w).min(container_h / image_h);
    (
        (image_w * scale).floor().max(1.0),
        (image_h * scale).floor().max(1.0),
    )
}

/// Replicates `getVisiblePreview(zoom, centerX, centerY)`.
struct VisiblePreview {
    screen_width: f64,
    screen_height: f64,
    crop: PreviewCrop,
}

fn get_visible_preview(
    bounds: &Bounds,
    viewport_w: f64,
    viewport_h: f64,
    zoom: f64,
    center_x: f64,
    center_y: f64,
) -> VisiblePreview {
    let fit_scale = (viewport_w / bounds.width).min(viewport_h / bounds.height);
    let image_scale = fit_scale * zoom;

    // clampPreviewCenter
    let crop_w = bounds.width.min(viewport_w / image_scale);
    let crop_h = bounds.height.min(viewport_h / image_scale);
    let cx = clamp(
        center_x,
        bounds.x + crop_w * 0.5,
        bounds.x + bounds.width - crop_w * 0.5,
    );
    let cy = clamp(
        center_y,
        bounds.y + crop_h * 0.5,
        bounds.y + bounds.height - crop_h * 0.5,
    );

    let image_x = viewport_w * 0.5 - (cx - bounds.x) * image_scale;
    let image_y = viewport_h * 0.5 - (cy - bounds.y) * image_scale;
    let screen_left = 0.0_f64.max(image_x);
    let screen_top = 0.0_f64.max(image_y);
    let screen_right = viewport_w.min(image_x + bounds.width * image_scale);
    let screen_bottom = viewport_h.min(image_y + bounds.height * image_scale);

    VisiblePreview {
        screen_width: screen_right - screen_left,
        screen_height: screen_bottom - screen_top,
        crop: PreviewCrop {
            x: (bounds.x as f64 + (screen_left - image_x) / image_scale) as f32,
            y: (bounds.y as f64 + (screen_top - image_y) / image_scale) as f32,
            width: ((screen_right - screen_left) / image_scale) as f32,
            height: ((screen_bottom - screen_top) / image_scale) as f32,
        },
    }
}

/// Replicates `getPreviewRequest("final")` — computes target size and crop for a
/// given zoom level, viewport container size, and crop bounds.
fn preview_request(
    bounds: &Bounds,
    viewport_w: f64,
    viewport_h: f64,
    zoom: f64,
    center_x: f64,
    center_y: f64,
    device_pixel_ratio: f64,
) -> (u32, u32, PreviewCrop) {
    let visible =
        get_visible_preview(bounds, viewport_w, viewport_h, zoom, center_x, center_y);
    let tw = (visible.screen_width * device_pixel_ratio).round().max(1.0) as u32;
    let th = (visible.screen_height * device_pixel_ratio)
        .round()
        .max(1.0) as u32;
    (tw, th, visible.crop)
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

async fn renderer_or_skip() -> Option<Renderer> {
    match Renderer::new().await {
        Ok(r) => Some(r),
        Err(e) if e.to_string().contains("No suitable wgpu adapter") => {
            eprintln!("SKIP: {e}");
            None
        }
        Err(e) => panic!("renderer init failed: {e}"),
    }
}

fn save_png(pixels: &[u8], width: u32, height: u32, path: &str) {
    let img = image::RgbaImage::from_raw(width, height, pixels.to_vec())
        .expect("pixel buffer size must match dimensions");
    img.save(path).expect("failed to write PNG");
    eprintln!("  saved: {path}  ({width}×{height})");
}

/// 400×300 (4:3) test image with gradient + checkerboard.
fn make_4x3_image() -> (FloatImage, u32, u32) {
    let (w, h) = (400u32, 300u32);
    let mut pixels = Vec::with_capacity((w * h * 4) as usize);
    for row in 0..h {
        for col in 0..w {
            let r = col as f32 / w as f32;
            let g = row as f32 / h as f32;
            let b = if (col / 40 + row / 40) % 2 == 0 {
                0.8
            } else {
                0.2
            };
            pixels.push(r);
            pixels.push(g);
            pixels.push(b);
            pixels.push(1.0);
        }
    }
    (
        FloatImage {
            width: w,
            height: h,
            pixels: pixels.into(),
        },
        w,
        h,
    )
}

fn load_fixture() -> Option<(FloatImage, u32, u32)> {
    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../test/fixtures/IMG_20260310_115134692.jpg");
    if !path.exists() {
        eprintln!("fixture not found: {}", path.display());
        return None;
    }
    let img = shade_io::load_image_f32(&path).expect("failed to load fixture");
    let (w, h) = (img.width, img.height);
    Some((img, w, h))
}

async fn render_with_frontend_viewport(
    renderer: &Renderer,
    image: &FloatImage,
    canvas_w: u32,
    canvas_h: u32,
    crop_rect: Option<CropRect>,
    viewport_w: f64,
    viewport_h: f64,
    zoom: f64,
    label: &str,
    out_path: &str,
) {
    // Compute bounds = crop rect (or full canvas if no crop).
    let bounds = match &crop_rect {
        Some(c) => Bounds {
            x: c.x as f64,
            y: c.y as f64,
            width: c.width as f64,
            height: c.height as f64,
        },
        None => Bounds {
            x: 0.0,
            y: 0.0,
            width: canvas_w as f64,
            height: canvas_h as f64,
        },
    };

    // Center on the crop rect center.
    let center_x = bounds.x + bounds.width * 0.5;
    let center_y = bounds.y + bounds.height * 0.5;

    let (tw, th, viewport_crop) = preview_request(
        &bounds, viewport_w, viewport_h, zoom, center_x, center_y, 1.0,
    );

    eprintln!(
        "[{label}]  viewport={viewport_w}×{viewport_h}, zoom={zoom:.0}%, \
         target={tw}×{th}, crop=({:.1},{:.1},{:.1},{:.1})",
        viewport_crop.x, viewport_crop.y, viewport_crop.width, viewport_crop.height,
    );

    let mut stack = LayerStack::new();
    stack.add_image_layer(1, canvas_w, canvas_h);
    if let Some(rect) = crop_rect {
        stack.add_crop_layer(rect);
    }

    let mut sources = HashMap::new();
    sources.insert(1, image.clone());

    let pixels = renderer
        .render_stack_preview(
            &stack,
            &sources,
            canvas_w,
            canvas_h,
            tw,
            th,
            Some(viewport_crop),
        )
        .await
        .expect("render failed");

    save_png(&pixels, tw, th, out_path);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

/// 4:3 image (400×300), square 500×500 viewport, crop with 15° rotation.
/// Renders at zoom=100% and zoom=200% and saves PNGs.
#[tokio::test]
async fn frontend_viewport_zoom_synthetic() {
    let Some(renderer) = renderer_or_skip().await else {
        return;
    };

    let (image, w, h) = make_4x3_image(); // 400×300

    // Full-canvas crop with 15° rotation.
    let crop = CropRect {
        x: 0.0,
        y: 0.0,
        width: w as f32,
        height: h as f32,
        rotation: 15.0f32.to_radians(),
    };

    // --- No crop layer (baseline) ---
    render_with_frontend_viewport(
        &renderer,
        &image,
        w,
        h,
        None,
        500.0,
        500.0,
        1.0,
        "no crop, zoom=100%",
        "/tmp/shade_e2e_v2_no_crop_z100.png",
    )
    .await;
    render_with_frontend_viewport(
        &renderer,
        &image,
        w,
        h,
        None,
        500.0,
        500.0,
        2.0,
        "no crop, zoom=200%",
        "/tmp/shade_e2e_v2_no_crop_z200.png",
    )
    .await;

    // --- Crop (no rotation) at zoom ---
    let crop_norot = CropRect {
        x: 0.0,
        y: 0.0,
        width: w as f32,
        height: h as f32,
        rotation: 0.0,
    };
    render_with_frontend_viewport(
        &renderer,
        &image,
        w,
        h,
        Some(crop_norot.clone()),
        500.0,
        500.0,
        1.0,
        "crop norot, zoom=100%",
        "/tmp/shade_e2e_v2_crop_norot_z100.png",
    )
    .await;
    render_with_frontend_viewport(
        &renderer,
        &image,
        w,
        h,
        Some(crop_norot.clone()),
        500.0,
        500.0,
        2.0,
        "crop norot, zoom=200%",
        "/tmp/shade_e2e_v2_crop_norot_z200.png",
    )
    .await;

    // --- Crop with 15° rotation at zoom ---
    render_with_frontend_viewport(
        &renderer,
        &image,
        w,
        h,
        Some(crop.clone()),
        500.0,
        500.0,
        1.0,
        "crop rot=15°, zoom=100%",
        "/tmp/shade_e2e_v2_crop_rot15_z100.png",
    )
    .await;
    render_with_frontend_viewport(
        &renderer,
        &image,
        w,
        h,
        Some(crop.clone()),
        500.0,
        500.0,
        2.0,
        "crop rot=15°, zoom=200%",
        "/tmp/shade_e2e_v2_crop_rot15_z200.png",
    )
    .await;
    render_with_frontend_viewport(
        &renderer,
        &image,
        w,
        h,
        Some(crop.clone()),
        500.0,
        500.0,
        4.0,
        "crop rot=15°, zoom=400%",
        "/tmp/shade_e2e_v2_crop_rot15_z400.png",
    )
    .await;

    // --- Smaller crop rect (center 60%) with rotation ---
    let small_crop = CropRect {
        x: w as f32 * 0.2,
        y: h as f32 * 0.2,
        width: w as f32 * 0.6,
        height: h as f32 * 0.6,
        rotation: 10.0f32.to_radians(),
    };
    render_with_frontend_viewport(
        &renderer,
        &image,
        w,
        h,
        Some(small_crop.clone()),
        500.0,
        500.0,
        1.0,
        "small crop rot=10°, zoom=100%",
        "/tmp/shade_e2e_v2_small_rot10_z100.png",
    )
    .await;
    render_with_frontend_viewport(
        &renderer,
        &image,
        w,
        h,
        Some(small_crop.clone()),
        500.0,
        500.0,
        2.0,
        "small crop rot=10°, zoom=200%",
        "/tmp/shade_e2e_v2_small_rot10_z200.png",
    )
    .await;
}

/// Uses the real fixture image if available.
#[tokio::test]
async fn frontend_viewport_zoom_fixture() {
    let Some(renderer) = renderer_or_skip().await else {
        return;
    };
    let Some((image, w, h)) = load_fixture() else {
        return;
    };

    let crop = CropRect {
        x: w as f32 * 0.15,
        y: h as f32 * 0.15,
        width: w as f32 * 0.7,
        height: h as f32 * 0.7,
        rotation: 12.0f32.to_radians(),
    };

    render_with_frontend_viewport(
        &renderer,
        &image,
        w,
        h,
        Some(crop.clone()),
        600.0,
        600.0,
        1.0,
        "fixture crop rot=12°, zoom=100%",
        "/tmp/shade_e2e_v2_fixture_z100.png",
    )
    .await;
    render_with_frontend_viewport(
        &renderer,
        &image,
        w,
        h,
        Some(crop.clone()),
        600.0,
        600.0,
        2.0,
        "fixture crop rot=12°, zoom=200%",
        "/tmp/shade_e2e_v2_fixture_z200.png",
    )
    .await;
}
