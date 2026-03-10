use anyhow::Result;
use clap::{Parser, Subcommand};
use shade_core::ToneParams;
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
    /// Apply tone adjustments to an image and export the result.
    Edit {
        /// Input image path (JPEG, PNG, TIFF, WebP, …)
        input: PathBuf,

        /// Output image path (extension determines format: .png, .jpg, .tiff, .webp)
        #[arg(short, long)]
        output: PathBuf,

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
        } => {
            log::info!("Loading image: {}", input.display());
            let (pixels, width, height) = load_image(&input)?;
            log::info!("Image loaded: {}×{} px", width, height);

            let params = ToneParams {
                exposure,
                contrast,
                blacks,
                highlights,
                shadows,
            };
            log::info!("Tone params: {:?}", params);

            log::info!("Initialising GPU renderer…");
            let renderer = Renderer::new().await?;

            log::info!("Running tone pipeline…");
            let result = renderer.render(&pixels, width, height, params).await?;

            log::info!("Saving output: {}", output.display());
            save_image(&output, &result, width, height)?;
            log::info!("Done.");
        }
    }

    Ok(())
}
