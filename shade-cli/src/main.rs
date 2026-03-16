use anyhow::Result;
use clap::{Parser, Subcommand};
use shade_core::{
    AdjustmentOp, BlendMode, ColorParams, ColorSpace, CropRect, FloatImage, GrainParams,
    LayerStack, SharpenParams, ToneParams, VignetteParams,
};
use shade_gpu::{PreviewCrop, Renderer};
use shade_io::{
    from_linear_srgb_f32, load_image, load_image_f32_with_colorspace, quantize_rgba_f32,
    save_image, to_linear_srgb_f32,
};
use std::collections::HashMap;
use std::path::PathBuf;

/// Shade — GPU-accelerated photo editor CLI
#[derive(Parser, Debug)]
#[command(name = "shade-cli", version, about)]
struct Cli {
    #[command(subcommand)]
    command: Commands,
}

#[derive(Subcommand, Debug)]
enum Commands {
    /// Apply tone and color adjustments to an image and export the result.
    Edit {
        /// Input image path (JPEG, PNG, TIFF, WebP, …)
        input: PathBuf,

        /// Output image path (extension determines format: .png, .jpg, .tiff, .webp)
        #[arg(short, long)]
        output: PathBuf,

        // ── Tone ──────────────────────────────────────────────────────────────
        /// Exposure adjustment in EV stops (default: 0.0)
        #[arg(long, default_value_t = 0.0)]
        exposure: f32,

        /// Contrast adjustment, pivoted around mid-grey (default: 0.0)
        #[arg(long, default_value_t = 0.0)]
        contrast: f32,

        /// Black level lift (default: 0.0)
        #[arg(long, default_value_t = 0.0)]
        blacks: f32,

        /// White ceiling lift for highlights (default: 0.0)
        #[arg(long, default_value_t = 0.0)]
        whites: f32,

        /// Highlights roll-off compression (default: 0.0)
        #[arg(long, default_value_t = 0.0)]
        highlights: f32,

        /// Shadows lift for dark areas (default: 0.0)
        #[arg(long, default_value_t = 0.0)]
        shadows: f32,

        // ── Color ─────────────────────────────────────────────────────────────
        /// Color saturation (1.0 = unchanged, 0.0 = monochrome)
        #[arg(long)]
        saturation: Option<f32>,

        /// Vibrancy: selective saturation boost for less-saturated pixels
        #[arg(long)]
        vibrancy: Option<f32>,

        /// Color temperature shift (-1.0 = cool, 1.0 = warm)
        #[arg(long)]
        temperature: Option<f32>,

        /// Tint shift (-1.0 = green, 1.0 = magenta)
        #[arg(long)]
        tint: Option<f32>,

        // ── Vignette ──────────────────────────────────────────────────────────
        /// Vignette amount (0.0–1.0)
        #[arg(long)]
        vignette: Option<f32>,

        /// Vignette midpoint (default: 0.5)
        #[arg(long)]
        vignette_midpoint: Option<f32>,

        /// Vignette feather/softness (default: 0.2)
        #[arg(long)]
        vignette_feather: Option<f32>,

        // ── Sharpen ───────────────────────────────────────────────────────────
        /// Sharpen amount (0.0–2.0)
        #[arg(long)]
        sharpen: Option<f32>,

        /// Sharpen threshold — suppresses sharpening in smooth areas (0.0–1.0)
        #[arg(long)]
        sharpen_threshold: Option<f32>,

        // ── Grain ─────────────────────────────────────────────────────────────
        /// Film grain intensity (0.0–1.0)
        #[arg(long)]
        grain: Option<f32>,

        /// Grain size factor (1.0 = pixel-level, 4.0 = coarser)
        #[arg(long)]
        grain_size: Option<f32>,

        // ── Colour management ─────────────────────────────────────────────────
        /// Source colour space: srgb, adobergb, p3, prophoto (default: auto-detect from embedded profile)
        #[arg(long)]
        color_space: Option<String>,

        /// Output/display colour space: srgb, p3 (default: srgb)
        #[arg(long)]
        display_space: Option<String>,
    },

    /// Test the layer compositor: base Image layer + Adjustment layer.
    Stack {
        /// Input image path (JPEG, PNG, TIFF, WebP, …)
        input: PathBuf,

        /// Output image path
        #[arg(short, long)]
        output: PathBuf,

        /// Exposure adjustment for the adjustment layer (default: 0.0)
        #[arg(long, default_value_t = 0.0)]
        exposure: f32,

        /// Vignette amount for the adjustment layer (default: 0.0)
        #[arg(long, default_value_t = 0.0)]
        vignette: f32,

        /// Saturation for the adjustment layer (default: 1.0)
        #[arg(long, default_value_t = 1.0)]
        saturation: f32,

        /// Preview output width. Required with `--preview-height` when previewing a crop.
        #[arg(long)]
        preview_width: Option<u32>,

        /// Preview output height. Required with `--preview-width` when previewing a crop.
        #[arg(long)]
        preview_height: Option<u32>,

        /// Crop origin X in source pixels.
        #[arg(long)]
        crop_x: Option<f32>,

        /// Crop origin Y in source pixels.
        #[arg(long)]
        crop_y: Option<f32>,

        /// Crop width in source pixels.
        #[arg(long)]
        crop_width: Option<f32>,

        /// Crop height in source pixels.
        #[arg(long)]
        crop_height: Option<f32>,

        /// Crop rotation in radians.
        #[arg(long, default_value_t = 0.0)]
        crop_rotation: f32,
    },
}

