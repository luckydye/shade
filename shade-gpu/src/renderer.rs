use anyhow::Result;
use shade_core::{AdjustmentOp, Layer, LayerStack, TextureId, ToneParams};
use std::collections::HashMap;
use wgpu::{
    BufferDescriptor, BufferUsages, Extent3d, ImageCopyBuffer, ImageCopyTexture, ImageDataLayout,
    MapMode, Origin3d, TextureAspect, TextureDescriptor, TextureDimension, TextureFormat,
    TextureUsages,
};

use crate::{
    basic_adjust::BasicAdjustPipeline,
    color_transform::{ColorTransformPipeline, ColorTransformUniform},
    composite::{
        create_rw_mask_texture, upload_mask_texture, BrushStampPipeline, BrushStampUniform,
        CompositePipeline, CompositeUniform,
    },
    pipelines::{ColorPipeline, CurvesPipeline, GrainPipeline, SharpenPipeline, VignettePipeline},
    sharpen2::SharpenTwoPassPipeline,
    texture_cache::TextureCache,
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
    pub composite_pipeline: CompositePipeline,
    pub brush_stamp_pipeline: Option<BrushStampPipeline>,
    pub basic_adjust_pipeline: BasicAdjustPipeline,
    pub sharpen2_pipeline: SharpenTwoPassPipeline,
    pub texture_cache: TextureCache,
    pub color_transform_pipeline: ColorTransformPipeline,
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
        let composite_pipeline = CompositePipeline::new(&ctx)?;
        let brush_stamp_pipeline = if ctx
            .device
            .features()
            .contains(wgpu::Features::TEXTURE_ADAPTER_SPECIFIC_FORMAT_FEATURES)
        {
            Some(BrushStampPipeline::new(&ctx)?)
        } else {
            None
        };
        let basic_adjust_pipeline = BasicAdjustPipeline::new(&ctx);
        let sharpen2_pipeline = SharpenTwoPassPipeline::new(&ctx);
        let texture_cache = TextureCache::new();
        let color_transform_pipeline = ColorTransformPipeline::new(&ctx);
        Ok(Self {
            ctx,
            tone_pipeline,
            curves_pipeline,
            color_pipeline,
            vignette_pipeline,
            sharpen_pipeline,
            grain_pipeline,
            composite_pipeline,
            brush_stamp_pipeline,
            basic_adjust_pipeline,
            sharpen2_pipeline,
            texture_cache,
            color_transform_pipeline,
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
    ///
    /// Optimisation: when a `Tone` op is immediately followed by a `Color` op, they are fused
    /// into a single `BasicAdjustPipeline` pass. `Sharpen` always uses the two-pass separable
    /// Gaussian pipeline.
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

        let mut current_tex: &wgpu::Texture = &input_tex;
        let mut owned_textures: Vec<wgpu::Texture> = Vec::new();

        let mut i = 0;
        while i < ops.len() {
            // Check for Tone+Color fusion opportunity
            let fused = if let AdjustmentOp::Tone {
                exposure,
                contrast,
                blacks,
                highlights,
                shadows,
            } = &ops[i]
            {
                if i + 1 < ops.len() {
                    if let AdjustmentOp::Color(color_params) = &ops[i + 1] {
                        let tone_params = ToneParams {
                            exposure: *exposure,
                            contrast: *contrast,
                            blacks: *blacks,
                            highlights: *highlights,
                            shadows: *shadows,
                        };
                        let output = self.basic_adjust_pipeline.process(
                            &self.ctx,
                            current_tex,
                            tone_params,
                            *color_params,
                        );
                        owned_textures.push(output);
                        current_tex = owned_textures.last().unwrap();
                        i += 2; // consumed both Tone and Color
                        true
                    } else {
                        false
                    }
                } else {
                    false
                }
            } else {
                false
            };

            if fused {
                continue;
            }

            let output = match &ops[i] {
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
                    self.sharpen2_pipeline
                        .process(&self.ctx, current_tex, *params)
                }
                AdjustmentOp::Grain(params) => {
                    self.grain_pipeline.process(&self.ctx, current_tex, *params)?
                }
            };

            owned_textures.push(output);
            current_tex = owned_textures.last().unwrap();
            i += 1;
        }

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
        self.readback_texture(final_tex, width, height).await
    }

    /// Render a full `LayerStack` to a flat RGBA8 image.
    ///
    /// `image_sources`: map from TextureId → (pixels: Vec<u8>, width, height)
    pub async fn render_stack(
        &self,
        stack: &LayerStack,
        image_sources: &HashMap<TextureId, (Vec<u8>, u32, u32)>,
        canvas_width: u32,
        canvas_height: u32,
    ) -> Result<Vec<u8>> {
        let device = &self.ctx.device;
        let queue = &self.ctx.queue;

        // 1. Create accumulator texture (black RGBA8).
        let accum_tex = {
            let t = device.create_texture(&TextureDescriptor {
                label: Some("accumulator"),
                size: Extent3d {
                    width: canvas_width,
                    height: canvas_height,
                    depth_or_array_layers: 1,
                },
                mip_level_count: 1,
                sample_count: 1,
                dimension: TextureDimension::D2,
                format: TextureFormat::Rgba8Unorm,
                usage: TextureUsages::TEXTURE_BINDING
                    | TextureUsages::STORAGE_BINDING
                    | TextureUsages::COPY_SRC
                    | TextureUsages::COPY_DST,
                view_formats: &[],
            });
            // Clear to black.
            let black = vec![0u8; (canvas_width * canvas_height * 4) as usize];
            queue.write_texture(
                ImageCopyTexture {
                    texture: &t,
                    mip_level: 0,
                    origin: Origin3d::ZERO,
                    aspect: TextureAspect::All,
                },
                &black,
                ImageDataLayout {
                    offset: 0,
                    bytes_per_row: Some(canvas_width * 4),
                    rows_per_image: Some(canvas_height),
                },
                Extent3d {
                    width: canvas_width,
                    height: canvas_height,
                    depth_or_array_layers: 1,
                },
            );
            t
        };

        // We accumulate results via a mutable "current accumulator" Texture reference.
        // Because wgpu textures aren't Clone, we keep a Vec and always work with the last.
        let mut accum_owned: Vec<wgpu::Texture> = vec![accum_tex];

        // 2. For each visible layer, composite it onto the accumulator.
        for entry in &stack.layers {
            if !entry.visible {
                continue;
            }

            let current_accum = accum_owned.last().unwrap();

            // 2a. Compute layer result texture.
            let layer_result: wgpu::Texture = match &entry.layer {
                Layer::Image { texture_id, .. } => {
                    if let Some((pixels, w, h)) = image_sources.get(texture_id) {
                        // Use texture_cache to avoid re-uploading unchanged images.
                        // texture_cache.get_or_upload requires &mut self, so we must use a
                        // local cache via device/queue directly here.
                        // Upload image as TEXTURE_BINDING texture.
                        use wgpu::util::DeviceExt;
                        device.create_texture_with_data(
                            queue,
                            &TextureDescriptor {
                                label: Some("image layer texture"),
                                size: Extent3d {
                                    width: *w,
                                    height: *h,
                                    depth_or_array_layers: 1,
                                },
                                mip_level_count: 1,
                                sample_count: 1,
                                dimension: TextureDimension::D2,
                                format: TextureFormat::Rgba8Unorm,
                                usage: TextureUsages::TEXTURE_BINDING | TextureUsages::COPY_DST,
                                view_formats: &[],
                            },
                            wgpu::util::TextureDataOrder::LayerMajor,
                            pixels,
                        )
                    } else {
                        // No source image: skip this layer.
                        continue;
                    }
                }
                Layer::Adjustment { ops } => {
                    // Take current accumulator pixels and run adjustment ops on them.
                    let accum_bytes = self
                        .readback_texture(current_accum, canvas_width, canvas_height)
                        .await?;
                    let adj_tex_bytes = self
                        .render_with_ops(&accum_bytes, canvas_width, canvas_height, ops)
                        .await?;
                    // Upload result back as a texture.
                    use wgpu::util::DeviceExt;
                    device.create_texture_with_data(
                        queue,
                        &TextureDescriptor {
                            label: Some("adjustment layer result"),
                            size: Extent3d {
                                width: canvas_width,
                                height: canvas_height,
                                depth_or_array_layers: 1,
                            },
                            mip_level_count: 1,
                            sample_count: 1,
                            dimension: TextureDimension::D2,
                            format: TextureFormat::Rgba8Unorm,
                            usage: TextureUsages::TEXTURE_BINDING | TextureUsages::COPY_DST,
                            view_formats: &[],
                        },
                        wgpu::util::TextureDataOrder::LayerMajor,
                        &adj_tex_bytes,
                    )
                }
            };

            // 2b. Optional mask texture.
            let mask_tex_opt: Option<wgpu::Texture> = if let Some(mask_id) = entry.mask {
                if let Some(mask_data) = stack.masks.get(&mask_id) {
                    Some(upload_mask_texture(
                        device,
                        queue,
                        &mask_data.pixels,
                        mask_data.width,
                        mask_data.height,
                    ))
                } else {
                    None
                }
            } else {
                None
            };

            // 2c. Build composite params.
            let has_mask = if mask_tex_opt.is_some() { 1u32 } else { 0u32 };
            let composite_params = CompositeUniform {
                opacity: entry.opacity,
                blend_mode: entry.blend_mode.to_u32(),
                has_mask,
                _pad: 0.0,
            };

            // 2d. Composite.
            let new_accum = self.composite_pipeline.process(
                &self.ctx,
                current_accum,
                &layer_result,
                mask_tex_opt.as_ref(),
                composite_params,
            )?;

            accum_owned.push(new_accum);
        }

        // 3. Read back the final accumulator.
        let final_accum = accum_owned.last().unwrap();
        self.readback_texture(final_accum, canvas_width, canvas_height)
            .await
    }

    /// Stamp a brush onto a mask pixel buffer in-place.
    pub async fn apply_brush_stamp(
        &self,
        mask_pixels: &mut Vec<u8>,
        width: u32,
        height: u32,
        center_x: f32,
        center_y: f32,
        radius: f32,
        hardness: f32,
        pressure: f32,
        erase: bool,
    ) -> Result<()> {
        let brush_stamp_pipeline = self
            .brush_stamp_pipeline
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("brush stamping is unavailable on this GPU backend"))?;
        let device = &self.ctx.device;
        let queue = &self.ctx.queue;

        // Upload current mask as a read-write Rgba8Unorm texture.
        let mask_tex = create_rw_mask_texture(device, queue, mask_pixels, width, height);

        let params = BrushStampUniform {
            center_x,
            center_y,
            radius,
            hardness,
            pressure,
            erase: if erase { 1 } else { 0 },
            _pad0: 0.0,
            _pad1: 0.0,
        };

        brush_stamp_pipeline.stamp(&self.ctx, &mask_tex, params)?;

        // Read back — but the texture is Rgba8Unorm (4 bytes per pixel); extract R channel.
        let rgba_bytes = self.readback_texture(&mask_tex, width, height).await?;
        mask_pixels.clear();
        mask_pixels.reserve((width * height) as usize);
        for chunk in rgba_bytes.chunks_exact(4) {
            mask_pixels.push(chunk[0]); // R channel = mask value
        }

        Ok(())
    }

    /// Apply a GPU colour transform to an existing texture.
    /// Use for viewport display: after compositing, transform linear sRGB → display space.
    pub fn apply_color_transform(
        &self,
        input_tex: &wgpu::Texture,
        uniform: ColorTransformUniform,
    ) -> wgpu::Texture {
        self.color_transform_pipeline.process(&self.ctx, input_tex, uniform)
    }

    // ── Internal helpers ──────────────────────────────────────────────────────

    /// Read back the pixels of a texture to CPU memory (RGBA8, no padding).
    async fn readback_texture(
        &self,
        tex: &wgpu::Texture,
        width: u32,
        height: u32,
    ) -> Result<Vec<u8>> {
        let device = &self.ctx.device;
        let queue = &self.ctx.queue;

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
                texture: tex,
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

        let buffer_slice = readback_buffer.slice(..);
        let (tx, rx) = tokio::sync::oneshot::channel();
        buffer_slice.map_async(MapMode::Read, move |result| {
            let _ = tx.send(result);
        });

        device.poll(wgpu::Maintain::Wait);
        rx.await??;

        let mapped = buffer_slice.get_mapped_range();

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
