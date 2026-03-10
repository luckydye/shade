use anyhow::Result;
use shade_core::ToneParams;
use wgpu::{
    BufferDescriptor, BufferUsages, Extent3d, ImageCopyBuffer, ImageCopyTexture,
    ImageDataLayout, MapMode, Origin3d, TextureAspect, TextureDescriptor, TextureDimension,
    TextureFormat, TextureUsages,
};

use crate::{GpuContext, TonePipeline};

/// High-level renderer: owns the GPU context and tone pipeline.
pub struct Renderer {
    pub ctx: GpuContext,
    pub tone_pipeline: TonePipeline,
}

impl Renderer {
    /// Create a new headless renderer, initialising the GPU context and compiling shaders.
    pub async fn new() -> Result<Self> {
        let ctx = GpuContext::new_headless().await?;
        let tone_pipeline = TonePipeline::new(&ctx)?;
        Ok(Self { ctx, tone_pipeline })
    }

    /// Apply tone adjustments to raw RGBA8 pixels and return the processed RGBA8 result.
    ///
    /// # Arguments
    /// * `input_data` — raw RGBA8 bytes (`width * height * 4`)
    /// * `width`, `height` — image dimensions
    /// * `params` — tone adjustment parameters
    ///
    /// Returns raw RGBA8 bytes of the same size.
    pub async fn render(
        &self,
        input_data: &[u8],
        width: u32,
        height: u32,
        params: ToneParams,
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

        // ── 2. Run tone pipeline ─────────────────────────────────────────────

        let output_tex = self.tone_pipeline.process(&self.ctx, &input_tex, params)?;

        // ── 3. Read back the output texture to CPU ────────────────────────────

        // wgpu requires copy row stride to be aligned to COPY_BYTES_PER_ROW_ALIGNMENT (256).
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
                texture: &output_tex,
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

        // Poll the device until the mapping is complete.
        device.poll(wgpu::Maintain::Wait);
        rx.await??;

        let mapped = buffer_slice.get_mapped_range();

        // Strip padding: collect only the unpadded bytes per row.
        let mut result =
            Vec::with_capacity((unpadded_bytes_per_row * height) as usize);
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
