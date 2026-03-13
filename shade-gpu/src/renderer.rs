use anyhow::Result;
use half::f16;
use shade_core::{
    AdjustmentOp, ColorMatrix3x3, ColorSpace, FloatImage, Layer, LayerStack, TextureId, ToneParams,
};
use std::collections::HashMap;
use wgpu::{
    BufferDescriptor, BufferUsages, Extent3d, ImageCopyBuffer, ImageCopyTexture, ImageDataLayout,
    MapMode, Origin3d, TextureAspect, TextureDescriptor, TextureDimension, TextureUsages,
};

use crate::{
    basic_adjust::BasicAdjustPipeline,
    color_transform::{ColorTransformPipeline, ColorTransformUniform},
    composite::{
        create_rw_mask_texture, upload_mask_texture, BrushStampPipeline, BrushStampUniform,
        CompositePipeline, CompositeUniform,
    },
    pipelines::{ColorPipeline, CurvesPipeline, GrainPipeline, HslPipeline, SharpenPipeline, VignettePipeline},
    sharpen2::SharpenTwoPassPipeline,
    texture_cache::TextureCache,
    GpuContext, TonePipeline, INTERNAL_TEXTURE_FORMAT,
};

#[derive(Clone, Debug)]
pub struct PreviewCrop {
    pub x: f32,
    pub y: f32,
    pub width: f32,
    pub height: f32,
}

