//! End-to-end smoke test for the text-layer pipeline.
//!
//! Exercises the full chain: TextLayoutEngine (cosmic-text shaping) →
//! outline_glyph (TTF/OTF parse + bands) → GlyphBufferLayout (GPU storage
//! buffers) → TextPipeline (Slug-style render pass) → CompositePipeline
//! (final composite).
//!
//! Skips gracefully when no GPU adapter or no system font is available,
//! mirroring the pattern in `crop_rotation_e2e.rs`.

use shade_lib::{
    FloatImage, LayerStack, PreviewCrop, Renderer, TextContent, TextStyle,
};
use std::collections::HashMap;
use std::sync::Arc;

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

fn try_load_test_font() -> Option<Vec<u8>> {
    let candidates = [
        "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
        "/usr/share/fonts/TTF/DejaVuSans.ttf",
        "/usr/share/fonts/dejavu/DejaVuSans.ttf",
        "/usr/share/fonts/opentype/tlwg/Loma.otf",
        "/Library/Fonts/Helvetica.ttc",
        "/System/Library/Fonts/Helvetica.ttc",
    ];
    for path in candidates {
        if let Ok(bytes) = std::fs::read(path) {
            eprintln!("text e2e using font: {path}");
            return Some(bytes);
        }
    }
    None
}

/// Solid white 256×128 RGBA float image.
fn white_image(w: u32, h: u32) -> FloatImage {
    let pixels: Arc<[f32]> = vec![1.0f32; (w * h * 4) as usize].into();
    FloatImage {
        pixels,
        width: w,
        height: h,
    }
}

#[tokio::test]
async fn text_layer_renders_some_dark_pixels_over_white_background() {
    let Some(renderer) = renderer_or_skip().await else {
        return;
    };
    let Some(font_bytes) = try_load_test_font() else {
        eprintln!("SKIP: no system font available");
        return;
    };

    let canvas_w = 256u32;
    let canvas_h = 128u32;

    // Stack: image (white) underneath, text on top.
    let mut stack = LayerStack::new();
    let texture_id: u64 = 1;
    stack.add_image_layer(texture_id, canvas_w, canvas_h);

    let font_id = stack.add_font("test", font_bytes);
    let mut style = TextStyle::new(font_id, 48.0);
    // Black text in linear sRGB straight alpha.
    style.color = [0.0, 0.0, 0.0, 1.0];
    stack.add_text_layer(TextContent::new("Hi"), style);

    // Position the text roughly mid-canvas via the layer's transform.
    if let shade_lib::Layer::Text { transform, .. } = &mut stack.layers[1].layer {
        transform.tx = 60.0;
        transform.ty = 80.0;
    } else {
        panic!("layer 1 is not a text layer");
    }

    let mut sources = HashMap::new();
    sources.insert(texture_id, white_image(canvas_w, canvas_h));

    let pixels = renderer
        .render_stack_preview(
            &stack,
            &sources,
            canvas_w,
            canvas_h,
            canvas_w,
            canvas_h,
            None as Option<PreviewCrop>,
        )
        .await
        .expect("render failed");

    assert_eq!(pixels.len(), (canvas_w * canvas_h * 4) as usize);

    // Find any pixel that's substantially darker than the white background;
    // its presence proves the text path produced coverage that composited
    // over the base. We don't snapshot a specific glyph silhouette — vendor
    // GPUs and font versions vary too much for that to be reliable here.
    let dark_pixel_count = pixels
        .chunks_exact(4)
        .filter(|p| p[0] < 200 || p[1] < 200 || p[2] < 200)
        .count();
    assert!(
        dark_pixel_count > 16,
        "expected ≥16 dark pixels from text rendering, found {dark_pixel_count}"
    );
}

#[tokio::test]
async fn empty_text_layer_is_a_no_op_and_preserves_the_base() {
    let Some(renderer) = renderer_or_skip().await else {
        return;
    };

    let canvas_w = 64u32;
    let canvas_h = 32u32;

    let mut stack = LayerStack::new();
    let texture_id: u64 = 1;
    stack.add_image_layer(texture_id, canvas_w, canvas_h);

    // Empty text content with no font registered → render_text_layer returns
    // None and the composite is skipped.
    stack.add_text_layer(TextContent::new(""), TextStyle::new(0, 16.0));

    let mut sources = HashMap::new();
    sources.insert(texture_id, white_image(canvas_w, canvas_h));

    let pixels = renderer
        .render_stack_preview(
            &stack,
            &sources,
            canvas_w,
            canvas_h,
            canvas_w,
            canvas_h,
            None as Option<PreviewCrop>,
        )
        .await
        .expect("render failed");

    // Every pixel should still be near-white.
    let mismatched = pixels
        .chunks_exact(4)
        .filter(|p| p[0] < 240 || p[1] < 240 || p[2] < 240)
        .count();
    assert_eq!(
        mismatched, 0,
        "empty text should not perturb the base; {mismatched} pixels diverged"
    );
}
