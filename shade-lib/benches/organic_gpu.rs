use shade_lib::{
    AdjustmentOp, ColorParams, CropRect, DenoiseParams, FloatImage, GlowParams,
    GrainParams, HslParams, LayerStack, PreviewCrop, Renderer, RendererMemoryStats,
    SharpenParams, TextureId, VignetteParams,
};
use std::collections::HashMap;
use std::hint::black_box;
use std::time::{Duration, Instant};

const SOURCE_WIDTH: u32 = 1800;
const SOURCE_HEIGHT: u32 = 1200;
const PREVIEW_WIDTH: u32 = 1200;
const PREVIEW_HEIGHT: u32 = 800;

fn main() -> anyhow::Result<()> {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()?;
    runtime.block_on(run())
}

async fn run() -> anyhow::Result<()> {
    let renderer = Renderer::new().await?;
    let sources = make_sources();
    report("startup", Duration::ZERO, renderer.memory_stats(), 0);

    let t = Instant::now();
    let mut checksum = 0usize;
    for i in 0..9u32 {
        let texture_id = 1 + u64::from(i % 3);
        let stack = image_edit_stack(texture_id, i as f32 * 0.17);
        let crop = Some(PreviewCrop {
            x: 80.0 * (i % 4) as f32,
            y: 45.0 * (i % 5) as f32,
            width: SOURCE_WIDTH as f32 - 260.0,
            height: SOURCE_HEIGHT as f32 - 160.0,
        });
        let pixels = renderer
            .render_stack_preview(
                &stack,
                &sources,
                SOURCE_WIDTH,
                SOURCE_HEIGHT,
                PREVIEW_WIDTH,
                PREVIEW_HEIGHT,
                crop,
            )
            .await?;
        checksum ^= black_box(pixels.len());
    }
    report(
        "switch_images_and_zoom",
        t.elapsed(),
        renderer.memory_stats(),
        checksum,
    );

    let t = Instant::now();
    for i in 0..24u32 {
        let stack = slider_stack(1, i as f32);
        let pixels = renderer
            .render_stack_preview(
                &stack,
                &sources,
                SOURCE_WIDTH,
                SOURCE_HEIGHT,
                PREVIEW_WIDTH,
                PREVIEW_HEIGHT,
                None,
            )
            .await?;
        checksum ^= black_box(pixels[i as usize % pixels.len()] as usize);
    }
    report(
        "slider_scrub",
        t.elapsed(),
        renderer.memory_stats(),
        checksum,
    );

    let t = Instant::now();
    for i in 0..8u32 {
        let stack = crop_stack(2, i as f32);
        let pixels = renderer
            .render_stack_preview(
                &stack,
                &sources,
                SOURCE_WIDTH,
                SOURCE_HEIGHT,
                1400 - (i % 3) * 180,
                900 - (i % 3) * 120,
                Some(PreviewCrop {
                    x: 120.0 + i as f32 * 17.0,
                    y: 80.0 + i as f32 * 11.0,
                    width: 1100.0,
                    height: 760.0,
                }),
            )
            .await?;
        checksum ^= black_box(pixels.len());
    }
    report(
        "crop_rotate_pan",
        t.elapsed(),
        renderer.memory_stats(),
        checksum,
    );

    let t = Instant::now();
    for texture_id in [1, 3] {
        let stack = export_stack(texture_id);
        let pixels = renderer
            .render_stack(&stack, &sources, SOURCE_WIDTH, SOURCE_HEIGHT)
            .await?;
        checksum ^= black_box(pixels.len());
    }
    report(
        "full_resolution_exports",
        t.elapsed(),
        renderer.memory_stats(),
        checksum,
    );

    let t = Instant::now();
    renderer.trim_memory();
    report("after_trim", t.elapsed(), renderer.memory_stats(), checksum);
    Ok(())
}

fn make_sources() -> HashMap<TextureId, FloatImage> {
    (1..=3)
        .map(|id| (id, make_image(id as u32, SOURCE_WIDTH, SOURCE_HEIGHT)))
        .collect()
}

fn make_image(seed: u32, width: u32, height: u32) -> FloatImage {
    let mut pixels = Vec::with_capacity((width * height * 4) as usize);
    for y in 0..height {
        for x in 0..width {
            let fx = x as f32 / width as f32;
            let fy = y as f32 / height as f32;
            let wave =
                ((x.wrapping_mul(13) ^ y.wrapping_mul(31) ^ seed) & 255) as f32 / 255.0;
            let hot = if (x as i32 - (width as i32 / 2 + seed as i32 * 47)).abs() < 24
                && (y as i32 - (height as i32 / 2)).abs() < 24
            {
                3.5
            } else {
                0.0
            };
            pixels.push((0.08 + fx * 0.9 + wave * 0.04 + hot).min(6.0));
            pixels.push((0.06 + fy * 0.8 + wave * 0.03 + hot * 0.35).min(4.0));
            pixels.push((0.04 + (1.0 - fx) * 0.5 + wave * 0.02 + hot * 0.15).min(3.0));
            pixels.push(1.0);
        }
    }
    FloatImage {
        pixels: pixels.into(),
        width,
        height,
    }
}