/// High-level renderer: owns the GPU context and all compute pipelines.
pub struct Renderer {
    pub ctx: GpuContext,
    pub tone_pipeline: TonePipeline,
    pub curves_pipeline: CurvesPipeline,
    pub color_pipeline: ColorPipeline,
    pub vignette_pipeline: VignettePipeline,
    pub sharpen_pipeline: SharpenPipeline,
    pub grain_pipeline: GrainPipeline,
    pub hsl_pipeline: HslPipeline,
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
        let hsl_pipeline = HslPipeline::new(&ctx)?;
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
            hsl_pipeline,
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
            whites: params.whites,
            highlights: params.highlights,
            shadows: params.shadows,
            gamma: params.gamma,
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
        let input_tex =
            self.upload_float_texture(&u8_rgba_to_f32(input_data), width, height, "input texture");
        let final_tex = self.render_texture_with_ops(&input_tex, ops)?;
        self.readback_work_texture_to_u8(&final_tex, width, height)
            .await
    }

    pub async fn render_with_ops_f32(
        &self,
        input_data: &[f32],
        width: u32,
        height: u32,
        ops: &[AdjustmentOp],
    ) -> Result<Vec<f32>> {
        let input_tex = self.upload_float_texture(input_data, width, height, "input texture");
        let final_tex = self.render_texture_with_ops(&input_tex, ops)?;
        self.readback_work_texture_to_f32(&final_tex, width, height)
            .await
    }

    fn render_texture_with_ops(
        &self,
        input_tex: &wgpu::Texture,
        ops: &[AdjustmentOp],
    ) -> Result<wgpu::Texture> {
        let mut current_tex: &wgpu::Texture = input_tex;
        let mut owned_textures: Vec<wgpu::Texture> = Vec::new();
        let mut i = 0;
        while i < ops.len() {
            let fused = if let AdjustmentOp::Tone {
                exposure,
                contrast,
                blacks,
                whites,
                highlights,
                shadows,
                gamma,
            } = &ops[i]
            {
                if let Some(AdjustmentOp::Color(color_params)) = ops.get(i + 1) {
                    let output = self.basic_adjust_pipeline.process(
                        &self.ctx,
                        current_tex,
                        ToneParams {
                            exposure: *exposure,
                            contrast: *contrast,
                            blacks: *blacks,
                            whites: *whites,
                            highlights: *highlights,
                            shadows: *shadows,
                            gamma: *gamma,
                            _pad: 0.0,
                        },
                        *color_params,
                    );
                    owned_textures.push(output);
                    current_tex = owned_textures.last().unwrap();
                    i += 2;
                    true
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
                    whites,
                    highlights,
                    shadows,
                    gamma,
                } => self.tone_pipeline.process(
                    &self.ctx,
                    current_tex,
                    ToneParams {
                        exposure: *exposure,
                        contrast: *contrast,
                        blacks: *blacks,
                        whites: *whites,
                        highlights: *highlights,
                        shadows: *shadows,
                        gamma: *gamma,
                        _pad: 0.0,
                    },
                )?,
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
                    self.color_pipeline
                        .process(&self.ctx, current_tex, *params)?
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
                    self.grain_pipeline
                        .process(&self.ctx, current_tex, *params)?
                }
                AdjustmentOp::Hsl(params) => {
                    self.hsl_pipeline.process(&self.ctx, current_tex, *params)?
                }
            };
            owned_textures.push(output);
            current_tex = owned_textures.last().unwrap();
            i += 1;
        }
        if let Some(texture) = owned_textures.pop() {
            Ok(texture)
        } else {
            self.tone_pipeline
                .process(&self.ctx, input_tex, ToneParams::default())
        }
    }

    /// Render a full `LayerStack` to a flat RGBA8 image.
    ///
    /// `image_sources`: map from TextureId → (pixels: Vec<u8>, width, height)
    pub async fn render_stack(
        &self,
        stack: &LayerStack,
        image_sources: &HashMap<TextureId, FloatImage>,
        canvas_width: u32,
        canvas_height: u32,
    ) -> Result<Vec<u8>> {
        self.render_stack_preview(
            stack,
            image_sources,
            canvas_width,
            canvas_height,
            canvas_width,
            canvas_height,
            None,
        )
        .await
    }

    pub async fn render_stack_preview(
        &self,
        stack: &LayerStack,
        image_sources: &HashMap<TextureId, FloatImage>,
        canvas_width: u32,
        canvas_height: u32,
        target_width: u32,
        target_height: u32,
        crop: Option<PreviewCrop>,
    ) -> Result<Vec<u8>> {
        let final_accum = self.render_stack_preview_texture(
            stack,
            image_sources,
            canvas_width,
            canvas_height,
            target_width,
            target_height,
            crop,
        )?;
        let mut pixels = self
            .readback_work_texture_to_f32(&final_accum, target_width, target_height)
            .await?;
        encode_preview_pixels(&mut pixels, &ColorSpace::Srgb);
        Ok(rgba_display_f32_to_u8(&pixels))
    }

    pub async fn render_stack_preview_f16(
        &self,
        stack: &LayerStack,
        image_sources: &HashMap<TextureId, FloatImage>,
        canvas_width: u32,
        canvas_height: u32,
        target_width: u32,
        target_height: u32,
        crop: Option<PreviewCrop>,
    ) -> Result<Vec<u16>> {
        let final_accum = self.render_stack_preview_texture(
            stack,
            image_sources,
            canvas_width,
            canvas_height,
            target_width,
            target_height,
            crop,
        )?;
        let mut pixels = self
            .readback_work_texture_to_f32(&final_accum, target_width, target_height)
            .await?;
        encode_preview_pixels(&mut pixels, &ColorSpace::DisplayP3);
        Ok(rgba_f32_to_f16_words(&pixels))
    }

    fn render_stack_preview_texture(
        &self,
        stack: &LayerStack,
        image_sources: &HashMap<TextureId, FloatImage>,
        canvas_width: u32,
        canvas_height: u32,
        target_width: u32,
        target_height: u32,
        crop: Option<PreviewCrop>,
    ) -> Result<wgpu::Texture> {
        let device = &self.ctx.device;
        let queue = &self.ctx.queue;
        assert!(target_width > 0, "preview target_width must be > 0");
        assert!(target_height > 0, "preview target_height must be > 0");
        let crop = normalize_preview_crop(crop, canvas_width, canvas_height);

        // 1. Create accumulator texture (black RGBA8).
        let accum_tex = {
            let t = device.create_texture(&TextureDescriptor {
                label: Some("accumulator"),
                size: Extent3d {
                    width: target_width,
                    height: target_height,
                    depth_or_array_layers: 1,
                },
                mip_level_count: 1,
                sample_count: 1,
                dimension: TextureDimension::D2,
                format: INTERNAL_TEXTURE_FORMAT,
                usage: TextureUsages::TEXTURE_BINDING
                    | TextureUsages::STORAGE_BINDING
                    | TextureUsages::COPY_SRC
                    | TextureUsages::COPY_DST,
                view_formats: &[],
            });
            // Clear to black.
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
                    if let Some(image) = image_sources.get(texture_id) {
                        let scaled = resample_rgba_f32_region(
                            &image.pixels,
                            image.width,
                            image.height,
                            target_width,
                            target_height,
                            &crop,
                        );
                        self.upload_float_texture(
                            &scaled,
                            target_width,
                            target_height,
                            "image layer texture",
                        )
                    } else {
                        // No source image: skip this layer.
                        continue;
                    }
                }
                Layer::Adjustment { ops } => self.render_texture_with_ops(current_accum, ops)?,
            };

            // 2b. Optional mask texture.
            let mask_tex_opt: Option<wgpu::Texture> = if let Some(mask_id) = entry.mask {
                if let Some(mask_data) = stack.masks.get(&mask_id) {
                    let scaled = resample_mask_region(
                        &mask_data.pixels,
                        mask_data.width,
                        mask_data.height,
                        target_width,
                        target_height,
                        &crop,
                    );
                    Some(upload_mask_texture(
                        device,
                        queue,
                        &scaled,
                        target_width,
                        target_height,
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
        let final_accum = accum_owned
            .pop()
            .expect("preview accumulator texture should exist");
        Ok(final_accum)
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
        let rgba_bytes = self
            .readback_rgba8_texture(&mask_tex, width, height)
            .await?;
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
        self.color_transform_pipeline
            .process(&self.ctx, input_tex, uniform)
    }

    // ── Internal helpers ──────────────────────────────────────────────────────

    fn upload_float_texture(
        &self,
        pixels: &[f32],
        width: u32,
        height: u32,
        label: &str,
    ) -> wgpu::Texture {
        let texture = self.ctx.device.create_texture(&TextureDescriptor {
            label: Some(label),
            size: Extent3d {
                width,
                height,
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: TextureDimension::D2,
            format: INTERNAL_TEXTURE_FORMAT,
            usage: TextureUsages::TEXTURE_BINDING
                | TextureUsages::COPY_DST
                | TextureUsages::COPY_SRC
                | TextureUsages::STORAGE_BINDING,
            view_formats: &[],
        });
        let data = rgba_f32_to_f16_bytes(pixels);
        self.ctx.queue.write_texture(
            ImageCopyTexture {
                texture: &texture,
                mip_level: 0,
                origin: Origin3d::ZERO,
                aspect: TextureAspect::All,
            },
            &data,
            ImageDataLayout {
                offset: 0,
                bytes_per_row: Some(width * 8),
                rows_per_image: Some(height),
            },
            Extent3d {
                width,
                height,
                depth_or_array_layers: 1,
            },
        );
        texture
    }

    async fn readback_rgba8_texture(
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
        let readback_buffer = device.create_buffer(&BufferDescriptor {
            label: Some("readback buffer"),
            size: (padded_bytes_per_row * height) as u64,
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

    /// Read back the pixels of a float work texture to CPU memory and quantize to preview RGBA8.
    async fn readback_work_texture_to_u8(
        &self,
        tex: &wgpu::Texture,
        width: u32,
        height: u32,
    ) -> Result<Vec<u8>> {
        let device = &self.ctx.device;
        let queue = &self.ctx.queue;

        let unpadded_bytes_per_row = width * 8;
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

        let mut raw = Vec::with_capacity((unpadded_bytes_per_row * height) as usize);
        for row in 0..height {
            let row_start = (row * padded_bytes_per_row) as usize;
            let row_end = row_start + unpadded_bytes_per_row as usize;
            raw.extend_from_slice(&mapped[row_start..row_end]);
        }

        drop(mapped);
        readback_buffer.unmap();

        Ok(rgba_f16_bytes_to_u8(&raw))
    }

    async fn readback_work_texture_to_f32(
        &self,
        tex: &wgpu::Texture,
        width: u32,
        height: u32,
    ) -> Result<Vec<f32>> {
        let device = &self.ctx.device;
        let queue = &self.ctx.queue;

        let unpadded_bytes_per_row = width * 8;
        let align = wgpu::COPY_BYTES_PER_ROW_ALIGNMENT;
        let padded_bytes_per_row = align_up(unpadded_bytes_per_row, align);
        let readback_buffer = device.create_buffer(&BufferDescriptor {
            label: Some("readback float buffer"),
            size: (padded_bytes_per_row * height) as u64,
            usage: BufferUsages::MAP_READ | BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        let mut encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor {
            label: Some("readback float encoder"),
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
        let mut raw = Vec::with_capacity((unpadded_bytes_per_row * height) as usize);
        for row in 0..height {
            let row_start = (row * padded_bytes_per_row) as usize;
            let row_end = row_start + unpadded_bytes_per_row as usize;
            raw.extend_from_slice(&mapped[row_start..row_end]);
        }
        drop(mapped);
        readback_buffer.unmap();
        Ok(rgba_f16_bytes_to_f32(&raw))
    }
}

fn normalize_preview_crop(
    crop: Option<PreviewCrop>,
    canvas_width: u32,
    canvas_height: u32,
) -> PreviewCrop {
    let max_width = canvas_width as f32;
    let max_height = canvas_height as f32;
    let mut crop = crop.unwrap_or(PreviewCrop {
        x: 0.0,
        y: 0.0,
        width: max_width,
        height: max_height,
    });
    crop.width = crop.width.clamp(1.0, max_width);
    crop.height = crop.height.clamp(1.0, max_height);
    crop.x = crop.x.clamp(0.0, max_width - crop.width);
    crop.y = crop.y.clamp(0.0, max_height - crop.height);
    crop
}

fn resample_rgba_f32_region(
    pixels: &[f32],
    source_width: u32,
    source_height: u32,
    target_width: u32,
    target_height: u32,
    crop: &PreviewCrop,
) -> Vec<f32> {
    let mut output = vec![0.0; (target_width * target_height * 4) as usize];
    for y in 0..target_height {
        let src_y = sample_position(y, target_height, crop.y, crop.height, source_height);
        let y0 = src_y.floor() as u32;
        let y1 = (y0 + 1).min(source_height - 1);
        let wy = src_y - y0 as f32;
        for x in 0..target_width {
            let src_x = sample_position(x, target_width, crop.x, crop.width, source_width);
            let x0 = src_x.floor() as u32;
            let x1 = (x0 + 1).min(source_width - 1);
            let wx = src_x - x0 as f32;
            let top_left = rgba_at(pixels, source_width, x0, y0);
            let top_right = rgba_at(pixels, source_width, x1, y0);
            let bottom_left = rgba_at(pixels, source_width, x0, y1);
            let bottom_right = rgba_at(pixels, source_width, x1, y1);
            let index = ((y * target_width + x) * 4) as usize;
            for channel in 0..4 {
                let top = lerp(top_left[channel], top_right[channel], wx);
                let bottom = lerp(bottom_left[channel], bottom_right[channel], wx);
                output[index + channel] = lerp(top, bottom, wy);
            }
        }
    }
    output
}

fn resample_mask_region(
    pixels: &[u8],
    source_width: u32,
    source_height: u32,
    target_width: u32,
    target_height: u32,
    crop: &PreviewCrop,
) -> Vec<u8> {
    let mut output = vec![0u8; (target_width * target_height) as usize];
    for y in 0..target_height {
        let src_y = sample_position(y, target_height, crop.y, crop.height, source_height);
        let y0 = src_y.round().clamp(0.0, (source_height - 1) as f32) as u32;
        for x in 0..target_width {
            let src_x = sample_position(x, target_width, crop.x, crop.width, source_width);
            let x0 = src_x.round().clamp(0.0, (source_width - 1) as f32) as u32;
            output[(y * target_width + x) as usize] = pixels[(y0 * source_width + x0) as usize];
        }
    }
    output
}

fn sample_position(
    output_index: u32,
    output_size: u32,
    crop_start: f32,
    crop_size: f32,
    source_size: u32,
) -> f32 {
    if output_size == 1 {
        return (crop_start + crop_size * 0.5).clamp(0.0, (source_size - 1) as f32);
    }
    let t = (output_index as f32 + 0.5) / output_size as f32;
    (crop_start + t * crop_size - 0.5).clamp(0.0, (source_size - 1) as f32)
}

fn rgba_at(pixels: &[f32], width: u32, x: u32, y: u32) -> [f32; 4] {
    let index = ((y * width + x) * 4) as usize;
    [
        pixels[index],
        pixels[index + 1],
        pixels[index + 2],
        pixels[index + 3],
    ]
}

fn u8_rgba_to_f32(pixels: &[u8]) -> Vec<f32> {
    pixels
        .iter()
        .map(|channel| *channel as f32 / 255.0)
        .collect()
}

fn rgba_f32_to_f16_bytes(pixels: &[f32]) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(pixels.len() * 2);
    for channel in pixels {
        bytes.extend_from_slice(&f16::from_f32(*channel).to_bits().to_ne_bytes());
    }
    bytes
}

fn rgba_f16_bytes_to_u8(bytes: &[u8]) -> Vec<u8> {
    let mut rgba = Vec::with_capacity(bytes.len() / 2);
    for pixel in bytes.chunks_exact(8) {
        let r = f16::from_bits(u16::from_ne_bytes([pixel[0], pixel[1]])).to_f32();
        let g = f16::from_bits(u16::from_ne_bytes([pixel[2], pixel[3]])).to_f32();
        let b = f16::from_bits(u16::from_ne_bytes([pixel[4], pixel[5]])).to_f32();
        let a = f16::from_bits(u16::from_ne_bytes([pixel[6], pixel[7]])).to_f32();
        rgba.push(preview_rgb_channel_to_u8(r));
        rgba.push(preview_rgb_channel_to_u8(g));
        rgba.push(preview_rgb_channel_to_u8(b));
        rgba.push(preview_alpha_channel_to_u8(a));
    }
    rgba
}

fn rgba_f16_bytes_to_f32(bytes: &[u8]) -> Vec<f32> {
    bytes
        .chunks_exact(2)
        .map(|chunk| {
            let bits = u16::from_ne_bytes([chunk[0], chunk[1]]);
            f16::from_bits(bits).to_f32()
        })
        .collect()
}

fn rgba_f32_to_f16_words(pixels: &[f32]) -> Vec<u16> {
    pixels
        .iter()
        .map(|channel| f16::from_f32(*channel).to_bits())
        .collect()
}

fn lerp(a: f32, b: f32, t: f32) -> f32 {
    a + (b - a) * t
}

fn encode_preview_pixels(pixels: &mut [f32], dst: &ColorSpace) {
    for pixel in pixels.chunks_exact_mut(4) {
        let rgb = [pixel[0].max(0.0), pixel[1].max(0.0), pixel[2].max(0.0)];
        let encoded = encode_preview_rgb(rgb, dst);
        pixel[0] = encoded[0];
        pixel[1] = encoded[1];
        pixel[2] = encoded[2];
        pixel[3] = pixel[3].clamp(0.0, 1.0);
    }
}

fn encode_preview_rgb(rgb: [f32; 3], dst: &ColorSpace) -> [f32; 3] {
    match dst {
        ColorSpace::DisplayP3 => {
            encode_linear_rgb_to_display_p3(rgb, &ColorMatrix3x3::LINEAR_SRGB_TO_DISPLAY_P3)
        }
        _ => [
            linear_to_srgb_display(rgb[0]),
            linear_to_srgb_display(rgb[1]),
            linear_to_srgb_display(rgb[2]),
        ],
    }
}

fn encode_linear_rgb_to_display_p3(rgb: [f32; 3], matrix: &ColorMatrix3x3) -> [f32; 3] {
    let (r, g, b) = matrix.apply(rgb[0], rgb[1], rgb[2]);
    [
        linear_to_srgb_display(r),
        linear_to_srgb_display(g),
        linear_to_srgb_display(b),
    ]
}

fn linear_to_srgb_display(value: f32) -> f32 {
    let positive = value.max(0.0);
    if positive <= 0.0031308 {
        positive * 12.92
    } else {
        1.055 * positive.powf(1.0 / 2.4) - 0.055
    }
}

fn rgba_display_f32_to_u8(pixels: &[f32]) -> Vec<u8> {
    pixels
        .iter()
        .map(|channel| (channel.clamp(0.0, 1.0) * 255.0).round() as u8)
        .collect()
}

fn preview_rgb_channel_to_u8(value: f32) -> u8 {
    if value.is_nan() {
        return 0;
    }
    if value.is_infinite() {
        return u8::MAX;
    }
    let mapped = value.max(0.0) / (1.0 + value.max(0.0));
    let encoded = if mapped <= 0.0031308 {
        mapped * 12.92
    } else {
        1.055 * mapped.powf(1.0 / 2.4) - 0.055
    };
    (encoded * 255.0).round() as u8
}

fn preview_alpha_channel_to_u8(value: f32) -> u8 {
    if value.is_nan() {
        return 0;
    }
    if value.is_infinite() {
        return u8::MAX;
    }
    (value.clamp(0.0, 1.0) * 255.0).round() as u8
}

#[cfg(test)]
mod tests {
    use super::{
        encode_preview_pixels, normalize_preview_crop, resample_mask_region,
        resample_rgba_f32_region, rgba_display_f32_to_u8, FloatImage, PreviewCrop, Renderer,
    };
    use shade_core::{AdjustmentOp, ColorSpace, LayerStack};
    use std::collections::HashMap;

    #[test]
    fn normalize_preview_crop_clamps_to_canvas() {
        let crop = normalize_preview_crop(
            Some(PreviewCrop {
                x: -50.0,
                y: 90.0,
                width: 400.0,
                height: 50.0,
            }),
            200,
            100,
        );

        assert_eq!(crop.x, 0.0);
        assert_eq!(crop.y, 50.0);
        assert_eq!(crop.width, 200.0);
        assert_eq!(crop.height, 50.0);
    }

    #[test]
    fn resample_rgba_region_reads_only_selected_crop() {
        let pixels = vec![
            10.0, 0.0, 0.0, 1.0, 20.0, 0.0, 0.0, 1.0, 30.0, 0.0, 0.0, 1.0, 40.0, 0.0, 0.0, 1.0,
            50.0, 0.0, 0.0, 1.0, 60.0, 0.0, 0.0, 1.0, 70.0, 0.0, 0.0, 1.0, 80.0, 0.0, 0.0, 1.0,
        ];
        let output = resample_rgba_f32_region(
            &pixels,
            4,
            2,
            2,
            2,
            &PreviewCrop {
                x: 2.0,
                y: 0.0,
                width: 2.0,
                height: 2.0,
            },
        );

        assert_eq!(
            output,
            vec![
                30.0, 0.0, 0.0, 1.0, 40.0, 0.0, 0.0, 1.0, 70.0, 0.0, 0.0, 1.0, 80.0, 0.0, 0.0, 1.0,
            ]
        );
    }

    #[test]
    fn resample_mask_region_reads_only_selected_crop() {
        let pixels = vec![1, 2, 3, 4, 5, 6, 7, 8];
        let output = resample_mask_region(
            &pixels,
            4,
            2,
            2,
            2,
            &PreviewCrop {
                x: 0.0,
                y: 0.0,
                width: 2.0,
                height: 2.0,
            },
        );

        assert_eq!(output, vec![1, 2, 5, 6]);
    }

    #[test]
    fn display_preview_float_path_preserves_exposure_order() {
        let mut bright = [4.0, 4.0, 4.0, 1.0];
        let mut dimmer = [1.0, 1.0, 1.0, 1.0];
        encode_preview_pixels(&mut bright, &ColorSpace::DisplayP3);
        encode_preview_pixels(&mut dimmer, &ColorSpace::DisplayP3);

        assert!(bright[0] > dimmer[0]);
        assert!(bright[1] > dimmer[1]);
        assert!(bright[2] > dimmer[2]);
    }

    #[test]
    fn display_preview_u8_path_only_clamps_at_quantization() {
        let mut pixel = [0.25, 0.25, 0.25, 1.0];
        encode_preview_pixels(&mut pixel, &ColorSpace::Srgb);
        let encoded = rgba_display_f32_to_u8(&pixel);

        assert!(pixel[0] > 0.25);
        assert_eq!(encoded[3], 255);
    }

    async fn renderer_or_skip() -> Option<Renderer> {
        match Renderer::new().await {
            Ok(renderer) => Some(renderer),
            Err(error) if error.to_string().contains("No suitable wgpu adapter found") => {
                eprintln!("skipping GPU test: {error}");
                None
            }
            Err(error) => panic!("failed to create renderer: {error}"),
        }
    }

    #[tokio::test]
    async fn second_adjustment_layer_preserves_hdr_highlight_separation() {
        let Some(renderer) = renderer_or_skip().await else {
            return;
        };

        let mut stack = LayerStack::new();
        stack.add_image_layer(1, 2, 1);
        stack.add_adjustment_layer(vec![AdjustmentOp::Tone {
            exposure: -2.0,
            contrast: 0.0,
            blacks: 0.0,
            whites: 0.0,
            highlights: 0.0,
            shadows: 0.0,
            gamma: 1.0,
        }]);
        stack.add_adjustment_layer(Vec::new());

        let mut image_sources = HashMap::new();
        image_sources.insert(
            1,
            FloatImage {
                width: 2,
                height: 1,
                pixels: vec![2.0, 0.0, 0.0, 1.0, 4.0, 0.0, 0.0, 1.0],
            },
        );

        let texture = renderer
            .render_stack_preview_texture(&stack, &image_sources, 2, 1, 2, 1, None)
            .expect("render stack preview texture");
        let pixels = renderer
            .readback_work_texture_to_f32(&texture, 2, 1)
            .await
            .expect("read back preview texture");

        let left = pixels[0];
        let right = pixels[4];

        assert!(
            left < right,
            "expected second adjustment layer to preserve highlight ordering, got left={left}, right={right}"
        );
        assert!(
            right > 0.9,
            "expected brighter highlight to stay above SDR white after two adjustment layers, got {right}"
        );
    }
}

/// Round `value` up to the nearest multiple of `alignment`.
#[inline]
fn align_up(value: u32, alignment: u32) -> u32 {
    (value + alignment - 1) & !(alignment - 1)
}