fn preview_crop_from_args(
    crop_x: Option<f32>,
    crop_y: Option<f32>,
    crop_width: Option<f32>,
    crop_height: Option<f32>,
) -> Result<Option<PreviewCrop>> {
    match (crop_x, crop_y, crop_width, crop_height) {
        (None, None, None, None) => Ok(None),
        (Some(x), Some(y), Some(width), Some(height)) => {
            let rect = CropRect {
                x,
                y,
                width,
                height,
                rotation: 0.0,
            };
            if rect.width <= 0.0 || rect.height <= 0.0 {
                anyhow::bail!("crop_width and crop_height must be > 0");
            }
            Ok(Some(PreviewCrop {
                x: rect.x,
                y: rect.y,
                width: rect.width,
                height: rect.height,
            }))
        }
        _ => anyhow::bail!(
            "crop preview requires crop_x, crop_y, crop_width, and crop_height"
        ),
    }
}

fn preview_target_size(
    preview_width: Option<u32>,
    preview_height: Option<u32>,
    crop: Option<&PreviewCrop>,
    canvas_width: u32,
    canvas_height: u32,
) -> Result<(u32, u32)> {
    match (preview_width, preview_height, crop) {
        (Some(width), Some(height), _) => {
            if width == 0 || height == 0 {
                anyhow::bail!("preview_width and preview_height must be > 0");
            }
            Ok((width, height))
        }
        (None, None, Some(crop)) => {
            Ok((crop.width.ceil() as u32, crop.height.ceil() as u32))
        }
        (None, None, None) => Ok((canvas_width, canvas_height)),
        _ => anyhow::bail!("preview_width and preview_height must be provided together"),
    }
}

