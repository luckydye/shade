use anyhow::Result;
use shade_core::{AdjustmentOp, ToneParams};
use wgpu::{
    BufferDescriptor, BufferUsages, Extent3d, ImageCopyBuffer, ImageCopyTexture,
    ImageDataLayout, MapMode, Origin3d, TextureAspect, TextureDescriptor, TextureDimension,
    TextureFormat, TextureUsages,
};

use crate::{
    pipelines::{ColorPipeline, CurvesPipeline, GrainPipeline, SharpenPipeline, VignettePipeline},
    GpuContext, TonePipeline,
};

/// High-level renderer: owns the GPU context and all compute pipelines.
pub struct Renderer {
    pub ctx: GpuContext,
    pub tone_pipeline: TonePipeline,
    pub curves_pipeline: CurvesPipeline,
    pub color_pipeline: ColorPipeline,
    pub vignette_pipeline: VignettePipeline,
    pub sharpen_pipeline: SharpenPipeline,
    pub grain_pipeline: GrainPipeline,
}

impl Renderer {
    /// Create a new headless renderer, initialising the GPU context and compiling all shaders.
    pub async fn new() -> Result<Self> {
        let ctx = GpuContext::new_headless().await?;
        let tone_pipeline = TonePipeline::new(&ctx)?;
        let curves_pipeline = CurvesPipeline::new(&ctx)?;
        let color_pipeline = ColorPipeline::new(&ctx)?;
        let vignette_pipeline = VignettePipeline::new(&ctx)?;
        let sharpen_pipeline = SharpenPipeline::new(&ctx)?;
        let grain_pipeline = GrainPipeline::new(&ctx)?;
        Ok(Self {
            ctx,
            tone_pipeline,
            curves_pipeline,
            color_pipeline,
            vignette_pipeline,
            sharpen_pipeline,
            grain_pipeline,
        })
    }

    /// Apply tone adjustments to raw RGBA8 pixels and return the processed RGBA8 result.
    ///
    /// Kept for backwards compatibility — wraps `render_with_ops`.
    pub async fn render(
        &self,
        input_data: &[u8],
        width: u32,
        height: u32,
        params: ToneParams,
    ) -> Result<Vec<u8>> {
        let op = AdjustmentOp::Tone {
            exposure: params.exposure,
            contrast: params.contrast,
            blacks: params.blacks,
            highlights: params.highlights,
            shadows: params.shadows,
        };
        self.render_with_ops(input_data, width, height, &[op]).await
    }

