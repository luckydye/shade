#[cfg_attr(not(feature = "video"), allow(unused_imports))]
use anyhow::{Context, Result};
use clap::{Parser, Subcommand};
use shade_core::{
    AdjustmentOp, BlendMode, ColorParams, ColorSpace, CropRect, FloatImage, GrainParams,
    LayerStack, MaskData, MaskParams, PreviewCrop, Renderer, SharpenParams, ToneParams,
    VignetteParams,
};
use shade_io::{
    from_linear_srgb_f32, generate_desktop_thumbnail, load_image,
    load_image_f32_with_colorspace, quantize_rgba_f32, save_image, scan_directory_images,
    to_linear_srgb_f32,
};
#[cfg(feature = "video")]
use shade_io::{VideoCodec, VideoDecoder, VideoEncoder};
use shade_p2p::{
    AwarenessState, LocalPeerDiscovery, PeerProvider, PictureMetadata, SharedPicture,
    SyncSnapshotInfo,
};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

/// Shade — GPU-accelerated photo editor CLI
#[derive(Parser, Debug)]
#[command(name = "shade-cli", version, about)]
struct Cli {
    #[command(subcommand)]
    command: Commands,
}

#[derive(Subcommand, Debug)]
enum Commands {
    /// Serve the current working directory as a headless peer-discoverable media library.
    Serve,

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

        /// Apply a gradient mask to the adjustment layer: "linear" or "radial"
        #[arg(long)]
        mask: Option<String>,

        /// Linear mask start X (default: 0)
        #[arg(long)]
        mask_x1: Option<f32>,

        /// Linear mask start Y (default: 0)
        #[arg(long)]
        mask_y1: Option<f32>,

        /// Linear mask end X (default: 0)
        #[arg(long)]
        mask_x2: Option<f32>,

        /// Linear mask end Y (default: canvas height)
        #[arg(long)]
        mask_y2: Option<f32>,

        /// Radial mask center X (default: canvas center)
        #[arg(long)]
        mask_cx: Option<f32>,

        /// Radial mask center Y (default: canvas center)
        #[arg(long)]
        mask_cy: Option<f32>,

        /// Radial mask radius (default: min(width,height)/2)
        #[arg(long)]
        mask_radius: Option<f32>,
    },

    /// Apply tone and color adjustments to every frame of a video and encode the result.
    ///
    /// Requires system FFmpeg. Rebuild with `--features video` to enable.
    #[cfg(feature = "video")]
    Video {
        /// Input video path (MP4, MOV, MKV, …)
        input: PathBuf,

        /// Output video path (extension determines container: .mp4, .mov, .mkv)
        #[arg(short, long)]
        output: PathBuf,

        /// Output codec: h264 (default), h265, prores422, prores4444
        #[arg(long, default_value = "h264")]
        codec: String,

        /// Only process frames starting from this zero-based index (inclusive).
        #[arg(long)]
        start_frame: Option<u64>,

        /// Stop after this zero-based frame index (exclusive). Omit to process all frames.
        #[arg(long)]
        end_frame: Option<u64>,

        // ── Tone ─────────────────────────────────────────────────────────────
        #[arg(long, default_value_t = 0.0)]
        exposure: f32,

        #[arg(long, default_value_t = 0.0)]
        contrast: f32,

        #[arg(long, default_value_t = 0.0)]
        blacks: f32,

        #[arg(long, default_value_t = 0.0)]
        whites: f32,

        #[arg(long, default_value_t = 0.0)]
        highlights: f32,

        #[arg(long, default_value_t = 0.0)]
        shadows: f32,

        // ── Color ────────────────────────────────────────────────────────────
        #[arg(long)]
        saturation: Option<f32>,

        #[arg(long)]
        vibrancy: Option<f32>,

        #[arg(long)]
        temperature: Option<f32>,

        #[arg(long)]
        tint: Option<f32>,

        // ── Vignette ─────────────────────────────────────────────────────────
        #[arg(long)]
        vignette: Option<f32>,

        #[arg(long)]
        vignette_midpoint: Option<f32>,

        #[arg(long)]
        vignette_feather: Option<f32>,

        // ── Sharpen ──────────────────────────────────────────────────────────
        #[arg(long)]
        sharpen: Option<f32>,

        #[arg(long)]
        sharpen_threshold: Option<f32>,

        // ── Grain ────────────────────────────────────────────────────────────
        /// Film grain intensity. Seed is varied per-frame for natural temporal animation.
        #[arg(long)]
        grain: Option<f32>,

        #[arg(long)]
        grain_size: Option<f32>,
    },
}

