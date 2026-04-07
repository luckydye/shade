use anyhow::Result;
use futures_channel::oneshot;
use half::f16;
use shade_lib::{
    AdjustmentOp, ColorMatrix3x3, ColorSpace, FloatImage, Layer, LayerStack, TextureId,
    ToneParams,
};
use std::collections::HashMap;
use std::sync::OnceLock;
use wgpu::{
    BufferDescriptor, BufferUsages, Extent3d, ImageCopyBuffer, ImageCopyTexture,
    ImageDataLayout, MapMode, Origin3d, TextureAspect, TextureDescriptor,
    TextureDimension, TextureUsages,
};

use crate::{
    color_transform::{ColorTransformPipeline, ColorTransformUniform},
    composite::{
        create_rw_mask_texture, upload_mask_texture, BrushStampPipeline,
        BrushStampUniform, CompositePipeline, CompositeUniform,
    },
    denoise::DenoisePipeline,
    pipelines::{
        ColorPipeline, CropPipeline, CropUniform, CurvesPipeline, EffectSpace,
        GlowPipeline, GrainPipeline, HslPipeline, LsCurvePipeline, SharpenPipeline,
        VignettePipeline,
    },
    sharpen2::SharpenTwoPassPipeline,
    texture_cache::TextureCache,
    GpuContext, TonePipeline, INTERNAL_TEXTURE_FORMAT,
};

const PREVIEW_SRGB_LUT_SIZE: usize = 8192;

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
    pub ls_curve_pipeline: LsCurvePipeline,
    pub color_pipeline: ColorPipeline,
    pub vignette_pipeline: VignettePipeline,
    pub sharpen_pipeline: SharpenPipeline,
    pub grain_pipeline: GrainPipeline,
    pub glow_pipeline: GlowPipeline,
    pub hsl_pipeline: HslPipeline,
    pub crop_pipeline: CropPipeline,
    pub composite_pipeline: CompositePipeline,
    pub brush_stamp_pipeline: Option<BrushStampPipeline>,
    pub sharpen2_pipeline: SharpenTwoPassPipeline,
    pub denoise_pipeline: DenoisePipeline,
    pub texture_cache: TextureCache,
    pub color_transform_pipeline: ColorTransformPipeline,
}