    /// Apply a sequence of `AdjustmentOp`s to raw RGBA8 pixels, ping-ponging between textures,
    /// and return the final RGBA8 result.
    pub async fn render_with_ops(
        &self,
        input_data: &[u8],
        width: u32,
        height: u32,
        ops: &[AdjustmentOp],
    ) -> Result<Vec<u8>> {
        let device = &self.ctx.device;
        let queue = &self.ctx.queue;

        // ── 1. Upload input pixels to a Rgba8Unorm texture ──────────────────

        let input_tex = device.create_texture(&TextureDescriptor {
            label: Some("input texture"),
            size: Extent3d {
                width,
                height,
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: TextureDimension::D2,
            format: TextureFormat::Rgba8Unorm,
            usage: TextureUsages::TEXTURE_BINDING | TextureUsages::COPY_DST,
            view_formats: &[],
        });

        queue.write_texture(
            ImageCopyTexture {
                texture: &input_tex,
                mip_level: 0,
                origin: Origin3d::ZERO,
                aspect: TextureAspect::All,
            },
            input_data,
            ImageDataLayout {
                offset: 0,
                bytes_per_row: Some(width * 4),
                rows_per_image: Some(height),
            },
            Extent3d {
                width,
                height,
                depth_or_array_layers: 1,
            },
        );

        // ── 2. Apply each op sequentially, ping-ponging textures ─────────────

        // We start with a reference to the uploaded input. Each op produces a new Texture;
        // we keep them alive in a Vec so they aren't dropped while still needed.
        let mut current_tex: &wgpu::Texture = &input_tex;
        let mut owned_textures: Vec<wgpu::Texture> = Vec::new();

        for op in ops {
            let output = match op {
                AdjustmentOp::Tone {
                    exposure,
                    contrast,
                    blacks,
                    highlights,
                    shadows,
                } => {
                    let params = ToneParams {
                        exposure: *exposure,
                        contrast: *contrast,
                        blacks: *blacks,
                        highlights: *highlights,
                        shadows: *shadows,
                    };
                    self.tone_pipeline.process(&self.ctx, current_tex, params)?
                }
                AdjustmentOp::Curves {
                    lut_r,
                    lut_g,
                    lut_b,
                    lut_master,
                    per_channel,
                } => self.curves_pipeline.process(
                    &self.ctx,
                    current_tex,
                    lut_r,
                    lut_g,
                    lut_b,
                    lut_master,
                    *per_channel,
                )?,
                AdjustmentOp::Color(params) => {
                    self.color_pipeline.process(&self.ctx, current_tex, *params)?
                }
                AdjustmentOp::Vignette(params) => {
                    self.vignette_pipeline
                        .process(&self.ctx, current_tex, *params)?
                }
                AdjustmentOp::Sharpen(params) => {
                    self.sharpen_pipeline
                        .process(&self.ctx, current_tex, *params)?
                }
                AdjustmentOp::Grain(params) => {
                    self.grain_pipeline.process(&self.ctx, current_tex, *params)?
                }
            };

            owned_textures.push(output);
            current_tex = owned_textures.last().unwrap();
        }

        // If no ops were applied, we need to handle the "passthrough" case by keeping
        // input_tex as current. The final texture must be COPY_SRC.
        // All pipeline output textures already have COPY_SRC. But input_tex does not.
        // If ops is empty, we still need to copy. Create a trivial tone op for that case.
        let final_tex: &wgpu::Texture = if ops.is_empty() {
            let passthrough = self.tone_pipeline.process(
                &self.ctx,
                &input_tex,
                ToneParams::default(),
            )?;
            owned_textures.push(passthrough);
            owned_textures.last().unwrap()
        } else {
            current_tex
        };

        // ── 3. Read back the final texture to CPU ────────────────────────────

        let unpadded_bytes_per_row = width * 4;
        let align = wgpu::COPY_BYTES_PER_ROW_ALIGNMENT;
        let padded_bytes_per_row = align_up(unpadded_bytes_per_row, align);

        let readback_buffer_size = (padded_bytes_per_row * height) as u64;

        let readback_buffer = device.create_buffer(&BufferDescriptor {
            label: Some("readback buffer"),
            size: readback_buffer_size,
            usage: BufferUsages::MAP_READ | BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });

        let mut encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor {
            label: Some("readback encoder"),
        });

        encoder.copy_texture_to_buffer(
            ImageCopyTexture {
                texture: final_tex,
                mip_level: 0,
                origin: Origin3d::ZERO,
                aspect: TextureAspect::All,
            },
            ImageCopyBuffer {
                buffer: &readback_buffer,
                layout: ImageDataLayout {
                    offset: 0,
                    bytes_per_row: Some(padded_bytes_per_row),
                    rows_per_image: Some(height),
                },
            },
            Extent3d {
                width,
                height,
                depth_or_array_layers: 1,
            },
        );

        queue.submit(std::iter::once(encoder.finish()));

        // Map the buffer and read the bytes.
        let buffer_slice = readback_buffer.slice(..);
        let (tx, rx) = tokio::sync::oneshot::channel();
        buffer_slice.map_async(MapMode::Read, move |result| {
            let _ = tx.send(result);
        });

        device.poll(wgpu::Maintain::Wait);
        rx.await??;

        let mapped = buffer_slice.get_mapped_range();

        // Strip padding: collect only the unpadded bytes per row.
        let mut result = Vec::with_capacity((unpadded_bytes_per_row * height) as usize);
        for row in 0..height {
            let row_start = (row * padded_bytes_per_row) as usize;
            let row_end = row_start + unpadded_bytes_per_row as usize;
            result.extend_from_slice(&mapped[row_start..row_end]);
        }

        drop(mapped);
        readback_buffer.unmap();

        Ok(result)
    }
}

/// Round `value` up to the nearest multiple of `alignment`.
#[inline]
fn align_up(value: u32, alignment: u32) -> u32 {
    (value + alignment - 1) & !(alignment - 1)
}