pub struct ServePeerProvider {
    pub root: PathBuf,
    pub awareness: AwarenessState,
}

impl ServePeerProvider {
    pub fn new(root: PathBuf) -> Result<Self> {
        let root = canonicalize_served_root(root)?;
        Ok(Self {
            awareness: AwarenessState {
                display_name: Some(serve_peer_name(&root)?),
                active_file_hash: None,
                active_snapshot_id: None,
            },
            root,
        })
    }

    pub fn list_shared_pictures(&self) -> Result<Vec<SharedPicture>> {
        Ok(scan_directory_images(&self.root)
            .map_err(anyhow::Error::msg)?
            .into_iter()
            .map(|picture| SharedPicture {
                id: picture.path,
                name: picture.name,
                modified_at: picture.modified_at,
            })
            .collect())
    }
}

#[async_trait::async_trait]
impl PeerProvider for ServePeerProvider {
    async fn authorize_peer(&self, _peer_endpoint_id: &str) -> Result<()> {
        Ok(())
    }

    async fn list_pictures(&self) -> Result<Vec<SharedPicture>> {
        self.list_shared_pictures()
    }

    async fn get_thumbnail(&self, picture_id: &str) -> Result<Vec<u8>> {
        let picture_path = resolve_served_picture_path(&self.root, picture_id)?;
        generate_desktop_thumbnail(path_string(&picture_path)?)
            .map_err(anyhow::Error::msg)
    }

    async fn get_image_bytes(&self, picture_id: &str) -> Result<Vec<u8>> {
        let picture_path = resolve_served_picture_path(&self.root, picture_id)?;
        std::fs::read(&picture_path).with_context(|| {
            format!("failed to read served picture: {}", picture_path.display())
        })
    }

    async fn get_awareness(&self) -> Result<AwarenessState> {
        Ok(self.awareness.clone())
    }

    async fn list_snapshots(&self, _file_hash: &str) -> Result<Vec<SyncSnapshotInfo>> {
        Ok(Vec::new())
    }

    async fn get_snapshot_data(&self, _id: &str) -> Result<Vec<u8>> {
        anyhow::bail!("snapshot data is not available for served directories")
    }

    async fn get_metadata(
        &self,
        _file_hashes: &[String],
    ) -> Result<Vec<PictureMetadata>> {
        Ok(Vec::new())
    }
}

pub fn canonicalize_served_root(root: PathBuf) -> Result<PathBuf> {
    let canonical = root
        .canonicalize()
        .with_context(|| format!("failed to resolve served root: {}", root.display()))?;
    if !canonical.is_dir() {
        anyhow::bail!("served root is not a directory: {}", canonical.display());
    }
    Ok(canonical)
}

pub fn serve_peer_name(root: &Path) -> Result<String> {
    let name = root
        .file_name()
        .and_then(|segment| segment.to_str())
        .ok_or_else(|| anyhow::anyhow!("working directory name must be valid utf-8"))?;
    let trimmed = name.trim();
    if trimmed.is_empty() {
        anyhow::bail!("working directory name is empty");
    }
    Ok(trimmed.to_owned())
}

pub fn resolve_served_picture_path(root: &Path, picture_id: &str) -> Result<PathBuf> {
    let canonical_root = root
        .canonicalize()
        .with_context(|| format!("failed to resolve served root: {}", root.display()))?;
    let picture_path = Path::new(picture_id)
        .canonicalize()
        .with_context(|| format!("failed to resolve picture path: {picture_id}"))?;
    if !picture_path.starts_with(&canonical_root) {
        anyhow::bail!(
            "requested picture is outside served root: {}",
            picture_path.display()
        );
    }
    if !picture_path.is_file() {
        anyhow::bail!(
            "requested picture is not a file: {}",
            picture_path.display()
        );
    }
    if !shade_io::is_supported_library_image(&picture_path) {
        anyhow::bail!(
            "requested picture is not a supported image: {}",
            picture_path.display()
        );
    }
    Ok(picture_path)
}

