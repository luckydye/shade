/// End-to-end test: loads a real image, applies crop+rotation through the
/// full GPU pipeline, and saves PNGs to /tmp for visual inspection.
///
/// Run with:  cargo test -p shade-gpu --test crop_rotation_e2e -- --nocapture
///
/// Produces:
///   /tmp/shade_e2e_no_crop.png          — original image, no crop
///   /tmp/shade_e2e_crop_no_rot.png      — cropped, no rotation
///   /tmp/shade_e2e_crop_rot45.png        — cropped + 45° rotation
///   /tmp/shade_e2e_crop_rot45_full.png   — same crop+rot, viewport=full canvas
///   /tmp/shade_e2e_crop_rot90.png        — cropped + 90° rotation
///   /tmp/shade_e2e_crop_rot10.png        — cropped + 10° rotation
use shade_core::{CropRect, FloatImage, LayerStack};
use shade_gpu::{PreviewCrop, Renderer};
use std::collections::HashMap;
use std::path::Path;

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

/// Create a synthetic 200×100 image with a clear grid pattern so rotation
/// effects are visually obvious. Red channel encodes column, green encodes
/// row, blue is a checkerboard.
fn make_test_image() -> (FloatImage, u32, u32) {
    let (w, h) = (200u32, 100u32);
    let mut pixels = Vec::with_capacity((w * h * 4) as usize);
    for row in 0..h {
        for col in 0..w {
            let r = col as f32 / w as f32;
            let g = row as f32 / h as f32;
            let b = if (col / 20 + row / 20) % 2 == 0 {
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

/// Also try loading a real fixture if available.
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

async fn render_scenario(
    renderer: &Renderer,
    image: &FloatImage,
    canvas_w: u32,
    canvas_h: u32,
    target_w: u32,
    target_h: u32,
    crop_rect: Option<CropRect>,
    viewport_crop: Option<PreviewCrop>,
    label: &str,
    out_path: &str,
) {
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
            target_w,
            target_h,
            viewport_crop,
        )
        .await
        .expect("render failed");

    eprintln!("[{label}]");
    save_png(&pixels, target_w, target_h, out_path);
}

#[tokio::test]
async fn crop_rotation_e2e_synthetic() {
    let Some(renderer) = renderer_or_skip().await else {
        return;
    };

    let (image, w, h) = make_test_image(); // 200×100
    let target_w = 200;
    let target_h = 100;

    // 1. No crop — baseline
    render_scenario(
        &renderer,
        &image,
        w,
        h,
        target_w,
        target_h,
        None,
        None,
        "no crop",
        "/tmp/shade_e2e_no_crop.png",
    )
    .await;

    // 2. Crop right half, no rotation
    render_scenario(
        &renderer,
        &image,
        w,
        h,
        100,
        100,
        Some(CropRect {
            x: 100.0,
            y: 0.0,
            width: 100.0,
            height: 100.0,
            rotation: 0.0,
        }),
        None,
        "crop, no rotation",
        "/tmp/shade_e2e_crop_no_rot.png",
    )
    .await;

    // 3. Crop center square + 45° rotation, viewport = full canvas
    render_scenario(
        &renderer,
        &image,
        w,
        h,
        100,
        100,
        Some(CropRect {
            x: 50.0,
            y: 0.0,
            width: 100.0,
            height: 100.0,
            rotation: std::f32::consts::FRAC_PI_4,
        }),
        None, // full canvas viewport
        "crop+45° (full viewport)",
        "/tmp/shade_e2e_crop_rot45_full.png",
    )
    .await;

    // 4. Same crop+45° but viewport = crop rect (what the frontend sends)
    render_scenario(
        &renderer,
        &image,
        w,
        h,
        100,
        100,
        Some(CropRect {
            x: 50.0,
            y: 0.0,
            width: 100.0,
            height: 100.0,
            rotation: std::f32::consts::FRAC_PI_4,
        }),
        Some(PreviewCrop {
            x: 50.0,
            y: 0.0,
            width: 100.0,
            height: 100.0,
        }),
        "crop+45° (crop-rect viewport)",
        "/tmp/shade_e2e_crop_rot45.png",
    )
    .await;

    // 5. Crop + 90° rotation
    render_scenario(
        &renderer,
        &image,
        w,
        h,
        100,
        100,
        Some(CropRect {
            x: 50.0,
            y: 0.0,
            width: 100.0,
            height: 100.0,
            rotation: std::f32::consts::FRAC_PI_2,
        }),
        Some(PreviewCrop {
            x: 50.0,
            y: 0.0,
            width: 100.0,
            height: 100.0,
        }),
        "crop+90° (crop-rect viewport)",
        "/tmp/shade_e2e_crop_rot90.png",
    )
    .await;

    // 6. Crop + 10° rotation (subtle)
    render_scenario(
        &renderer,
        &image,
        w,
        h,
        100,
        100,
        Some(CropRect {
            x: 50.0,
            y: 0.0,
            width: 100.0,
            height: 100.0,
            rotation: 10.0f32.to_radians(),
        }),
        Some(PreviewCrop {
            x: 50.0,
            y: 0.0,
            width: 100.0,
            height: 100.0,
        }),
        "crop+10° (crop-rect viewport)",
        "/tmp/shade_e2e_crop_rot10.png",
    )
    .await;

    // 7. Pixel-level assertion: full-viewport and crop-viewport 45° must match
    let mut stack_full = LayerStack::new();
    stack_full.add_image_layer(1, w, h);
    stack_full.add_crop_layer(CropRect {
        x: 50.0,
        y: 0.0,
        width: 100.0,
        height: 100.0,
        rotation: std::f32::consts::FRAC_PI_4,
    });
    let mut sources = HashMap::new();
    sources.insert(1, image.clone());

    let px_full = renderer
        .render_stack_preview(
            &stack_full,
            &sources,
            w,
            h,
            100,
            100,
            None, // full canvas
        )
        .await
        .expect("render");
    let px_crop = renderer
        .render_stack_preview(
            &stack_full,
            &sources,
            w,
            h,
            100,
            100,
            Some(PreviewCrop {
                x: 50.0,
                y: 0.0,
                width: 100.0,
                height: 100.0,
            }),
        )
        .await
        .expect("render");

    let mut max_diff = 0u8;
    let mut diff_count = 0u32;
    for (i, (a, b)) in px_full.iter().zip(px_crop.iter()).enumerate() {
        let d = (*a as i16 - *b as i16).unsigned_abs() as u8;
        if d > 2 {
            diff_count += 1;
        }
        max_diff = max_diff.max(d);
    }
    eprintln!(
        "\n[assertion] full-viewport vs crop-viewport 45° rotation:");
    eprintln!(
        "  max_diff={max_diff}, pixels_with_diff>2={diff_count}/{}",
        px_full.len() / 4
    );
    assert!(
        max_diff <= 3,
        "full-viewport and crop-viewport renders diverge: max_diff={max_diff}, \
         diff_count={diff_count} — rotation not applied in canvas space"
    );
}

#[tokio::test]
async fn crop_rotation_e2e_fixture() {
    let Some(renderer) = renderer_or_skip().await else {
        return;
    };
    let Some((image, w, h)) = load_fixture() else {
        return;
    };

    // Render at a reasonable preview size.
    let scale = 800.0 / w.max(h) as f32;
    let tw = (w as f32 * scale) as u32;
    let th = (h as f32 * scale) as u32;

    // Crop center 60% with 15° rotation.
    let crop_w = w as f32 * 0.6;
    let crop_h = h as f32 * 0.6;
    let crop_x = (w as f32 - crop_w) * 0.5;
    let crop_y = (h as f32 - crop_h) * 0.5;

    let crop = CropRect {
        x: crop_x,
        y: crop_y,
        width: crop_w,
        height: crop_h,
        rotation: 15.0f32.to_radians(),
    };

    let crop_tw = (crop_w * scale) as u32;
    let crop_th = (crop_h * scale) as u32;

    // Full viewport
    render_scenario(
        &renderer,
        &image,
        w,
        h,
        crop_tw,
        crop_th,
        Some(crop.clone()),
        None,
        "fixture: crop+15° full viewport",
        "/tmp/shade_e2e_fixture_rot15_full.png",
    )
    .await;

    // Crop-rect viewport (what frontend sends)
    render_scenario(
        &renderer,
        &image,
        w,
        h,
        crop_tw,
        crop_th,
        Some(crop.clone()),
        Some(PreviewCrop {
            x: crop_x,
            y: crop_y,
            width: crop_w,
            height: crop_h,
        }),
        "fixture: crop+15° crop-rect viewport",
        "/tmp/shade_e2e_fixture_rot15_cropped.png",
    )
    .await;
}