fn image_edit_stack(texture_id: TextureId, phase: f32) -> LayerStack {
    let mut stack = LayerStack::new();
    stack.add_image_layer(texture_id, SOURCE_WIDTH, SOURCE_HEIGHT);
    stack.add_adjustment_layer(vec![
        tone(phase.sin() * 0.4, 0.18),
        AdjustmentOp::Color(ColorParams {
            saturation: 0.12,
            vibrancy: 0.18,
            temperature: phase.cos() * 0.08,
            tint: 0.02,
        }),
        AdjustmentOp::Glow(GlowParams {
            amount: 0.35,
            _pad: [0.0; 3],
        }),
        AdjustmentOp::Sharpen(SharpenParams {
            amount: 0.35,
            threshold: 0.02,
        }),
        AdjustmentOp::Denoise(DenoiseParams {
            luma_strength: 0.18,
            chroma_strength: 0.12,
            mode: 0,
            _pad: 0.0,
        }),
    ]);
    stack
}

fn slider_stack(texture_id: TextureId, step: f32) -> LayerStack {
    let mut stack = LayerStack::new();
    stack.add_image_layer(texture_id, SOURCE_WIDTH, SOURCE_HEIGHT);
    stack.add_adjustment_layer(vec![
        tone((step * 0.23).sin() * 1.2, (step * 0.17).cos() * 0.25),
        AdjustmentOp::Color(ColorParams {
            saturation: (step * 0.11).sin() * 0.25,
            vibrancy: 0.22,
            temperature: (step * 0.07).cos() * 0.18,
            tint: 0.0,
        }),
        AdjustmentOp::Hsl(HslParams {
            red_sat: 0.08,
            green_lum: -0.03,
            blue_hue: 0.04,
            ..HslParams::default()
        }),
        AdjustmentOp::Grain(GrainParams {
            amount: 0.08,
            size: 1.0,
            roughness: 0.55,
            seed: step,
        }),
    ]);
    stack
}

fn crop_stack(texture_id: TextureId, step: f32) -> LayerStack {
    let mut stack = LayerStack::new();
    stack.add_image_layer(texture_id, SOURCE_WIDTH, SOURCE_HEIGHT);
    stack.add_crop_layer(CropRect {
        x: 160.0 + step * 12.0,
        y: 80.0 + step * 9.0,
        width: 1320.0,
        height: 920.0,
        rotation: (step - 4.0) * 0.015,
    });
    stack.add_adjustment_layer(vec![
        tone(0.15, 0.12),
        AdjustmentOp::Vignette(VignetteParams {
            amount: 0.45,
            midpoint: 0.42,
            feather: 0.28,
            roundness: 0.9,
        }),
        AdjustmentOp::Sharpen(SharpenParams {
            amount: 0.25,
            threshold: 0.0,
        }),
    ]);
    stack
}

fn export_stack(texture_id: TextureId) -> LayerStack {
    let mut stack = LayerStack::new();
    stack.add_image_layer(texture_id, SOURCE_WIDTH, SOURCE_HEIGHT);
    stack.add_adjustment_layer(vec![
        tone(0.35, 0.22),
        AdjustmentOp::Color(ColorParams {
            saturation: 0.15,
            vibrancy: 0.2,
            temperature: 0.06,
            tint: -0.02,
        }),
        AdjustmentOp::Denoise(DenoiseParams {
            luma_strength: 0.35,
            chroma_strength: 0.22,
            mode: 0,
            _pad: 0.0,
        }),
        AdjustmentOp::Glow(GlowParams {
            amount: 0.25,
            _pad: [0.0; 3],
        }),
        AdjustmentOp::Sharpen(SharpenParams {
            amount: 0.45,
            threshold: 0.01,
        }),
    ]);
    stack
}

fn tone(exposure: f32, contrast: f32) -> AdjustmentOp {
    AdjustmentOp::Tone {
        exposure,
        contrast,
        blacks: -0.02,
        whites: 0.03,
        highlights: -0.08,
        shadows: 0.05,
        gamma: 1.0,
    }
}

fn report(phase: &str, elapsed: Duration, stats: RendererMemoryStats, checksum: usize) {
    println!(
        "{{\"phase\":\"{}\",\"elapsed_ms\":{},\"rss_bytes\":{},\"work_pool_bytes\":{},\"work_pool_textures\":{},\"texture_cache_bytes\":{},\"texture_cache_textures\":{},\"readback_pool_bytes\":{},\"readback_pool_buffers\":{},\"checksum\":{}}}",
        phase,
        elapsed.as_millis(),
        current_rss_bytes(),
        stats.work_texture_pool_bytes,
        stats.work_texture_pool_textures,
        stats.texture_cache_bytes,
        stats.texture_cache_textures,
        stats.readback_buffer_pool_bytes,
        stats.readback_buffer_pool_buffers,
        checksum,
    );
}

#[cfg(target_os = "linux")]
fn current_rss_bytes() -> u64 {
    let statm =
        std::fs::read_to_string("/proc/self/statm").expect("read /proc/self/statm");
    let pages = statm
        .split_whitespace()
        .nth(1)
        .expect("statm rss field")
        .parse::<u64>()
        .expect("parse statm rss");
    pages * 4096
}

#[cfg(target_os = "macos")]
fn current_rss_bytes() -> u64 {
    let output = std::process::Command::new("ps")
        .args(["-o", "rss=", "-p", &std::process::id().to_string()])
        .output()
        .expect("run ps for rss");
    let rss_kib = String::from_utf8(output.stdout)
        .expect("ps output utf8")
        .trim()
        .parse::<u64>()
        .expect("parse ps rss");
    rss_kib * 1024
}

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
fn current_rss_bytes() -> u64 {
    0
}