impl Renderer {
    /// Create a new headless renderer, initialising the GPU context and compiling all shaders.
    pub async fn new() -> Result<Self> {
        let ctx = GpuContext::new_headless().await?;
        let tone_pipeline = TonePipeline::new(&ctx)?;
        let curves_pipeline = CurvesPipeline::new(&ctx)?;
        let ls_curve_pipeline = LsCurvePipeline::new(&ctx)?;
        let color_pipeline = ColorPipeline::new(&ctx)?;
        let vignette_pipeline = VignettePipeline::new(&ctx)?;
        let sharpen_pipeline = SharpenPipeline::new(&ctx)?;
        let grain_pipeline = GrainPipeline::new(&ctx)?;
        let glow_pipeline = GlowPipeline::new(&ctx)?;
        let hsl_pipeline = HslPipeline::new(&ctx)?;
        let crop_pipeline = CropPipeline::new(&ctx)?;
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
        let sharpen2_pipeline = SharpenTwoPassPipeline::new(&ctx);
        let denoise_pipeline = DenoisePipeline::new(&ctx);
        let texture_cache = TextureCache::new();
        let color_transform_pipeline = ColorTransformPipeline::new(&ctx);
        Ok(Self {
            ctx,
            tone_pipeline,
            curves_pipeline,
            ls_curve_pipeline,
            color_pipeline,
            vignette_pipeline,
            sharpen_pipeline,
            grain_pipeline,
            glow_pipeline,
            hsl_pipeline,
            crop_pipeline,
            composite_pipeline,
            brush_stamp_pipeline,
            sharpen2_pipeline,
            denoise_pipeline,
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
        let input_tex = self.upload_float_texture(
            &u8_rgba_to_f32(input_data),
            width,
            height,
            "input texture",
        );
        let final_tex = self.render_texture_with_ops(
            &input_tex,
            ops,
            (0.0, 0.0),
            (1.0, 1.0),
            full_texture_effect_space(&input_tex),
            None,
        )?;
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
        let input_tex =
            self.upload_float_texture(input_data, width, height, "input texture");
        let final_tex = self.render_texture_with_ops(
            &input_tex,
            ops,
            (0.0, 0.0),
            (1.0, 1.0),
            full_texture_effect_space(&input_tex),
            None,
        )?;
        self.readback_work_texture_to_f32(&final_tex, width, height)
            .await
    }

    /// Process a single video frame through the adjustment pipeline.
    ///
    /// `frame_index` is used to seed per-frame grain variation so that film grain
    /// is temporally animated rather than frozen across all frames.
    /// Returns RGBA8 (u8) pixels ready for a video encoder.
    pub async fn render_frame(
        &self,
        input_data: &[f32],
        width: u32,
        height: u32,
        ops: &[AdjustmentOp],
        frame_index: u64,
    ) -> Result<Vec<u8>> {
        let input_tex =
            self.upload_float_texture(input_data, width, height, "frame input");
        let final_tex = self.render_texture_with_ops(
            &input_tex,
            ops,
            (0.0, 0.0),
            (1.0, 1.0),
            full_texture_effect_space(&input_tex),
            Some(frame_index),
        )?;
        self.readback_work_texture_to_u8(&final_tex, width, height)
            .await
    }

    fn render_texture_with_ops(
        &self,
        input_tex: &wgpu::Texture,
        ops: &[AdjustmentOp],
        // Full-image UV offset/scale for vignette (use (0,0)/(1,1) when no crop).
        vignette_uv_offset: (f32, f32),
        vignette_uv_scale: (f32, f32),
        effect_space: EffectSpace,
        // Video frame index for temporal grain variation. None for single-image rendering.
        frame_index: Option<u64>,
    ) -> Result<wgpu::Texture> {
        let mut current_tex: &wgpu::Texture = input_tex;
        let mut owned_textures: Vec<wgpu::Texture> = Vec::new();
        for op in ops {
            let output = match op {
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
                    control_points: _,
                } => self.curves_pipeline.process(
                    &self.ctx,
                    current_tex,
                    lut_r,
                    lut_g,
                    lut_b,
                    lut_master,
                    *per_channel,
                )?,
                AdjustmentOp::LsCurve {
                    lut,
                    control_points: _,
                } => self
                    .ls_curve_pipeline
                    .process(&self.ctx, current_tex, lut)?,
                AdjustmentOp::Color(params) => {
                    self.color_pipeline
                        .process(&self.ctx, current_tex, *params)?
                }
                AdjustmentOp::Vignette(params) => self.vignette_pipeline.process(
                    &self.ctx,
                    current_tex,
                    *params,
                    vignette_uv_offset,
                    vignette_uv_scale,
                )?,
                AdjustmentOp::Sharpen(params) => self.sharpen2_pipeline.process(
                    &self.ctx,
                    current_tex,
                    *params,
                    effect_space,
                ),
                AdjustmentOp::Grain(params) => {
                    let mut grain = *params;
                    // Modulate seed per-frame so grain varies temporally in video.
                    // Without this every frame would share identical noise (frozen grain).
                    if let Some(fi) = frame_index {
                        grain.seed += fi as f32 * 0.12345678;
                    }
                    self.grain_pipeline.process(
                        &self.ctx,
                        current_tex,
                        grain,
                        effect_space,
                    )?
                }
                AdjustmentOp::Glow(params) => self.glow_pipeline.process(
                    &self.ctx,
                    current_tex,
                    *params,
                    effect_space,
                )?,
                AdjustmentOp::Hsl(params) => {
                    self.hsl_pipeline.process(&self.ctx, current_tex, *params)?
                }
                AdjustmentOp::Denoise(params) => self.denoise_pipeline.process(
                    &self.ctx,
                    current_tex,
                    *params,
                    effect_space,
                ),
            };
            owned_textures.push(output);
            current_tex = owned_textures.last().unwrap();
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
        let pixels = self
            .readback_work_texture_to_f32(&final_accum, target_width, target_height)
            .await?;
        Ok(encode_preview_pixels_to_srgb_u8(&pixels))
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
        let mut current_view = crop.clone();
        let mut post_crop_view = PreviewCrop {
            x: 0.0,
            y: 0.0,
            width: canvas_width as f32,
            height: canvas_height as f32,
        };

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

        // Tracks which layer index had an ordered prefix of safe ops pre-applied to the
        // full-resolution source image, and how many ops from that prefix must be
        // skipped in the preview-sized pass.
        let mut pre_applied_adj: Option<(usize, usize)> = None;

        // Full-resolution source texture for the most recent image layer.
        // Used by rotated crop layers so they can sample the complete canvas
        // instead of the viewport-cropped accumulator.
        // Stores: (source_size, raw_source_arc, optional_preprocessed_textures)
        let mut full_res_source: Option<(
            wgpu::Extent3d,
            std::sync::Arc<wgpu::Texture>,
            Vec<wgpu::Texture>,
        )> = None;

        // 2. For each visible layer, composite it onto the accumulator.
        for (idx, entry) in stack.layers.iter().enumerate() {
            if !entry.visible {
                continue;
            }

            let current_accum = accum_owned.last().unwrap();

            // 2a. Compute layer result texture.
            let layer_result: wgpu::Texture = match &entry.layer {
                Layer::Image { texture_id, .. } => {
                    if let Some(image) = image_sources.get(texture_id) {
                        let source_texture =
                            self.texture_cache.get_or_insert_with(*texture_id, || {
                                self.upload_float_texture(
                                    &image.pixels,
                                    image.width,
                                    image.height,
                                    "cached image layer texture",
                                )
                            });

                        // Pre-apply the longest ordered prefix of ops that is safe to run on
                        // the full-resolution source before crop/downscale. This preserves the
                        // relative order of Tone/Color/Curves/HSL with Glow/Sharpen/Denoise,
                        // so the preview tile matches export for stacks like Tone -> Glow.
                        // Look ahead for the immediately next visible Layer::Adjustment.
                        let next_adj = stack.layers[idx + 1..]
                            .iter()
                            .enumerate()
                            .find(|(_, e)| {
                                e.visible
                                    && e.mask.is_none()
                                    && e.opacity == 1.0
                                    && e.blend_mode == shade_lib::BlendMode::Normal
                                    && matches!(e.layer, Layer::Adjustment { .. })
                            })
                            .map(|(j, e)| (idx + 1 + j, e));

                        let mut preprocess_owned: Vec<wgpu::Texture> = Vec::new();
                        if let Some((adj_idx, adj_entry)) = next_adj {
                            if let Layer::Adjustment { ops } = &adj_entry.layer {
                                let mut pre_applied_op_count = 0usize;
                                for op in ops.iter() {
                                    let tex_in = preprocess_owned
                                        .last()
                                        .map(|t| t as &wgpu::Texture)
                                        .unwrap_or(&*source_texture);
                                    let output = match op {
                                        AdjustmentOp::Tone {
                                            exposure,
                                            contrast,
                                            blacks,
                                            whites,
                                            highlights,
                                            shadows,
                                            gamma,
                                        } => Some(self.tone_pipeline.process(
                                            &self.ctx,
                                            tex_in,
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
                                        )?),
                                        AdjustmentOp::Curves {
                                            lut_r,
                                            lut_g,
                                            lut_b,
                                            lut_master,
                                            per_channel,
                                            control_points: _,
                                        } => Some(self.curves_pipeline.process(
                                            &self.ctx,
                                            tex_in,
                                            lut_r,
                                            lut_g,
                                            lut_b,
                                            lut_master,
                                            *per_channel,
                                        )?),
                                        AdjustmentOp::LsCurve {
                                            lut,
                                            control_points: _,
                                        } => Some(
                                            self.ls_curve_pipeline
                                                .process(&self.ctx, tex_in, lut)?,
                                        ),
                                        AdjustmentOp::Color(params) => Some(
                                            self.color_pipeline
                                                .process(&self.ctx, tex_in, *params)?,
                                        ),
                                        AdjustmentOp::Hsl(params) => Some(
                                            self.hsl_pipeline
                                                .process(&self.ctx, tex_in, *params)?,
                                        ),
                                        AdjustmentOp::Denoise(params) => {
                                            if params.luma_strength > 0.0
                                                || params.chroma_strength > 0.0
                                            {
                                                let effect_space =
                                                    texture_to_reference_effect_space(
                                                        tex_in.size().width,
                                                        tex_in.size().height,
                                                        canvas_width,
                                                        canvas_height,
                                                    );
                                                Some(self.denoise_pipeline.process(
                                                    &self.ctx,
                                                    tex_in,
                                                    *params,
                                                    effect_space,
                                                ))
                                            } else {
                                                None
                                            }
                                        }
                                        AdjustmentOp::Sharpen(params) => {
                                            if params.amount > 0.0 {
                                                let effect_space =
                                                    texture_to_reference_effect_space(
                                                        tex_in.size().width,
                                                        tex_in.size().height,
                                                        canvas_width,
                                                        canvas_height,
                                                    );
                                                Some(self.sharpen2_pipeline.process(
                                                    &self.ctx,
                                                    tex_in,
                                                    *params,
                                                    effect_space,
                                                ))
                                            } else {
                                                None
                                            }
                                        }
                                        AdjustmentOp::Glow(params) => {
                                            if params.amount > 0.0 {
                                                let effect_space =
                                                    texture_to_reference_effect_space(
                                                        tex_in.size().width,
                                                        tex_in.size().height,
                                                        canvas_width,
                                                        canvas_height,
                                                    );
                                                Some(self.glow_pipeline.process(
                                                    &self.ctx,
                                                    tex_in,
                                                    *params,
                                                    effect_space,
                                                )?)
                                            } else {
                                                None
                                            }
                                        }
                                        AdjustmentOp::Vignette(_)
                                        | AdjustmentOp::Grain(_) => {
                                            break;
                                        }
                                    };
                                    if let Some(output) = output {
                                        preprocess_owned.push(output);
                                    }
                                    pre_applied_op_count += 1;
                                }
                                if pre_applied_op_count > 0 {
                                    pre_applied_adj =
                                        Some((adj_idx, pre_applied_op_count));
                                }
                            }
                        }

                        let crop_input = preprocess_owned
                            .last()
                            .map(|t| t as &wgpu::Texture)
                            .unwrap_or(&*source_texture);
                        let src_size = crop_input.size();
                        let image_result = self.crop_pipeline.process_to_size(
                            &self.ctx,
                            crop_input,
                            target_width,
                            target_height,
                            CropUniform {
                                out_x: current_view.x,
                                out_y: current_view.y,
                                out_width: current_view.width,
                                out_height: current_view.height,
                                pivot_x: 0.0,
                                pivot_y: 0.0,
                                in_x: 0.0,
                                in_y: 0.0,
                                in_width: src_size.width as f32,
                                in_height: src_size.height as f32,
                                cos_r: 1.0,
                                sin_r: 0.0,
                            },
                        )?;
                        full_res_source =
                            Some((src_size, source_texture.clone(), preprocess_owned));
                        image_result
                    } else {
                        // No source image: skip this layer.
                        continue;
                    }
                }
                Layer::Crop { rect } => {
                    let prev_view = current_view.clone();
                    if rect.rotation != 0.0 {
                        post_crop_view = PreviewCrop {
                            x: rect.x,
                            y: rect.y,
                            width: rect.width,
                            height: rect.height,
                        };
                        // For rotation: the output texture represents prev_view (the viewport).
                        // out_* must be prev_view so each output pixel maps to its correct canvas
                        // coordinate. current_view is not updated — the accumulator still covers
                        // prev_view after this layer.
                        if let Some((src_size, ref raw_source, ref preprocess)) =
                            full_res_source
                        {
                            let src_tex = preprocess
                                .last()
                                .map(|t| t as &wgpu::Texture)
                                .unwrap_or(&**raw_source);
                            self.crop_pipeline.process_to_size(
                                &self.ctx,
                                src_tex,
                                target_width,
                                target_height,
                                CropUniform {
                                    out_x: prev_view.x,
                                    out_y: prev_view.y,
                                    out_width: prev_view.width,
                                    out_height: prev_view.height,
                                    pivot_x: rect.x + rect.width * 0.5,
                                    pivot_y: rect.y + rect.height * 0.5,
                                    in_x: 0.0,
                                    in_y: 0.0,
                                    in_width: src_size.width as f32,
                                    in_height: src_size.height as f32,
                                    cos_r: rect.rotation.cos(),
                                    sin_r: rect.rotation.sin(),
                                },
                            )?
                        } else {
                            // No source image — fall back to accumulator.
                            self.crop_pipeline.process(
                                &self.ctx,
                                current_accum,
                                CropUniform {
                                    out_x: prev_view.x,
                                    out_y: prev_view.y,
                                    out_width: prev_view.width,
                                    out_height: prev_view.height,
                                    pivot_x: rect.x + rect.width * 0.5,
                                    pivot_y: rect.y + rect.height * 0.5,
                                    in_x: prev_view.x,
                                    in_y: prev_view.y,
                                    in_width: prev_view.width,
                                    in_height: prev_view.height,
                                    cos_r: rect.rotation.cos(),
                                    sin_r: rect.rotation.sin(),
                                },
                            )?
                        }
                    } else {
                        current_view = PreviewCrop {
                            x: rect.x,
                            y: rect.y,
                            width: rect.width,
                            height: rect.height,
                        };
                        post_crop_view = current_view.clone();
                        self.crop_pipeline.process(
                            &self.ctx,
                            current_accum,
                            CropUniform {
                                out_x: rect.x,
                                out_y: rect.y,
                                out_width: rect.width,
                                out_height: rect.height,
                                pivot_x: rect.x + rect.width * 0.5,
                                pivot_y: rect.y + rect.height * 0.5,
                                in_x: prev_view.x,
                                in_y: prev_view.y,
                                in_width: prev_view.width,
                                in_height: prev_view.height,
                                cos_r: 1.0,
                                sin_r: 0.0,
                            },
                        )?
                    }
                }
                Layer::Adjustment { ops } => {
                    // Post-crop effects use the logical crop frame from the stack.
                    // Preview tiles are just a window into that frame, not a crop of their own.
                    let (vignette_uv_offset, vignette_uv_scale) =
                        view_uv_mapping(&current_view, &post_crop_view);
                    let pre_applied_op_count = match pre_applied_adj {
                        Some((adj_idx, op_count)) if adj_idx == idx => op_count,
                        _ => 0,
                    };
                    let effect_space = preview_effect_space(
                        &current_view,
                        current_accum.size().width,
                        current_accum.size().height,
                        canvas_width,
                        canvas_height,
                    );
                    self.render_texture_with_ops(
                        current_accum,
                        &ops[pre_applied_op_count..],
                        vignette_uv_offset,
                        vignette_uv_scale,
                        effect_space,
                        None,
                    )?
                }
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
        let brush_stamp_pipeline =
            self.brush_stamp_pipeline.as_ref().ok_or_else(|| {
                anyhow::anyhow!("brush stamping is unavailable on this GPU backend")
            })?;
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
        let mut encoder =
            device.create_command_encoder(&wgpu::CommandEncoderDescriptor {
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
        let (tx, rx) = oneshot::channel();
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

        let mut encoder =
            device.create_command_encoder(&wgpu::CommandEncoderDescriptor {
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
        let (tx, rx) = oneshot::channel();
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
        let mut encoder =
            device.create_command_encoder(&wgpu::CommandEncoderDescriptor {
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
        let (tx, rx) = oneshot::channel();
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

fn full_texture_effect_space(texture: &wgpu::Texture) -> EffectSpace {
    let size = texture.size();
    texture_to_reference_effect_space(size.width, size.height, size.width, size.height)
}

fn texture_to_reference_effect_space(
    texture_width: u32,
    texture_height: u32,
    reference_width: u32,
    reference_height: u32,
) -> EffectSpace {
    EffectSpace {
        origin_x: 0.0,
        origin_y: 0.0,
        step_x: reference_width as f32 / texture_width as f32,
        step_y: reference_height as f32 / texture_height as f32,
        reference_width: reference_width as f32,
        reference_height: reference_height as f32,
    }
}

fn preview_effect_space(
    view: &PreviewCrop,
    output_width: u32,
    output_height: u32,
    reference_width: u32,
    reference_height: u32,
) -> EffectSpace {
    EffectSpace {
        origin_x: view.x,
        origin_y: view.y,
        step_x: view.width / output_width as f32,
        step_y: view.height / output_height as f32,
        reference_width: reference_width as f32,
        reference_height: reference_height as f32,
    }
}

fn view_uv_mapping(
    sampled_view: &PreviewCrop,
    frame_view: &PreviewCrop,
) -> ((f32, f32), (f32, f32)) {
    assert!(frame_view.width > 0.0, "frame_view.width must be > 0");
    assert!(frame_view.height > 0.0, "frame_view.height must be > 0");
    (
        (
            (sampled_view.x - frame_view.x) / frame_view.width,
            (sampled_view.y - frame_view.y) / frame_view.height,
        ),
        (
            sampled_view.width / frame_view.width,
            sampled_view.height / frame_view.height,
        ),
    )
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
            let src_x =
                sample_position(x, target_width, crop.x, crop.width, source_width);
            let x0 = src_x.round().clamp(0.0, (source_width - 1) as f32) as u32;
            output[(y * target_width + x) as usize] =
                pixels[(y0 * source_width + x0) as usize];
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

fn encode_preview_pixels_to_srgb_u8(pixels: &[f32]) -> Vec<u8> {
    let lut = preview_srgb_lut();
    let mut encoded = Vec::with_capacity(pixels.len());
    for pixel in pixels.chunks_exact(4) {
        encoded.push(linear_to_srgb_u8(pixel[0], lut));
        encoded.push(linear_to_srgb_u8(pixel[1], lut));
        encoded.push(linear_to_srgb_u8(pixel[2], lut));
        encoded.push((pixel[3].clamp(0.0, 1.0) * 255.0).round() as u8);
    }
    encoded
}

fn encode_preview_rgb(rgb: [f32; 3], dst: &ColorSpace) -> [f32; 3] {
    match dst {
        ColorSpace::DisplayP3 => encode_linear_rgb_to_display_p3(
            rgb,
            &ColorMatrix3x3::LINEAR_SRGB_TO_DISPLAY_P3,
        ),
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

fn linear_to_srgb_u8(value: f32, lut: &[f32; PREVIEW_SRGB_LUT_SIZE + 1]) -> u8 {
    let clamped = value.clamp(0.0, 1.0);
    let scaled = clamped * PREVIEW_SRGB_LUT_SIZE as f32;
    let index = scaled as usize;
    let fraction = scaled - index as f32;
    let lower = lut[index];
    let upper = lut[index.min(PREVIEW_SRGB_LUT_SIZE - 1) + 1];
    ((lower + (upper - lower) * fraction) * 255.0).round() as u8
}

fn preview_srgb_lut() -> &'static [f32; PREVIEW_SRGB_LUT_SIZE + 1] {
    static LUT: OnceLock<[f32; PREVIEW_SRGB_LUT_SIZE + 1]> = OnceLock::new();
    LUT.get_or_init(|| {
        std::array::from_fn(|index| {
            linear_to_srgb_display(index as f32 / PREVIEW_SRGB_LUT_SIZE as f32)
        })
    })
}

#[cfg(test)]
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
        rgba_display_f32_to_u8, view_uv_mapping, FloatImage, PreviewCrop, Renderer,
    };
    use shade_lib::{
        AdjustmentOp, ColorSpace, CropRect, GlowParams, LayerStack, MaskData, TextureId,
        VignetteParams,
    };
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
    fn view_uv_mapping_uses_post_crop_frame_not_preview_tile() {
        let sampled_view = PreviewCrop {
            x: 3.0,
            y: 4.0,
            width: 2.0,
            height: 3.0,
        };
        let frame_view = PreviewCrop {
            x: 2.0,
            y: 2.0,
            width: 8.0,
            height: 10.0,
        };

        let (offset, scale) = view_uv_mapping(&sampled_view, &frame_view);

        assert_eq!(offset, (0.125, 0.2));
        assert_eq!(scale, (0.25, 0.3));
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
            Err(error)
                if error.to_string().contains("No suitable wgpu adapter found") =>
            {
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
                pixels: vec![2.0, 0.0, 0.0, 1.0, 4.0, 0.0, 0.0, 1.0].into(),
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

    #[tokio::test]
    async fn masked_adjustment_only_affects_unmasked_pixels() {
        let Some(renderer) = renderer_or_skip().await else {
            return;
        };

        let make_sources = || {
            let mut image_sources = HashMap::new();
            image_sources.insert(
                1,
                FloatImage {
                    width: 1,
                    height: 2,
                    pixels: vec![0.25, 0.25, 0.25, 1.0, 0.25, 0.25, 0.25, 1.0].into(),
                },
            );
            image_sources
        };

        let baseline_stack = {
            let mut stack = LayerStack::new();
            stack.add_image_layer(1, 1, 2);
            stack
        };
        let unmasked_stack = {
            let mut stack = LayerStack::new();
            stack.add_image_layer(1, 1, 2);
            stack.add_adjustment_layer(vec![AdjustmentOp::Tone {
                exposure: 2.0,
                contrast: 0.0,
                blacks: 0.0,
                whites: 0.0,
                highlights: 0.0,
                shadows: 0.0,
                gamma: 1.0,
            }]);
            stack
        };
        let masked_stack = {
            let mut stack = unmasked_stack.clone();
            stack.set_mask(
                1,
                MaskData {
                    width: 1,
                    height: 2,
                    pixels: vec![0, 255],
                },
            );
            stack
        };

        let baseline_tex = renderer
            .render_stack_preview_texture(
                &baseline_stack,
                &make_sources(),
                1,
                2,
                1,
                2,
                None,
            )
            .expect("baseline render");
        let baseline = renderer
            .readback_work_texture_to_f32(&baseline_tex, 1, 2)
            .await
            .expect("baseline readback");

        let unmasked_tex = renderer
            .render_stack_preview_texture(
                &unmasked_stack,
                &make_sources(),
                1,
                2,
                1,
                2,
                None,
            )
            .expect("unmasked render");
        let unmasked = renderer
            .readback_work_texture_to_f32(&unmasked_tex, 1, 2)
            .await
            .expect("unmasked readback");

        let masked_tex = renderer
            .render_stack_preview_texture(
                &masked_stack,
                &make_sources(),
                1,
                2,
                1,
                2,
                None,
            )
            .expect("masked render");
        let masked = renderer
            .readback_work_texture_to_f32(&masked_tex, 1, 2)
            .await
            .expect("masked readback");

        let top_baseline = baseline[0];
        let top_unmasked = unmasked[0];
        let top_masked = masked[0];
        let bottom_baseline = baseline[4];
        let bottom_unmasked = unmasked[4];
        let bottom_masked = masked[4];

        assert!(
            (top_masked - top_baseline).abs() < (top_unmasked - top_baseline).abs() * 0.25,
            "top pixel should stay near baseline when mask is zero: baseline={top_baseline}, masked={top_masked}, unmasked={top_unmasked}"
        );
        assert!(
            (bottom_masked - bottom_unmasked).abs() < (bottom_unmasked - bottom_baseline).abs() * 0.25,
            "bottom pixel should stay near unmasked result when mask is one: baseline={bottom_baseline}, masked={bottom_masked}, unmasked={bottom_unmasked}"
        );
    }

    #[tokio::test]
    async fn preview_crop_extracts_only_the_requested_region() {
        let Some(renderer) = renderer_or_skip().await else {
            return;
        };

        let mut stack = LayerStack::new();
        stack.add_image_layer(1, 4, 2);

        let mut image_sources = HashMap::new();
        image_sources.insert(
            1,
            FloatImage {
                width: 4,
                height: 2,
                pixels: vec![
                    10.0, 0.0, 0.0, 1.0, 20.0, 0.0, 0.0, 1.0, 30.0, 0.0, 0.0, 1.0, 40.0,
                    0.0, 0.0, 1.0, 50.0, 0.0, 0.0, 1.0, 60.0, 0.0, 0.0, 1.0, 70.0, 0.0,
                    0.0, 1.0, 80.0, 0.0, 0.0, 1.0,
                ]
                .into(),
            },
        );

        let texture = renderer
            .render_stack_preview_texture(
                &stack,
                &image_sources,
                4,
                2,
                2,
                2,
                Some(PreviewCrop {
                    x: 2.0,
                    y: 0.0,
                    width: 2.0,
                    height: 2.0,
                }),
            )
            .expect("render stack preview texture");
        let pixels = renderer
            .readback_work_texture_to_f32(&texture, 2, 2)
            .await
            .expect("read back preview texture");

        assert_eq!(
            pixels,
            vec![
                30.0, 0.0, 0.0, 1.0, 40.0, 0.0, 0.0, 1.0, 70.0, 0.0, 0.0, 1.0, 80.0, 0.0,
                0.0, 1.0,
            ]
        );
    }

    /// Build a 4×4 image where each pixel's R channel encodes its (col, row) as
    /// `R = row * 4 + col + 1` (values 1..16). G=B=0, A=1.
    fn make_4x4_source() -> (LayerStack, HashMap<TextureId, FloatImage>) {
        let mut pixels = Vec::with_capacity(4 * 4 * 4);
        for row in 0..4u32 {
            for col in 0..4u32 {
                pixels.push((row * 4 + col + 1) as f32); // R
                pixels.push(0.0); // G
                pixels.push(0.0); // B
                pixels.push(1.0); // A
            }
        }
        let mut stack = LayerStack::new();
        stack.add_image_layer(1, 4, 4);
        let mut sources = HashMap::new();
        sources.insert(
            1,
            FloatImage {
                width: 4,
                height: 4,
                pixels: pixels.into(),
            },
        );
        (stack, sources)
    }

    fn r_channels(pixels: &[f32]) -> Vec<f32> {
        pixels.chunks(4).map(|px| px[0]).collect()
    }

    /// Crop layer at full resolution: target=canvas=4×4, crop to right half.
    /// Source R channel:  1  2  3  4 / 5  6  7  8 / 9 10 11 12 / 13 14 15 16
    /// Crop x=2,y=0,w=2,h=4 → columns 2-3 stretched to 4 output columns.
    /// At the native crop resolution (2×4 target) the crop is 1:1 with source pixels.
    #[tokio::test]
    async fn crop_layer_full_resolution() {
        let Some(renderer) = renderer_or_skip().await else {
            return;
        };
        let (mut stack, sources) = make_4x4_source();
        stack.add_crop_layer(CropRect {
            x: 2.0,
            y: 0.0,
            width: 2.0,
            height: 4.0,
            rotation: 0.0,
        });

        // Render at the crop's native resolution: 2×4 target for a 2×4 crop.
        let texture = renderer
            .render_stack_preview_texture(&stack, &sources, 4, 4, 2, 4, None)
            .expect("render");
        let pixels = renderer
            .readback_work_texture_to_f32(&texture, 2, 4)
            .await
            .expect("readback");
        let r = r_channels(&pixels);

        // Expect source columns 2-3: [3,4, 7,8, 11,12, 15,16].
        let expected = [3.0, 4.0, 7.0, 8.0, 11.0, 12.0, 15.0, 16.0];
        for (i, (got, want)) in r.iter().zip(expected.iter()).enumerate() {
            let diff = (got - want).abs();
            assert!(diff < 0.6, "pixel {i}: expected {want}, got {got}");
        }
    }

    /// Crop applied at preview resolution (downscaled target) must sample from the
    /// correct region of the original canvas, producing the same visual result as the
    /// full-res render (just at lower resolution).
    #[tokio::test]
    async fn crop_layer_at_preview_resolution_matches_full_res() {
        let Some(renderer) = renderer_or_skip().await else {
            return;
        };
        let (mut stack, sources) = make_4x4_source();
        stack.add_crop_layer(CropRect {
            x: 2.0,
            y: 0.0,
            width: 2.0,
            height: 4.0,
            rotation: 0.0,
        });

        // Preview: canvas=4×4, target=2×2 (half res).
        let texture = renderer
            .render_stack_preview_texture(&stack, &sources, 4, 4, 2, 2, None)
            .expect("render");
        let pixels = renderer
            .readback_work_texture_to_f32(&texture, 2, 2)
            .await
            .expect("readback");
        let r = r_channels(&pixels);

        // The 2×2 preview of the crop (cols 2-3, rows 0-3) should show:
        // top-left ≈ avg of source pixels {3,4,7,8} = 5.5
        // top-right ≈ same column range, still within [3,8]
        // All values must come from the right half (cols 2-3).
        for (i, val) in r.iter().enumerate() {
            assert!(
                *val >= 3.0 - 0.01 && *val <= 16.0 + 0.01,
                "pixel {i}: expected R from crop region (>=3), got {val}"
            );
        }
        // More specifically, top row values should be < bottom row values.
        assert!(
            r[0] < r[2] && r[1] < r[3],
            "top row should be dimmer than bottom: top={:?}, bottom={:?}",
            &r[..2],
            &r[2..]
        );
    }

    /// When a preview crop (zoomed-in view) is active AND there is a crop layer,
    /// the crop transform must be applied relative to the original canvas coordinates.
    /// This is the core scenario: preview shows a sub-region, crop is in canvas space.
    #[tokio::test]
    async fn crop_layer_with_preview_crop_uses_canvas_coordinates() {
        let Some(renderer) = renderer_or_skip().await else {
            return;
        };
        let (mut stack, sources) = make_4x4_source();
        // Crop to bottom-right 2×2 (canvas coords: x=2, y=2, w=2, h=2).
        stack.add_crop_layer(CropRect {
            x: 2.0,
            y: 2.0,
            width: 2.0,
            height: 2.0,
            rotation: 0.0,
        });

        // Full-res render for reference.
        let tex_full = renderer
            .render_stack_preview_texture(&stack, &sources, 4, 4, 2, 2, None)
            .expect("full-res render");
        let px_full = renderer
            .readback_work_texture_to_f32(&tex_full, 2, 2)
            .await
            .expect("readback");
        let r_full = r_channels(&px_full);

        // Preview render: preview crop = full canvas, but target = 2×2 (downscaled).
        // This should produce the same result as the full-res path at 2×2.
        let tex_preview = renderer
            .render_stack_preview_texture(
                &stack,
                &sources,
                4,
                4,
                2,
                2,
                Some(PreviewCrop {
                    x: 0.0,
                    y: 0.0,
                    width: 4.0,
                    height: 4.0,
                }),
            )
            .expect("preview render");
        let px_preview = renderer
            .readback_work_texture_to_f32(&tex_preview, 2, 2)
            .await
            .expect("readback");
        let r_preview = r_channels(&px_preview);

        // Both renders cover the same canvas region at the same target size.
        // Results must be identical.
        assert_eq!(
            r_full, r_preview,
            "full-res and explicit full-canvas preview must match:\nfull={r_full:?}\npreview={r_preview:?}"
        );
    }

    /// When the preview crop exactly covers the crop region at native resolution,
    /// the result must match a render without a preview crop at the same target size.
    /// This is the key invariant: the crop transform is applied in canvas coordinates
    /// regardless of what preview region is active.
    #[tokio::test]
    async fn crop_layer_with_zoomed_preview_shows_correct_region() {
        let Some(renderer) = renderer_or_skip().await else {
            return;
        };
        let (mut stack, sources) = make_4x4_source();
        // Crop to right half: x=2, y=0, w=2, h=4.
        stack.add_crop_layer(CropRect {
            x: 2.0,
            y: 0.0,
            width: 2.0,
            height: 4.0,
            rotation: 0.0,
        });

        // Render WITHOUT preview crop at native crop resolution (2×4).
        let tex_no_crop = renderer
            .render_stack_preview_texture(&stack, &sources, 4, 4, 2, 4, None)
            .expect("render without preview crop");
        let px_no_crop = renderer
            .readback_work_texture_to_f32(&tex_no_crop, 2, 4)
            .await
            .expect("readback");
        let r_no_crop = r_channels(&px_no_crop);

        // Render WITH preview crop covering the crop region at same resolution.
        let tex_with_crop = renderer
            .render_stack_preview_texture(
                &stack,
                &sources,
                4,
                4,
                2,
                4,
                Some(PreviewCrop {
                    x: 2.0,
                    y: 0.0,
                    width: 2.0,
                    height: 4.0,
                }),
            )
            .expect("render with preview crop");
        let px_with_crop = renderer
            .readback_work_texture_to_f32(&tex_with_crop, 2, 4)
            .await
            .expect("readback");
        let r_with_crop = r_channels(&px_with_crop);

        // Both should produce values from the crop region (source cols 2-3).
        let expected = [3.0, 4.0, 7.0, 8.0, 11.0, 12.0, 15.0, 16.0];
        for (i, want) in expected.iter().enumerate() {
            let diff_no_crop = (r_no_crop[i] - want).abs();
            let diff_with_crop = (r_with_crop[i] - want).abs();
            assert!(
                diff_no_crop < 0.6,
                "no-crop pixel {i}: expected {want}, got {}",
                r_no_crop[i]
            );
            assert!(
                diff_with_crop < 0.6,
                "with-crop pixel {i}: expected {want}, got {}",
                r_with_crop[i]
            );
        }
    }

    /// Crop with rotation: the preview render must match the full-res render.
    /// A 90° rotation of a square region should swap axes.
    #[tokio::test]
    async fn crop_with_rotation_preview_matches_full_res() {
        let Some(renderer) = renderer_or_skip().await else {
            return;
        };
        let (mut stack, sources) = make_4x4_source();
        // Crop center 2×2 region with 90° rotation.
        stack.add_crop_layer(CropRect {
            x: 1.0,
            y: 1.0,
            width: 2.0,
            height: 2.0,
            rotation: std::f32::consts::FRAC_PI_2,
        });

        // Full-res render (target = canvas = 4×4).
        let tex_full = renderer
            .render_stack_preview_texture(&stack, &sources, 4, 4, 4, 4, None)
            .expect("full render");
        let px_full = renderer
            .readback_work_texture_to_f32(&tex_full, 4, 4)
            .await
            .expect("readback");
        let r_full = r_channels(&px_full);

        // Preview render at half resolution.
        let tex_half = renderer
            .render_stack_preview_texture(&stack, &sources, 4, 4, 2, 2, None)
            .expect("half render");
        let px_half = renderer
            .readback_work_texture_to_f32(&tex_half, 2, 2)
            .await
            .expect("readback");
        let r_half = r_channels(&px_half);

        // The 2×2 preview should be a downscaled version of the 4×4 full render.
        // Average each 2×2 block of the full render and compare.
        let mut expected = Vec::with_capacity(4);
        for row in 0..2 {
            for col in 0..2 {
                let tl = r_full[(row * 2) * 4 + col * 2];
                let tr = r_full[(row * 2) * 4 + col * 2 + 1];
                let bl = r_full[(row * 2 + 1) * 4 + col * 2];
                let br = r_full[(row * 2 + 1) * 4 + col * 2 + 1];
                expected.push((tl + tr + bl + br) / 4.0);
            }
        }

        for i in 0..4 {
            let diff = (r_half[i] - expected[i]).abs();
            assert!(
                diff < 1.5,
                "pixel {i}: half_res={}, expected≈{}, diff={diff}",
                r_half[i],
                expected[i]
            );
        }
    }

    /// Rotated crop on a non-square canvas: the preview render (at lower resolution)
    /// must match the full-resolution render downscaled to the same size.
    /// On an 8×4 canvas with a square 4×4 crop + 90° rotation, the preview target
    /// of 4×4 introduces non-uniform scaling (2× horizontal, 1× vertical).
    /// The bug: rotation is applied in the non-uniformly-scaled preview space
    /// instead of the original canvas space, distorting the result.
    #[tokio::test]
    async fn crop_rotation_invariant_under_non_uniform_preview_scaling() {
        let Some(renderer) = renderer_or_skip().await else {
            return;
        };

        // 8×4 canvas. Pixel R = row * 8 + col + 1.
        let mut pixels = Vec::with_capacity(8 * 4 * 4);
        for row in 0..4u32 {
            for col in 0..8u32 {
                pixels.push((row * 8 + col + 1) as f32);
                pixels.push(0.0);
                pixels.push(0.0);
                pixels.push(1.0);
            }
        }
        let mut stack = LayerStack::new();
        stack.add_image_layer(1, 8, 4);
        // Square crop in the center with 90° rotation.
        stack.add_crop_layer(CropRect {
            x: 2.0,
            y: 0.0,
            width: 4.0,
            height: 4.0,
            rotation: std::f32::consts::FRAC_PI_2,
        });
        let mut sources: HashMap<TextureId, FloatImage> = HashMap::new();
        sources.insert(
            1,
            FloatImage {
                width: 8,
                height: 4,
                pixels: pixels.into(),
            },
        );

        // Full-res render: target = 8×4 (canvas resolution).
        // The crop operates in an 8×4 accumulator, where the crop rect's
        // target-space representation preserves the square aspect ratio (4×4).
        let tex_full = renderer
            .render_stack_preview_texture(&stack, &sources, 8, 4, 8, 4, None)
            .expect("full-res render");
        let px_full = renderer
            .readback_work_texture_to_f32(&tex_full, 8, 4)
            .await
            .expect("readback");

        // Downsample the full-res result to 4×4 by averaging 2×1 blocks.
        let mut r_reference = Vec::with_capacity(16);
        for row in 0..4 {
            for col in 0..4 {
                let l = px_full[(row * 8 + col * 2) * 4]; // R of left pixel
                let r = px_full[(row * 8 + col * 2 + 1) * 4]; // R of right pixel
                r_reference.push((l + r) / 2.0);
            }
        }

        // Preview render: 4×4 target for 8×4 canvas (non-uniform scaling).
        let tex_preview = renderer
            .render_stack_preview_texture(&stack, &sources, 8, 4, 4, 4, None)
            .expect("preview render");
        let px_preview = renderer
            .readback_work_texture_to_f32(&tex_preview, 4, 4)
            .await
            .expect("readback");
        let r_preview = r_channels(&px_preview);

        // The preview should match the downscaled full-res render.
        // A large difference means rotation was distorted by non-uniform scaling.
        for i in 0..r_reference.len() {
            let diff = (r_preview[i] - r_reference[i]).abs();
            assert!(
                diff < 1.5,
                "pixel {i}: reference={}, preview={}, diff={diff} — rotation distorted by non-uniform scaling",
                r_reference[i],
                r_preview[i]
            );
        }
    }

    #[tokio::test]
    async fn glow_preview_matches_downscaled_full_res_render() {
        let Some(renderer) = renderer_or_skip().await else {
            return;
        };

        let mut pixels = vec![0.0; 8 * 8 * 4];
        for row in 0..8usize {
            for col in 0..8usize {
                let base = (row * 8 + col) * 4;
                pixels[base + 3] = 1.0;
            }
        }
        let hot = (4 * 8 + 4) * 4;
        pixels[hot] = 10.0;
        pixels[hot + 1] = 3.0;
        pixels[hot + 2] = 1.0;

        let mut stack = LayerStack::new();
        stack.add_image_layer(1, 8, 8);
        stack.add_adjustment_layer(vec![AdjustmentOp::Glow(GlowParams {
            amount: 1.0,
            _pad: [0.0; 3],
        })]);

        let mut sources = HashMap::new();
        sources.insert(
            1,
            FloatImage {
                width: 8,
                height: 8,
                pixels: pixels.into(),
            },
        );

        let tex_full = renderer
            .render_stack_preview_texture(&stack, &sources, 8, 8, 8, 8, None)
            .expect("full-res render");
        let px_full = renderer
            .readback_work_texture_to_f32(&tex_full, 8, 8)
            .await
            .expect("readback");

        let tex_preview = renderer
            .render_stack_preview_texture(&stack, &sources, 8, 8, 4, 4, None)
            .expect("preview render");
        let px_preview = renderer
            .readback_work_texture_to_f32(&tex_preview, 4, 4)
            .await
            .expect("readback");

        let mut downscaled_full = Vec::with_capacity(4 * 4 * 4);
        for row in 0..4usize {
            for col in 0..4usize {
                for channel in 0..4usize {
                    let tl = px_full[((row * 2) * 8 + col * 2) * 4 + channel];
                    let tr = px_full[((row * 2) * 8 + col * 2 + 1) * 4 + channel];
                    let bl = px_full[((row * 2 + 1) * 8 + col * 2) * 4 + channel];
                    let br = px_full[((row * 2 + 1) * 8 + col * 2 + 1) * 4 + channel];
                    downscaled_full.push((tl + tr + bl + br) * 0.25);
                }
            }
        }

        for (i, (preview, full)) in
            px_preview.iter().zip(downscaled_full.iter()).enumerate()
        {
            let diff = (preview - full).abs();
            assert!(
                diff < 0.08,
                "channel {i}: preview={preview}, downscaled_full={full}, diff={diff}"
            );
        }
    }

    #[tokio::test]
    async fn tone_then_glow_preview_matches_downscaled_full_res_render() {
        let Some(renderer) = renderer_or_skip().await else {
            return;
        };

        let mut pixels = vec![0.0; 8 * 8 * 4];
        for row in 0..8usize {
            for col in 0..8usize {
                let base = (row * 8 + col) * 4;
                pixels[base] = 0.12;
                pixels[base + 1] = 0.08;
                pixels[base + 2] = 0.05;
                pixels[base + 3] = 1.0;
            }
        }
        let hot = (4 * 8 + 4) * 4;
        pixels[hot] = 0.9;
        pixels[hot + 1] = 0.75;
        pixels[hot + 2] = 0.6;

        let mut stack = LayerStack::new();
        stack.add_image_layer(1, 8, 8);
        stack.add_adjustment_layer(vec![
            AdjustmentOp::Tone {
                exposure: 1.3,
                contrast: 0.2,
                blacks: 0.0,
                whites: 0.0,
                highlights: 0.0,
                shadows: 0.0,
                gamma: 1.0,
            },
            AdjustmentOp::Glow(GlowParams {
                amount: 1.0,
                _pad: [0.0; 3],
            }),
        ]);

        let mut sources = HashMap::new();
        sources.insert(
            1,
            FloatImage {
                width: 8,
                height: 8,
                pixels: pixels.into(),
            },
        );

        let tex_full = renderer
            .render_stack_preview_texture(&stack, &sources, 8, 8, 8, 8, None)
            .expect("full-res render");
        let px_full = renderer
            .readback_work_texture_to_f32(&tex_full, 8, 8)
            .await
            .expect("readback");

        let tex_preview = renderer
            .render_stack_preview_texture(&stack, &sources, 8, 8, 4, 4, None)
            .expect("preview render");
        let px_preview = renderer
            .readback_work_texture_to_f32(&tex_preview, 4, 4)
            .await
            .expect("readback");

        let mut downscaled_full = Vec::with_capacity(4 * 4 * 4);
        for row in 0..4usize {
            for col in 0..4usize {
                for channel in 0..4usize {
                    let tl = px_full[((row * 2) * 8 + col * 2) * 4 + channel];
                    let tr = px_full[((row * 2) * 8 + col * 2 + 1) * 4 + channel];
                    let bl = px_full[((row * 2 + 1) * 8 + col * 2) * 4 + channel];
                    let br = px_full[((row * 2 + 1) * 8 + col * 2 + 1) * 4 + channel];
                    downscaled_full.push((tl + tr + bl + br) * 0.25);
                }
            }
        }

        for (i, (preview, full)) in
            px_preview.iter().zip(downscaled_full.iter()).enumerate()
        {
            let diff = (preview - full).abs();
            assert!(
                diff < 0.08,
                "channel {i}: preview={preview}, downscaled_full={full}, diff={diff}"
            );
        }
    }

    #[tokio::test]
    async fn cropped_glow_preview_matches_downscaled_zoomed_render() {
        let Some(renderer) = renderer_or_skip().await else {
            return;
        };

        let mut pixels = vec![0.0; 16 * 16 * 4];
        for row in 0..16usize {
            for col in 0..16usize {
                let base = (row * 16 + col) * 4;
                pixels[base] = 0.1;
                pixels[base + 1] = 0.08;
                pixels[base + 2] = 0.06;
                pixels[base + 3] = 1.0;
            }
        }
        for &(row, col, r, g, b) in &[
            (7usize, 9usize, 8.0, 2.5, 0.8),
            (8usize, 10usize, 5.0, 1.7, 0.5),
            (6usize, 8usize, 3.0, 1.2, 0.4),
        ] {
            let base = (row * 16 + col) * 4;
            pixels[base] = r;
            pixels[base + 1] = g;
            pixels[base + 2] = b;
        }

        let mut stack = LayerStack::new();
        stack.add_image_layer(1, 16, 16);
        stack.add_adjustment_layer(vec![AdjustmentOp::Glow(GlowParams {
            amount: 1.0,
            _pad: [0.0; 3],
        })]);

        let mut sources = HashMap::new();
        sources.insert(
            1,
            FloatImage {
                width: 16,
                height: 16,
                pixels: pixels.into(),
            },
        );

        let crop = PreviewCrop {
            x: 4.0,
            y: 3.0,
            width: 8.0,
            height: 6.0,
        };

        let tex_full = renderer
            .render_stack_preview_texture(
                &stack,
                &sources,
                16,
                16,
                8,
                6,
                Some(crop.clone()),
            )
            .expect("full cropped render");
        let px_full = renderer
            .readback_work_texture_to_f32(&tex_full, 8, 6)
            .await
            .expect("readback");

        let tex_preview = renderer
            .render_stack_preview_texture(&stack, &sources, 16, 16, 4, 3, Some(crop))
            .expect("preview cropped render");
        let px_preview = renderer
            .readback_work_texture_to_f32(&tex_preview, 4, 3)
            .await
            .expect("readback");

        let mut downscaled_full = Vec::with_capacity(4 * 3 * 4);
        for row in 0..3usize {
            for col in 0..4usize {
                for channel in 0..4usize {
                    let tl = px_full[((row * 2) * 8 + col * 2) * 4 + channel];
                    let tr = px_full[((row * 2) * 8 + col * 2 + 1) * 4 + channel];
                    let bl = px_full[((row * 2 + 1) * 8 + col * 2) * 4 + channel];
                    let br = px_full[((row * 2 + 1) * 8 + col * 2 + 1) * 4 + channel];
                    downscaled_full.push((tl + tr + bl + br) * 0.25);
                }
            }
        }

        for (i, (preview, full)) in
            px_preview.iter().zip(downscaled_full.iter()).enumerate()
        {
            let diff = (preview - full).abs();
            assert!(
                diff < 0.08,
                "channel {i}: preview={preview}, downscaled_full={full}, diff={diff}"
            );
        }
    }

    #[tokio::test]
    async fn cropped_sharpen_preview_matches_downscaled_zoomed_render() {
        let Some(renderer) = renderer_or_skip().await else {
            return;
        };

        let mut pixels = vec![0.0; 16 * 16 * 4];
        for row in 0..16usize {
            for col in 0..16usize {
                let base = (row * 16 + col) * 4;
                let checker = if (row + col) % 2 == 0 { 0.18 } else { 0.72 };
                pixels[base] = checker;
                pixels[base + 1] = checker * 0.95;
                pixels[base + 2] = checker * 0.9;
                pixels[base + 3] = 1.0;
            }
        }

        let mut stack = LayerStack::new();
        stack.add_image_layer(1, 16, 16);
        stack.add_adjustment_layer(vec![AdjustmentOp::Sharpen(
            shade_lib::SharpenParams {
                amount: 1.0,
                threshold: 0.0,
            },
        )]);

        let mut sources = HashMap::new();
        sources.insert(
            1,
            FloatImage {
                width: 16,
                height: 16,
                pixels: pixels.into(),
            },
        );

        let crop = PreviewCrop {
            x: 4.0,
            y: 3.0,
            width: 8.0,
            height: 6.0,
        };

        let tex_full = renderer
            .render_stack_preview_texture(
                &stack,
                &sources,
                16,
                16,
                8,
                6,
                Some(crop.clone()),
            )
            .expect("full cropped render");
        let px_full = renderer
            .readback_work_texture_to_f32(&tex_full, 8, 6)
            .await
            .expect("readback");

        let tex_preview = renderer
            .render_stack_preview_texture(&stack, &sources, 16, 16, 4, 3, Some(crop))
            .expect("preview cropped render");
        let px_preview = renderer
            .readback_work_texture_to_f32(&tex_preview, 4, 3)
            .await
            .expect("readback");

        let mut downscaled_full = Vec::with_capacity(4 * 3 * 4);
        for row in 0..3usize {
            for col in 0..4usize {
                for channel in 0..4usize {
                    let tl = px_full[((row * 2) * 8 + col * 2) * 4 + channel];
                    let tr = px_full[((row * 2) * 8 + col * 2 + 1) * 4 + channel];
                    let bl = px_full[((row * 2 + 1) * 8 + col * 2) * 4 + channel];
                    let br = px_full[((row * 2 + 1) * 8 + col * 2 + 1) * 4 + channel];
                    downscaled_full.push((tl + tr + bl + br) * 0.25);
                }
            }
        }

        for (i, (preview, full)) in
            px_preview.iter().zip(downscaled_full.iter()).enumerate()
        {
            let diff = (preview - full).abs();
            assert!(
                diff < 0.08,
                "channel {i}: preview={preview}, downscaled_full={full}, diff={diff}"
            );
        }
    }

    #[tokio::test]
    async fn cropped_vignette_preview_matches_full_res_subregion() {
        let Some(renderer) = renderer_or_skip().await else {
            return;
        };

        let mut pixels = vec![0.0; 16 * 16 * 4];
        for row in 0..16usize {
            for col in 0..16usize {
                let base = (row * 16 + col) * 4;
                pixels[base] = 1.0;
                pixels[base + 1] = 1.0;
                pixels[base + 2] = 1.0;
                pixels[base + 3] = 1.0;
            }
        }

        let mut stack = LayerStack::new();
        stack.add_image_layer(1, 16, 16);
        stack.add_crop_layer(CropRect {
            x: 4.0,
            y: 3.0,
            width: 8.0,
            height: 6.0,
            rotation: 0.0,
        });
        stack.add_adjustment_layer(vec![AdjustmentOp::Vignette(VignetteParams {
            amount: 1.0,
            midpoint: 0.25,
            feather: 0.2,
            roundness: 1.0,
        })]);

        let mut sources = HashMap::new();
        sources.insert(
            1,
            FloatImage {
                width: 16,
                height: 16,
                pixels: pixels.into(),
            },
        );

        let tex_full = renderer
            .render_stack_preview_texture(&stack, &sources, 16, 16, 8, 6, None)
            .expect("full cropped render");
        let px_full = renderer
            .readback_work_texture_to_f32(&tex_full, 8, 6)
            .await
            .expect("readback");

        let tex_preview = renderer
            .render_stack_preview_texture(
                &stack,
                &sources,
                16,
                16,
                4,
                3,
                Some(PreviewCrop {
                    x: 5.0,
                    y: 4.0,
                    width: 4.0,
                    height: 3.0,
                }),
            )
            .expect("preview cropped render");
        let px_preview = renderer
            .readback_work_texture_to_f32(&tex_preview, 4, 3)
            .await
            .expect("readback");

        let mut full_subregion = Vec::with_capacity(4 * 3 * 4);
        for row in 0..3usize {
            for col in 0..4usize {
                let full_row = row + 1;
                let full_col = col + 1;
                let base = (full_row * 8 + full_col) * 4;
                full_subregion.extend_from_slice(&px_full[base..base + 4]);
            }
        }

        for (i, (preview, full)) in
            px_preview.iter().zip(full_subregion.iter()).enumerate()
        {
            let diff = (preview - full).abs();
            assert!(
                diff < 0.08,
                "channel {i}: preview={preview}, full_subregion={full}, diff={diff}"
            );
        }
    }

    #[tokio::test]
    async fn cropped_denoise_preview_matches_downscaled_zoomed_render() {
        let Some(renderer) = renderer_or_skip().await else {
            return;
        };

        let mut pixels = vec![0.0; 16 * 16 * 4];
        for row in 0..16usize {
            for col in 0..16usize {
                let base = (row * 16 + col) * 4;
                let signal: f32 = if (row + col) % 3 == 0 { 0.75 } else { 0.25 };
                let noise: f32 = if (row * 17 + col * 31) % 5 == 0 {
                    0.18
                } else {
                    -0.12
                };
                pixels[base] = (signal + noise).clamp(0.0, 1.0);
                pixels[base + 1] = (signal * 0.9 - noise * 0.5).clamp(0.0, 1.0);
                pixels[base + 2] = (signal * 0.8 + noise * 0.3).clamp(0.0, 1.0);
                pixels[base + 3] = 1.0;
            }
        }

        let mut stack = LayerStack::new();
        stack.add_image_layer(1, 16, 16);
        stack.add_adjustment_layer(vec![AdjustmentOp::Denoise(
            shade_lib::DenoiseParams {
                luma_strength: 0.8,
                chroma_strength: 0.6,
                mode: 0,
                _pad: 0.0,
            },
        )]);

        let mut sources = HashMap::new();
        sources.insert(
            1,
            FloatImage {
                width: 16,
                height: 16,
                pixels: pixels.into(),
            },
        );

        let crop = PreviewCrop {
            x: 4.0,
            y: 3.0,
            width: 8.0,
            height: 6.0,
        };

        let tex_full = renderer
            .render_stack_preview_texture(
                &stack,
                &sources,
                16,
                16,
                8,
                6,
                Some(crop.clone()),
            )
            .expect("full cropped render");
        let px_full = renderer
            .readback_work_texture_to_f32(&tex_full, 8, 6)
            .await
            .expect("readback");

        let tex_preview = renderer
            .render_stack_preview_texture(&stack, &sources, 16, 16, 4, 3, Some(crop))
            .expect("preview cropped render");
        let px_preview = renderer
            .readback_work_texture_to_f32(&tex_preview, 4, 3)
            .await
            .expect("readback");

        let mut downscaled_full = Vec::with_capacity(4 * 3 * 4);
        for row in 0..3usize {
            for col in 0..4usize {
                for channel in 0..4usize {
                    let tl = px_full[((row * 2) * 8 + col * 2) * 4 + channel];
                    let tr = px_full[((row * 2) * 8 + col * 2 + 1) * 4 + channel];
                    let bl = px_full[((row * 2 + 1) * 8 + col * 2) * 4 + channel];
                    let br = px_full[((row * 2 + 1) * 8 + col * 2 + 1) * 4 + channel];
                    downscaled_full.push((tl + tr + bl + br) * 0.25);
                }
            }
        }

        for (i, (preview, full)) in
            px_preview.iter().zip(downscaled_full.iter()).enumerate()
        {
            let diff = (preview - full).abs();
            assert!(
                diff < 0.1,
                "channel {i}: preview={preview}, downscaled_full={full}, diff={diff}"
            );
        }
    }

    // ── CPU-side viewport transform pipeline ──────────────────────────────
    //
    // Replicates the crop.wgsl shader math in pure Rust so the coordinate
    // transform pipeline can be tested without a GPU.

    use crate::pipelines::CropUniform;

    /// CPU replica of crop.wgsl: for output pixel (gid_x, gid_y) in an
    /// output texture of (out_w, out_h), compute the source (x, y) in the
    /// input texture of (in_w, in_h).
    fn cpu_crop_sample(
        gid_x: u32,
        gid_y: u32,
        out_w: u32,
        out_h: u32,
        in_w: u32,
        in_h: u32,
        p: &CropUniform,
    ) -> (f32, f32) {
        let u = (gid_x as f32 + 0.5) / out_w as f32;
        let v = (gid_y as f32 + 0.5) / out_h as f32;
        let canvas_x = p.out_x + u * p.out_width;
        let canvas_y = p.out_y + v * p.out_height;

        let dx = canvas_x - p.pivot_x;
        let dy = canvas_y - p.pivot_y;
        let rot_x = p.pivot_x + dx * p.cos_r + dy * p.sin_r;
        let rot_y = p.pivot_y - dx * p.sin_r + dy * p.cos_r;

        let src_x = ((rot_x - p.in_x) / p.in_width * in_w as f32 - 0.5)
            .clamp(0.0, (in_w - 1) as f32);
        let src_y = ((rot_y - p.in_y) / p.in_height * in_h as f32 - 0.5)
            .clamp(0.0, (in_h - 1) as f32);
        (src_x, src_y)
    }

    /// CPU bilinear sample from an RGBA f32 image stored row-major.
    fn cpu_bilinear(pixels: &[f32], w: u32, h: u32, sx: f32, sy: f32) -> [f32; 4] {
        let x0 = (sx.floor() as u32).min(w - 1);
        let y0 = (sy.floor() as u32).min(h - 1);
        let x1 = (x0 + 1).min(w - 1);
        let y1 = (y0 + 1).min(h - 1);
        let wx = sx - x0 as f32;
        let wy = sy - y0 as f32;
        let idx = |x: u32, y: u32| (y * w + x) as usize * 4;
        let mut out = [0.0f32; 4];
        for c in 0..4 {
            let tl = pixels[idx(x0, y0) + c];
            let tr = pixels[idx(x1, y0) + c];
            let bl = pixels[idx(x0, y1) + c];
            let br = pixels[idx(x1, y1) + c];
            let top = tl * (1.0 - wx) + tr * wx;
            let bot = bl * (1.0 - wx) + br * wx;
            out[c] = top * (1.0 - wy) + bot * wy;
        }
        out
    }

    /// Run the full CPU pipeline: Image layer (viewport crop) → Crop layer.
    /// Returns the final RGBA f32 buffer at (target_w × target_h).
    fn cpu_render_image_then_crop(
        source: &[f32],
        src_w: u32,
        src_h: u32,
        target_w: u32,
        target_h: u32,
        viewport: &PreviewCrop,
        crop: &CropRect,
    ) -> Vec<f32> {
        // Step 1: Image layer — sample source into (target_w × target_h)
        //         using the viewport crop (no rotation).
        let image_uniform = CropUniform {
            out_x: viewport.x,
            out_y: viewport.y,
            out_width: viewport.width,
            out_height: viewport.height,
            pivot_x: 0.0,
            pivot_y: 0.0,
            in_x: 0.0,
            in_y: 0.0,
            in_width: src_w as f32,
            in_height: src_h as f32,
            cos_r: 1.0,
            sin_r: 0.0,
        };
        let mut accum = vec![0.0f32; (target_w * target_h * 4) as usize];
        for gy in 0..target_h {
            for gx in 0..target_w {
                let (sx, sy) = cpu_crop_sample(
                    gx,
                    gy,
                    target_w,
                    target_h,
                    src_w,
                    src_h,
                    &image_uniform,
                );
                let px = cpu_bilinear(source, src_w, src_h, sx, sy);
                let off = (gy * target_w + gx) as usize * 4;
                accum[off..off + 4].copy_from_slice(&px);
            }
        }

        // Step 2: Crop layer.
        // When rotation is non-zero, sample from the FULL source (not the
        // viewport-cropped accumulator) so rotated positions outside the
        // viewport still resolve to valid source pixels.
        let (crop_src, crop_src_w, crop_src_h, crop_in) = if crop.rotation != 0.0 {
            (
                source,
                src_w,
                src_h,
                CropUniform {
                    out_x: crop.x,
                    out_y: crop.y,
                    out_width: crop.width,
                    out_height: crop.height,
                    pivot_x: crop.x + crop.width * 0.5,
                    pivot_y: crop.y + crop.height * 0.5,
                    in_x: 0.0,
                    in_y: 0.0,
                    in_width: src_w as f32,
                    in_height: src_h as f32,
                    cos_r: crop.rotation.cos(),
                    sin_r: crop.rotation.sin(),
                },
            )
        } else {
            let prev_view = viewport;
            (
                accum.as_slice(),
                target_w,
                target_h,
                CropUniform {
                    out_x: crop.x,
                    out_y: crop.y,
                    out_width: crop.width,
                    out_height: crop.height,
                    pivot_x: crop.x + crop.width * 0.5,
                    pivot_y: crop.y + crop.height * 0.5,
                    in_x: prev_view.x,
                    in_y: prev_view.y,
                    in_width: prev_view.width,
                    in_height: prev_view.height,
                    cos_r: 1.0,
                    sin_r: 0.0,
                },
            )
        };
        let mut output = vec![0.0f32; (target_w * target_h * 4) as usize];
        for gy in 0..target_h {
            for gx in 0..target_w {
                let (sx, sy) = cpu_crop_sample(
                    gx, gy, target_w, target_h, crop_src_w, crop_src_h, &crop_in,
                );
                let px = cpu_bilinear(crop_src, crop_src_w, crop_src_h, sx, sy);
                let off = (gy * target_w + gx) as usize * 4;
                output[off..off + 4].copy_from_slice(&px);
            }
        }
        output
    }

    fn make_grid(w: u32, h: u32) -> Vec<f32> {
        let mut pixels = Vec::with_capacity((w * h * 4) as usize);
        for row in 0..h {
            for col in 0..w {
                pixels.push((row * w + col + 1) as f32);
                pixels.push(0.0);
                pixels.push(0.0);
                pixels.push(1.0);
            }
        }
        pixels
    }

    fn r_from(pixels: &[f32]) -> Vec<f32> {
        pixels.chunks(4).map(|px| px[0]).collect()
    }

    #[test]
    fn cpu_crop_no_rotation_identity() {
        // 4×4 source, full-canvas viewport, crop right half, no rotation.
        let source = make_grid(4, 4);
        let viewport = PreviewCrop {
            x: 0.0,
            y: 0.0,
            width: 4.0,
            height: 4.0,
        };
        let crop = CropRect {
            x: 2.0,
            y: 0.0,
            width: 2.0,
            height: 4.0,
            rotation: 0.0,
        };
        let out = cpu_render_image_then_crop(&source, 4, 4, 4, 4, &viewport, &crop);
        let r = r_from(&out);
        // Output covers crop rect (2,0)-(4,4) at 4×4 target.
        // Each column covers 0.5 canvas units. Center of col 0 → canvas_x = 2.25 → src col ≈ 2.
        for (i, val) in r.iter().enumerate() {
            assert!(
                *val >= 2.5 && *val <= 16.5,
                "pixel {i}: R={val} outside crop region"
            );
        }
    }

    #[test]
    fn cpu_crop_90deg_rotation_square_canvas() {
        // 4×4 source, 90° rotation of center 2×2 crop.
        let source = make_grid(4, 4);
        let viewport = PreviewCrop {
            x: 0.0,
            y: 0.0,
            width: 4.0,
            height: 4.0,
        };
        let crop = CropRect {
            x: 1.0,
            y: 1.0,
            width: 2.0,
            height: 2.0,
            rotation: std::f32::consts::FRAC_PI_2,
        };

        // Full-res: target = canvas = 4×4.
        let full = cpu_render_image_then_crop(&source, 4, 4, 4, 4, &viewport, &crop);
        let r_full = r_from(&full);

        // Half-res: target = 2×2 for same 4×4 canvas.
        let half = cpu_render_image_then_crop(&source, 4, 4, 2, 2, &viewport, &crop);
        let r_half = r_from(&half);

        // The 2×2 result should approximate the 4×4 result downsampled by
        // averaging 2×2 blocks.
        let mut expected = Vec::with_capacity(4);
        for row in 0..2 {
            for col in 0..2 {
                let tl = r_full[(row * 2) * 4 + col * 2];
                let tr = r_full[(row * 2) * 4 + col * 2 + 1];
                let bl = r_full[(row * 2 + 1) * 4 + col * 2];
                let br = r_full[(row * 2 + 1) * 4 + col * 2 + 1];
                expected.push((tl + tr + bl + br) / 4.0);
            }
        }
        for i in 0..4 {
            let diff = (r_half[i] - expected[i]).abs();
            assert!(
                diff < 1.5,
                "pixel {i}: half={}, expected≈{}, diff={diff}",
                r_half[i],
                expected[i],
            );
        }
    }

    /// The key bug scenario: non-square canvas with a rotated crop.
    /// On an 8×4 canvas, a square 4×4 crop with 90° rotation.
    /// When the target is 4×4 (non-uniform scaling: 2× horizontal, 1× vertical),
    /// the rotation must still happen in canvas space, not in the scaled
    /// preview-pixel space.
    #[test]
    fn cpu_crop_rotation_non_uniform_scaling() {
        let source = make_grid(8, 4);
        let viewport = PreviewCrop {
            x: 0.0,
            y: 0.0,
            width: 8.0,
            height: 4.0,
        };
        let crop = CropRect {
            x: 2.0,
            y: 0.0,
            width: 4.0,
            height: 4.0,
            rotation: std::f32::consts::FRAC_PI_2,
        };

        // Full-res reference: target = 8×4 (uniform 1:1 mapping for image layer).
        let full = cpu_render_image_then_crop(&source, 8, 4, 8, 4, &viewport, &crop);
        // Downsample 8×4 → 4×4 by averaging 2×1 horizontal pairs.
        let mut r_ref = Vec::with_capacity(16);
        for row in 0..4 {
            for col in 0..4 {
                let l = full[(row * 8 + col * 2) * 4];
                let r = full[(row * 8 + col * 2 + 1) * 4];
                r_ref.push((l + r) / 2.0);
            }
        }

        // Preview: target = 4×4 for 8×4 canvas (non-uniform scaling).
        let preview = cpu_render_image_then_crop(&source, 8, 4, 4, 4, &viewport, &crop);
        let r_preview = r_from(&preview);

        for i in 0..r_ref.len() {
            let diff = (r_preview[i] - r_ref[i]).abs();
            assert!(
                diff < 1.5,
                "pixel {i}: reference={}, preview={}, diff={diff} — \
                 rotation distorted by non-uniform scaling",
                r_ref[i],
                r_preview[i],
            );
        }
    }

    /// Verify that a 45° rotation on a non-square canvas samples from the
    /// correct canvas-space coordinates regardless of preview resolution.
    #[test]
    fn cpu_crop_45deg_non_square_canvas() {
        let source = make_grid(8, 4);
        let viewport = PreviewCrop {
            x: 0.0,
            y: 0.0,
            width: 8.0,
            height: 4.0,
        };
        let crop = CropRect {
            x: 2.0,
            y: 0.0,
            width: 4.0,
            height: 4.0,
            rotation: std::f32::consts::FRAC_PI_4,
        };

        let full = cpu_render_image_then_crop(&source, 8, 4, 8, 4, &viewport, &crop);
        let mut r_ref = Vec::with_capacity(16);
        for row in 0..4 {
            for col in 0..4 {
                let l = full[(row * 8 + col * 2) * 4];
                let r = full[(row * 8 + col * 2 + 1) * 4];
                r_ref.push((l + r) / 2.0);
            }
        }

        let preview = cpu_render_image_then_crop(&source, 8, 4, 4, 4, &viewport, &crop);
        let r_preview = r_from(&preview);

        for i in 0..r_ref.len() {
            let diff = (r_preview[i] - r_ref[i]).abs();
            assert!(
                diff < 1.5,
                "pixel {i}: reference={}, preview={}, diff={diff}",
                r_ref[i],
                r_preview[i],
            );
        }
    }

    /// Test that the crop shader samples pixels from the expected canvas-space
    /// position after rotation.
    #[test]
    fn cpu_crop_sample_positions_after_rotation() {
        // 8×4 canvas. Crop (2,0,4,4) with 90° rotation, pivot at (4,2).
        // Full-canvas input: in = (0,0,8,4), texture = 8×4.
        let p = CropUniform {
            out_x: 2.0,
            out_y: 0.0,
            out_width: 4.0,
            out_height: 4.0,
            pivot_x: 4.0,
            pivot_y: 2.0,
            in_x: 0.0,
            in_y: 0.0,
            in_width: 8.0,
            in_height: 4.0,
            cos_r: 0.0,
            sin_r: 1.0,
        };

        // gid (2,2) in 4×4 output: u=0.625, v=0.625.
        // canvas = (2+2.5, 0+2.5) = (4.5, 2.5).
        // dx=0.5, dy=0.5. rot = (4+0.5, 2-0.5) = (4.5, 1.5).
        // src = (4.5-0)/8*8 - 0.5 = 4.0, (1.5-0)/4*4 - 0.5 = 1.0.
        let (sx, sy) = cpu_crop_sample(2, 2, 4, 4, 8, 4, &p);
        assert!((sx - 4.0).abs() < 0.01, "gid(2,2) src_x={sx}, expected 4.0");
        assert!((sy - 1.0).abs() < 0.01, "gid(2,2) src_y={sy}, expected 1.0");

        // gid (0,0): u=0.125, v=0.125. canvas=(2.5, 0.5).
        // dx=-1.5, dy=-1.5. rot = (4-1.5, 2+1.5) = (2.5, 3.5).
        // src = (2.5/8*8-0.5, 3.5/4*4-0.5) = (2.0, 3.0).
        let (sx, sy) = cpu_crop_sample(0, 0, 4, 4, 8, 4, &p);
        assert!((sx - 2.0).abs() < 0.01, "gid(0,0) src_x={sx}, expected 2.0");
        assert!((sy - 3.0).abs() < 0.01, "gid(0,0) src_y={sy}, expected 3.0");
    }

    /// Edge case: small rotation (5°) on a wide canvas.
    /// Ensures the transform doesn't degenerate for small angles.
    #[test]
    fn cpu_crop_small_rotation_wide_canvas() {
        let source = make_grid(16, 4);
        let viewport = PreviewCrop {
            x: 0.0,
            y: 0.0,
            width: 16.0,
            height: 4.0,
        };
        let crop = CropRect {
            x: 6.0,
            y: 0.0,
            width: 4.0,
            height: 4.0,
            rotation: 5.0f32.to_radians(),
        };

        // Full-res reference: target = 16×4.
        let full = cpu_render_image_then_crop(&source, 16, 4, 16, 4, &viewport, &crop);
        // Downsample 16×4 → 4×4 by averaging 4×1 blocks.
        let mut r_ref = Vec::with_capacity(16);
        for row in 0..4 {
            for col in 0..4 {
                let mut sum = 0.0;
                for dx in 0..4 {
                    sum += full[(row * 16 + col * 4 + dx) * 4];
                }
                r_ref.push(sum / 4.0);
            }
        }

        let preview = cpu_render_image_then_crop(&source, 16, 4, 4, 4, &viewport, &crop);
        let r_preview = r_from(&preview);

        for i in 0..r_ref.len() {
            let diff = (r_preview[i] - r_ref[i]).abs();
            assert!(
                diff < 2.0,
                "pixel {i}: reference={}, preview={}, diff={diff}",
                r_ref[i],
                r_preview[i],
            );
        }
    }

    /// Diagnostic: when viewport=crop rect and there's rotation, the crop
    /// layer must produce the same result as when viewport=full canvas.
    #[test]
    fn cpu_crop_rotation_viewport_must_match_full_canvas() {
        let source = make_grid(8, 8);
        let crop = CropRect {
            x: 2.0,
            y: 2.0,
            width: 4.0,
            height: 4.0,
            rotation: std::f32::consts::FRAC_PI_4,
        };

        let full = cpu_render_image_then_crop(
            &source,
            8,
            8,
            4,
            4,
            &PreviewCrop {
                x: 0.0,
                y: 0.0,
                width: 8.0,
                height: 8.0,
            },
            &crop,
        );
        let r_full = r_from(&full);

        let preview = cpu_render_image_then_crop(
            &source,
            8,
            8,
            4,
            4,
            &PreviewCrop {
                x: 2.0,
                y: 2.0,
                width: 4.0,
                height: 4.0,
            },
            &crop,
        );
        let r_preview = r_from(&preview);

        eprintln!("--- viewport = crop rect ---");
        for row in 0..4 {
            let v: Vec<String> = (0..4)
                .map(|c| format!("{:6.1}", r_preview[row * 4 + c]))
                .collect();
            eprintln!("  row {row}: {}", v.join(" "));
        }
        eprintln!("--- viewport = full canvas (reference) ---");
        for row in 0..4 {
            let v: Vec<String> = (0..4)
                .map(|c| format!("{:6.1}", r_full[row * 4 + c]))
                .collect();
            eprintln!("  row {row}: {}", v.join(" "));
        }

        let mut max_diff = 0.0f32;
        for i in 0..r_full.len() {
            max_diff = max_diff.max((r_preview[i] - r_full[i]).abs());
        }
        assert!(
            max_diff < 2.0,
            "max diff={max_diff} — rotation is not canvas-space invariant"
        );
    }

    /// Counterpart: when the viewport covers the full canvas, the rotated
    /// crop at different target resolutions must still agree.
    #[test]
    fn cpu_crop_rotation_full_viewport_different_resolutions() {
        let source = make_grid(8, 8);
        let viewport = PreviewCrop {
            x: 0.0,
            y: 0.0,
            width: 8.0,
            height: 8.0,
        };
        let crop = CropRect {
            x: 2.0,
            y: 2.0,
            width: 4.0,
            height: 4.0,
            rotation: std::f32::consts::FRAC_PI_2,
        };

        // 8×8 target (high-res).
        let hi = cpu_render_image_then_crop(&source, 8, 8, 8, 8, &viewport, &crop);
        let r_hi = r_from(&hi);

        // Downsample to 4×4 by averaging 2×2 blocks.
        let mut r_ref = Vec::with_capacity(16);
        for row in 0..4 {
            for col in 0..4 {
                let tl = r_hi[(row * 2) * 8 + col * 2];
                let tr = r_hi[(row * 2) * 8 + col * 2 + 1];
                let bl = r_hi[(row * 2 + 1) * 8 + col * 2];
                let br = r_hi[(row * 2 + 1) * 8 + col * 2 + 1];
                r_ref.push((tl + tr + bl + br) / 4.0);
            }
        }

        // 4×4 target directly.
        let lo = cpu_render_image_then_crop(&source, 8, 8, 4, 4, &viewport, &crop);
        let r_lo = r_from(&lo);

        for i in 0..r_ref.len() {
            let diff = (r_lo[i] - r_ref[i]).abs();
            assert!(
                diff < 2.0,
                "pixel {i}: reference={}, lo_res={}, diff={diff}",
                r_ref[i],
                r_lo[i],
            );
        }
    }

    /// Non-square canvas with crop: verifies that non-uniform preview scaling
    /// does not distort the crop region.
    #[tokio::test]
    async fn crop_on_non_square_canvas_preview_is_consistent() {
        let Some(renderer) = renderer_or_skip().await else {
            return;
        };

        // 8×2 canvas (wide). Pixel R = col + 1.
        let mut pixels = Vec::with_capacity(8 * 2 * 4);
        for _row in 0..2u32 {
            for col in 0..8u32 {
                pixels.push((col + 1) as f32);
                pixels.push(0.0);
                pixels.push(0.0);
                pixels.push(1.0);
            }
        }
        let mut stack = LayerStack::new();
        stack.add_image_layer(1, 8, 2);
        // Crop to right half: x=4, y=0, w=4, h=2.
        stack.add_crop_layer(CropRect {
            x: 4.0,
            y: 0.0,
            width: 4.0,
            height: 2.0,
            rotation: 0.0,
        });
        let mut sources: HashMap<TextureId, FloatImage> = HashMap::new();
        sources.insert(
            1,
            FloatImage {
                width: 8,
                height: 2,
                pixels: pixels.into(),
            },
        );

        // Full-res: target = 4×2 (native crop size).
        let tex_full = renderer
            .render_stack_preview_texture(&stack, &sources, 8, 2, 4, 2, None)
            .expect("full render");
        let px_full = renderer
            .readback_work_texture_to_f32(&tex_full, 4, 2)
            .await
            .expect("readback");
        let r_full = r_channels(&px_full);

        // Preview: heavily downscaled to 2×2 (non-uniform: 4x horizontal, 1x vertical).
        let tex_small = renderer
            .render_stack_preview_texture(&stack, &sources, 8, 2, 2, 2, None)
            .expect("small render");
        let px_small = renderer
            .readback_work_texture_to_f32(&tex_small, 2, 2)
            .await
            .expect("readback");
        let r_small = r_channels(&px_small);

        // The crop region has cols 4-7 (R = 5,6,7,8).
        // Full-res 4×2: each pixel maps 1:1, so R values should be exactly 5,6,7,8 per row.
        for val in &r_full {
            assert!(
                *val >= 4.5 && *val <= 8.5,
                "full-res crop pixel R={val} outside expected range [5,8]"
            );
        }
        // Preview 2×2: should also only contain values from the crop region.
        for val in &r_small {
            assert!(
                *val >= 4.5 && *val <= 8.5,
                "preview crop pixel R={val} outside expected range [5,8]"
            );
        }
    }
}

/// Round `value` up to the nearest multiple of `alignment`.
#[inline]
fn align_up(value: u32, alignment: u32) -> u32 {
    (value + alignment - 1) & !(alignment - 1)
}