pub fn path_string(path: &Path) -> Result<&str> {
    path.to_str()
        .ok_or_else(|| anyhow::anyhow!("non-utf8 path: {}", path.display()))
}

pub async fn run_serve_command() -> Result<()> {
    let provider = Arc::new(ServePeerProvider::new(std::env::current_dir()?)?);
    let peer_name = serve_peer_name(&provider.root)?;
    let discovery =
        LocalPeerDiscovery::bind_with_name(peer_name.clone(), None, provider.clone())
            .await?;
    let snapshot = discovery.snapshot().await;

    println!("Serving {}", provider.root.display());
    println!("Peer name: {peer_name}");
    println!("Endpoint ID: {}", snapshot.local_endpoint_id);
    for address in snapshot.local_direct_addresses {
        println!("Direct address: {address}");
    }

    tokio::signal::ctrl_c().await?;
    drop(discovery);
    Ok(())
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
        Commands::Serve => {
            run_serve_command().await?;
        }
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
            mask,
            mask_x1,
            mask_y1,
            mask_x2,
            mask_y2,
            mask_cx,
            mask_cy,
            mask_radius,
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

            let adj_idx = stack.add_adjustment_layer(adj_ops);

            // Apply gradient mask to the adjustment layer if requested.
            if let Some(ref mask_kind) = mask {
                let mut mask_data = MaskData::new_empty(width, height);
                let mp = match mask_kind.as_str() {
                    "linear" => {
                        let x1 = mask_x1.unwrap_or(0.0);
                        let y1 = mask_y1.unwrap_or(0.0);
                        let x2 = mask_x2.unwrap_or(0.0);
                        let y2 = mask_y2.unwrap_or(height as f32);
                        mask_data.fill_linear_gradient(x1, y1, x2, y2);
                        MaskParams::Linear { x1, y1, x2, y2 }
                    }
                    "radial" => {
                        let cx = mask_cx.unwrap_or(width as f32 / 2.0);
                        let cy = mask_cy.unwrap_or(height as f32 / 2.0);
                        let r = mask_radius.unwrap_or(width.min(height) as f32 / 2.0);
                        mask_data.fill_radial_gradient(cx, cy, r);
                        MaskParams::Radial { cx, cy, radius: r }
                    }
                    other => anyhow::bail!("unknown mask kind: {other}"),
                };
                stack.set_mask_with_params(adj_idx, mask_data, mp);
                log::info!("Applied {mask_kind} gradient mask to adjustment layer");
            }

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

        #[cfg(feature = "video")]
        Commands::Video {
            input,
            output,
            codec,
            start_frame,
            end_frame,
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
        } => {
            // Parse codec string.
            let video_codec: VideoCodec = codec.parse()?;

            // Initialise FFmpeg once.
            shade_io::init_video();

            // Open the input video and read its properties.
            let mut decoder = VideoDecoder::open(&input).with_context(|| {
                format!("failed to open input video: {}", input.display())
            })?;
            let (width, height) = decoder.dimensions();
            let fps = decoder.fps();
            let total = decoder.frame_count();
            log::info!(
                "Input video: {}×{} @ {:.3} fps, ~{} frames",
                width,
                height,
                fps,
                total
                    .map(|n| n.to_string())
                    .unwrap_or_else(|| "unknown".to_string())
            );

            // Build the adjustment ops vector (same logic as Edit command).
            let mut ops: Vec<AdjustmentOp> = Vec::new();
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
                ops.push(AdjustmentOp::Color(ColorParams {
                    saturation: saturation.unwrap_or(1.0),
                    vibrancy: vibrancy.unwrap_or(0.0),
                    temperature: temperature.unwrap_or(0.0),
                    tint: tint.unwrap_or(0.0),
                }));
            }
            if vignette.is_some() {
                let mut vp = VignetteParams::default();
                if let Some(v) = vignette {
                    vp.amount = v;
                }
                if let Some(v) = vignette_midpoint {
                    vp.midpoint = v;
                }
                if let Some(v) = vignette_feather {
                    vp.feather = v;
                }
                ops.push(AdjustmentOp::Vignette(vp));
            }
            if sharpen.is_some() {
                ops.push(AdjustmentOp::Sharpen(SharpenParams {
                    amount: sharpen.unwrap_or(0.0),
                    threshold: sharpen_threshold.unwrap_or(0.0),
                }));
            }
            if grain.is_some() {
                ops.push(AdjustmentOp::Grain(GrainParams {
                    amount: grain.unwrap_or(0.0),
                    size: grain_size.unwrap_or(1.0),
                    ..GrainParams::default()
                }));
            }

            log::info!("Initialising GPU renderer…");
            let renderer = Renderer::new().await?;

            log::info!("Opening output video: {}", output.display());
            let mut encoder =
                VideoEncoder::open(&output, width, height, fps, video_codec)
                    .with_context(|| {
                        format!("failed to open output video: {}", output.display())
                    })?;

            let start = start_frame.unwrap_or(0);
            let mut frames_written: u64 = 0;

            for frame_result in &mut decoder {
                let frame = frame_result?;

                // Skip frames before start_frame.
                if frame.index < start {
                    continue;
                }
                // Stop at end_frame.
                if let Some(end) = end_frame {
                    if frame.index >= end {
                        break;
                    }
                }

                // Convert sRGB (video colour space) → linear sRGB for GPU pipeline.
                let mut pixels = frame.data.clone();
                to_linear_srgb_f32(&mut pixels, &ColorSpace::Srgb);

                // Render through the adjustment pipeline. frame.index seeds temporal grain.
                let rgba8 = renderer
                    .render_frame(&pixels, width, height, &ops, frame.index)
                    .await?;

                // Convert linear sRGB → sRGB for video output.
                let mut out_f32: Vec<f32> =
                    rgba8.iter().map(|&b| b as f32 / 255.0).collect();
                from_linear_srgb_f32(&mut out_f32, &ColorSpace::Srgb);
                let out_rgba8 = quantize_rgba_f32(&out_f32);

                encoder.push_frame(&out_rgba8, frame.index)?;
                frames_written += 1;

                if frames_written % 25 == 0 {
                    log::info!("Encoded {} frames…", frames_written);
                }
            }

            encoder.finish()?;
            log::info!(
                "Done. Encoded {} frames → {}",
                frames_written,
                output.display()
            );
        }
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{resolve_served_picture_path, ServePeerProvider};
    use std::fs;
    use tempfile::tempdir;

    #[test]
    fn serve_provider_lists_supported_images_recursively() {
        let dir = tempdir().expect("failed to create temp dir");
        let nested = dir.path().join("nested");
        fs::create_dir(&nested).expect("failed to create nested directory");
        fs::write(dir.path().join("top.jpg"), []).expect("failed to create image");
        fs::write(nested.join("deep.png"), []).expect("failed to create nested image");
        fs::write(dir.path().join("notes.txt"), []).expect("failed to create text file");

        let provider = ServePeerProvider::new(dir.path().to_path_buf())
            .expect("failed to build serve provider");
        let pictures = provider
            .list_shared_pictures()
            .expect("failed to list served pictures");

        assert_eq!(pictures.len(), 2);
        assert!(pictures.iter().any(|picture| picture.name == "top.jpg"));
        assert!(pictures.iter().any(|picture| picture.name == "deep.png"));
    }

    #[test]
    fn served_picture_path_rejects_escape_outside_root() {
        let dir = tempdir().expect("failed to create temp dir");
        let root = dir.path().join("root");
        fs::create_dir(&root).expect("failed to create root directory");
        let inside = root.join("inside.jpg");
        let outside = dir.path().join("outside.jpg");
        fs::write(&inside, []).expect("failed to create inside image");
        fs::write(&outside, []).expect("failed to create outside image");

        let resolved =
            resolve_served_picture_path(&root, inside.to_str().expect("utf-8 path"))
                .expect("failed to resolve served picture");
        assert_eq!(
            resolved,
            inside.canonicalize().expect("canonical inside path")
        );

        let error =
            resolve_served_picture_path(&root, outside.to_str().expect("utf-8 path"))
                .expect_err("outside path should be rejected");
        assert!(
            error.to_string().contains("outside served root"),
            "unexpected error: {error}"
        );
    }
}
