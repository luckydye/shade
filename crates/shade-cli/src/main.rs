use anyhow::Result;
use clap::{Parser, Subcommand};
use shade_core::{
    AdjustmentOp, ColorParams, GrainParams, SharpenParams, ToneParams, VignetteParams,
};
use shade_gpu::Renderer;
use shade_io::{load_image, save_image};
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
    },
}

#[tokio::main]
async fn main() -> Result<()> {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info")).init();

    let cli = Cli::parse();

    match cli.command {
        Commands::Edit {
            input,
            output,
            exposure,
            contrast,
            blacks,
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
        } => {
            log::info!("Loading image: {}", input.display());
            let (pixels, width, height) = load_image(&input)?;
            log::info!("Image loaded: {}×{} px", width, height);

            // Build the op list. Only add ops when at least one non-default value is requested.
            let mut ops: Vec<AdjustmentOp> = Vec::new();

            // Always include a Tone op (covers the main tone adjustments).
            let tone_params = ToneParams {
                exposure,
                contrast,
                blacks,
                highlights,
                shadows,
            };
            log::info!("Tone params: {:?}", tone_params);
            ops.push(AdjustmentOp::Tone {
                exposure,
                contrast,
                blacks,
                highlights,
                shadows,
            });

            // Color op — add if any color param is set.
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

            // Vignette op — add if vignette amount is set.
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

            // Sharpen op — add if sharpen amount is set.
            if sharpen.is_some() {
                let sharpen_params = SharpenParams {
                    amount: sharpen.unwrap_or(0.0),
                    threshold: sharpen_threshold.unwrap_or(0.0),
                };
                log::info!("Sharpen params: {:?}", sharpen_params);
                ops.push(AdjustmentOp::Sharpen(sharpen_params));
            }

            // Grain op — add if grain amount is set.
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
            let result = renderer
                .render_with_ops(&pixels, width, height, &ops)
                .await?;

            log::info!("Saving output: {}", output.display());
            save_image(&output, &result, width, height)?;
            log::info!("Done.");
        }
    }

    Ok(())
}