#[tokio::main]
async fn main() -> Result<()> {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info"))
        .init();

    let cli = Cli::parse();

    match cli.command {
        Commands::Edit {
            input,
            output,
            exposure,
            contrast,
            blacks,
            whites,
            highlights,
            shadows,
            saturation,
            vibrancy,
            temperature,
            tint,
            vignette,
            vignette_midpoint,
            vignette_feather,
            sharpen,
            sharpen_threshold,
            grain,
            grain_size,
            color_space,
            display_space,
        } => {
            // ── Resolve colour spaces ─────────────────────────────────────────
            let parse_color_space = |s: &str| -> ColorSpace {
                match s.to_lowercase().as_str() {
                    "srgb" | "sRGB" => ColorSpace::Srgb,
                    "linear" | "linearsrgb" => ColorSpace::LinearSrgb,
                    "adobergb" | "adobe" => ColorSpace::AdobeRgb,
                    "p3" | "displayp3" => ColorSpace::DisplayP3,
                    "prophoto" => ColorSpace::ProPhotoRgb,
                    _ => ColorSpace::Srgb,
                }
            };

            let display_cs: ColorSpace = display_space
                .as_deref()
                .map(parse_color_space)
                .unwrap_or(ColorSpace::Srgb);

            log::info!("Loading image: {}", input.display());
            let (image, detected_cs) = load_image_f32_with_colorspace(&input)?;
            let width = image.width;
            let height = image.height;
            let mut pixels = image.pixels.to_vec();
            log::info!("Image loaded: {}×{} px", width, height);

            // Override detected colour space if the user provided one explicitly.
            let src_cs: ColorSpace = color_space
                .as_deref()
                .map(parse_color_space)
                .unwrap_or(detected_cs.clone());

            log::info!("Source colour space: {}", src_cs.name());
            log::info!("Display colour space: {}", display_cs.name());

            // Convert source pixels to linear sRGB (internal working space).
            to_linear_srgb_f32(&mut pixels, &src_cs);

            let mut ops: Vec<AdjustmentOp> = Vec::new();

            let tone_params = ToneParams {
                exposure,
                contrast,
                blacks,
                whites,
                highlights,
                shadows,
                gamma: 1.0,
                _pad: 0.0,
            };
            log::info!("Tone params: {:?}", tone_params);
            ops.push(AdjustmentOp::Tone {
                exposure,
                contrast,
                blacks,
                whites,
                highlights,
                shadows,
                gamma: 1.0,
            });

            if saturation.is_some()
                || vibrancy.is_some()
                || temperature.is_some()
                || tint.is_some()
            {
                let color_params = ColorParams {
                    saturation: saturation.unwrap_or(1.0),
                    vibrancy: vibrancy.unwrap_or(0.0),
                    temperature: temperature.unwrap_or(0.0),
                    tint: tint.unwrap_or(0.0),
                };
                log::info!("Color params: {:?}", color_params);
                ops.push(AdjustmentOp::Color(color_params));
            }

            if vignette.is_some() {
                let mut vig_params = VignetteParams::default();
                if let Some(v) = vignette {
                    vig_params.amount = v;
                }
                if let Some(v) = vignette_midpoint {
                    vig_params.midpoint = v;
                }
                if let Some(v) = vignette_feather {
                    vig_params.feather = v;
                }
                log::info!("Vignette params: {:?}", vig_params);
                ops.push(AdjustmentOp::Vignette(vig_params));
            }

            if sharpen.is_some() {
                let sharpen_params = SharpenParams {
                    amount: sharpen.unwrap_or(0.0),
                    threshold: sharpen_threshold.unwrap_or(0.0),
                };
                log::info!("Sharpen params: {:?}", sharpen_params);
                ops.push(AdjustmentOp::Sharpen(sharpen_params));
            }

            if grain.is_some() {
                let grain_params = GrainParams {
                    amount: grain.unwrap_or(0.0),
                    size: grain_size.unwrap_or(1.0),
                    ..GrainParams::default()
                };
                log::info!("Grain params: {:?}", grain_params);
                ops.push(AdjustmentOp::Grain(grain_params));
            }

            log::info!("Initialising GPU renderer…");
            let renderer = Renderer::new().await?;

            log::info!("Running {} pipeline op(s)…", ops.len());
            let mut result = renderer
                .render_with_ops_f32(&pixels, width, height, &ops)
                .await?;

            // Apply display/export colour space transform (linear sRGB → display_cs).
            from_linear_srgb_f32(&mut result, &display_cs);

            log::info!("Saving output: {}", output.display());
            save_image(&output, &quantize_rgba_f32(&result), width, height)?;
            log::info!("Done.");
        }

        Commands::Stack {
            input,
            output,
            exposure,
            vignette,
            saturation,
            preview_width,
            preview_height,
            crop_x,
            crop_y,
            crop_width,
            crop_height,
            crop_rotation: _,
        } => {
            log::info!("Loading image: {}", input.display());
            let (pixels, width, height) = load_image(&input)?;
            log::info!("Image loaded: {}×{} px", width, height);

            // Build a 2-layer stack:
            //   Layer 0: Image layer (base image)
            //   Layer 1: Adjustment layer (tone + optional vignette + color)
            let mut stack = LayerStack::new();

            // Image layer — texture_id = 0.
            let base_texture_id: shade_core::TextureId = 0;
            stack.add_image_layer(base_texture_id, width, height);

            // Adjustment layer ops.
            let mut adj_ops: Vec<AdjustmentOp> = Vec::new();

            adj_ops.push(AdjustmentOp::Tone {
                exposure,
                contrast: 0.0,
                blacks: 0.0,
                whites: 0.0,
                highlights: 0.0,
                shadows: 0.0,
                gamma: 1.0,
            });

            if (saturation - 1.0).abs() > f32::EPSILON {
                adj_ops.push(AdjustmentOp::Color(ColorParams {
                    saturation,
                    vibrancy: 0.0,
                    temperature: 0.0,
                    tint: 0.0,
                }));
            }

            if vignette.abs() > f32::EPSILON {
                adj_ops.push(AdjustmentOp::Vignette(VignetteParams {
                    amount: vignette,
                    ..VignetteParams::default()
                }));
            }

            stack.add_adjustment_layer(adj_ops);

            // Set blend modes (Normal = 0, full opacity).
            stack.layers[0].blend_mode = BlendMode::Normal;
            stack.layers[0].opacity = 1.0;
            stack.layers[1].blend_mode = BlendMode::Normal;
            stack.layers[1].opacity = 1.0;

            // Image sources map.
            let mut image_sources = HashMap::new();
            image_sources.insert(
                base_texture_id,
                FloatImage {
                    pixels: pixels
                        .into_iter()
                        .map(|channel| channel as f32 / 255.0)
                        .collect::<Vec<_>>()
                        .into(),
                    width,
                    height,
                },
            );

            log::info!("Initialising GPU renderer…");
            let renderer = Renderer::new().await?;

            let crop = preview_crop_from_args(crop_x, crop_y, crop_width, crop_height)?;
            let (target_width, target_height) = preview_target_size(
                preview_width,
                preview_height,
                crop.as_ref(),
                width,
                height,
            )?;

            log::info!(
                "Compositing layer stack ({} layers) to {}×{}…",
                stack.layers.len(),
                target_width,
                target_height
            );
            let result = renderer
                .render_stack_preview(
                    &stack,
                    &image_sources,
                    width,
                    height,
                    target_width,
                    target_height,
                    crop,
                )
                .await?;

            log::info!("Saving output: {}", output.display());
            save_image(&output, &result, target_width, target_height)?;
            log::info!("Done.");
        }
    }

    Ok(())
}
