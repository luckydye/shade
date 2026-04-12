// Denoiser pipeline — bilateral (fast, interactive) and NLM (quality, export).
//
// Both algorithms operate in linear YCbCr (BT.709) so luma and chroma noise are
// filtered with independent strengths.  The bilateral mode runs in 4 GPU passes;
// the NLM mode is a single tiled compute pass.

use bytemuck::{Pod, Zeroable};
use shade_lib::DenoiseParams;
use wgpu::*;

use crate::{context::create_upload_buffer, pipelines::EffectSpace, GpuContext, INTERNAL_TEXTURE_FORMAT};

const GUIDE_H_WGSL: &str = include_str!("../shaders/denoise_guide_h.wgsl");
const GUIDE_V_WGSL: &str = include_str!("../shaders/denoise_guide_v.wgsl");
const BILATERAL_H_WGSL: &str = include_str!("../shaders/denoise_bilateral_h.wgsl");
const BILATERAL_V_WGSL: &str = include_str!("../shaders/denoise_bilateral_v.wgsl");
const NLM_WGSL: &str = include_str!("../shaders/denoise_nlm.wgsl");

#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
struct DenoiseUniform {
    luma_strength: f32,
    chroma_strength: f32,
    step_x: f32,
    step_y: f32,
}

pub struct DenoisePipeline {
    // Two-binding layout: (texture_2d, storage_texture) — used for guide passes
    guide_h_pipeline: ComputePipeline,
    guide_h_bgl: BindGroupLayout,
    guide_v_pipeline: ComputePipeline,
    guide_v_bgl: BindGroupLayout,

    // Four-binding layout: (texture_2d noisy, texture_2d guide, storage_texture, uniform)
    bilateral_h_pipeline: ComputePipeline,
    bilateral_h_bgl: BindGroupLayout,
    bilateral_v_pipeline: ComputePipeline,
    bilateral_v_bgl: BindGroupLayout,

    // Three-binding layout: (texture_2d, storage_texture, uniform) — NLM single pass
    nlm_pipeline: ComputePipeline,
    nlm_bgl: BindGroupLayout,
}

// ─── Layout helpers ───────────────────────────────────────────────────────────

fn three_binding_bgl(device: &Device, label: &str) -> BindGroupLayout {
    device.create_bind_group_layout(&BindGroupLayoutDescriptor {
        label: Some(label),
        entries: &[
            BindGroupLayoutEntry {
                binding: 0,
                visibility: ShaderStages::COMPUTE,
                ty: BindingType::Texture {
                    sample_type: TextureSampleType::Float { filterable: false },
                    view_dimension: TextureViewDimension::D2,
                    multisampled: false,
                },
                count: None,
            },
            BindGroupLayoutEntry {
                binding: 1,
                visibility: ShaderStages::COMPUTE,
                ty: BindingType::StorageTexture {
                    access: StorageTextureAccess::WriteOnly,
                    format: INTERNAL_TEXTURE_FORMAT,
                    view_dimension: TextureViewDimension::D2,
                },
                count: None,
            },
            BindGroupLayoutEntry {
                binding: 2,
                visibility: ShaderStages::COMPUTE,
                ty: BindingType::Buffer {
                    ty: BufferBindingType::Uniform,
                    has_dynamic_offset: false,
                    min_binding_size: None,
                },
                count: None,
            },
        ],
    })
}

fn four_binding_bgl(device: &Device, label: &str) -> BindGroupLayout {
    device.create_bind_group_layout(&BindGroupLayoutDescriptor {
        label: Some(label),
        entries: &[
            BindGroupLayoutEntry {
                binding: 0,
                visibility: ShaderStages::COMPUTE,
                ty: BindingType::Texture {
                    sample_type: TextureSampleType::Float { filterable: false },
                    view_dimension: TextureViewDimension::D2,
                    multisampled: false,
                },
                count: None,
            },
            BindGroupLayoutEntry {
                binding: 1,
                visibility: ShaderStages::COMPUTE,
                ty: BindingType::Texture {
                    sample_type: TextureSampleType::Float { filterable: false },
                    view_dimension: TextureViewDimension::D2,
                    multisampled: false,
                },
                count: None,
            },
            BindGroupLayoutEntry {
                binding: 2,
                visibility: ShaderStages::COMPUTE,
                ty: BindingType::StorageTexture {
                    access: StorageTextureAccess::WriteOnly,
                    format: INTERNAL_TEXTURE_FORMAT,
                    view_dimension: TextureViewDimension::D2,
                },
                count: None,
            },
            BindGroupLayoutEntry {
                binding: 3,
                visibility: ShaderStages::COMPUTE,
                ty: BindingType::Buffer {
                    ty: BufferBindingType::Uniform,
                    has_dynamic_offset: false,
                    min_binding_size: None,
                },
                count: None,
            },
        ],
    })
}

fn make_pipeline(
    device: &Device,
    src: &str,
    shader_label: &str,
    bgl: &BindGroupLayout,
    pipeline_label: &str,
) -> ComputePipeline {
    let shader = device.create_shader_module(ShaderModuleDescriptor {
        label: Some(shader_label),
        source: ShaderSource::Wgsl(src.into()),
    });
    let layout = device.create_pipeline_layout(&PipelineLayoutDescriptor {
        label: None,
        bind_group_layouts: &[bgl],
        push_constant_ranges: &[],
    });
    device.create_compute_pipeline(&ComputePipelineDescriptor {
        label: Some(pipeline_label),
        layout: Some(&layout),
        module: &shader,
        entry_point: Some("main"),
        compilation_options: Default::default(),
        cache: None,
    })
}

fn alloc_tex(device: &Device, w: u32, h: u32, label: &str) -> Texture {
    device.create_texture(&TextureDescriptor {
        label: Some(label),
        size: Extent3d {
            width: w,
            height: h,
            depth_or_array_layers: 1,
        },
        mip_level_count: 1,
        sample_count: 1,
        dimension: TextureDimension::D2,
        format: INTERNAL_TEXTURE_FORMAT,
        usage: TextureUsages::STORAGE_BINDING
            | TextureUsages::COPY_SRC
            | TextureUsages::COPY_DST
            | TextureUsages::TEXTURE_BINDING,
        view_formats: &[],
    })
}

fn dispatch(
    ctx: &GpuContext,
    pipeline: &ComputePipeline,
    bg: &BindGroup,
    w: u32,
    h: u32,
    label: &str,
) {
    let mut enc = ctx
        .device
        .create_command_encoder(&CommandEncoderDescriptor { label: Some(label) });
    {
        let mut pass = enc.begin_compute_pass(&ComputePassDescriptor {
            label: Some(label),
            timestamp_writes: None,
        });
        pass.set_pipeline(pipeline);
        pass.set_bind_group(0, bg, &[]);
        pass.dispatch_workgroups((w + 15) / 16, (h + 15) / 16, 1);
    }
    ctx.queue.submit(Some(enc.finish()));
}

// ─── DenoisePipeline ──────────────────────────────────────────────────────────

impl DenoisePipeline {
    pub fn new(ctx: &GpuContext) -> Self {
        let device = &ctx.device;

        let guide_h_bgl = three_binding_bgl(device, "denoise_guide_h_bgl");
        let guide_v_bgl = three_binding_bgl(device, "denoise_guide_v_bgl");
        let bilateral_h_bgl = four_binding_bgl(device, "denoise_bilateral_h_bgl");
        let bilateral_v_bgl = four_binding_bgl(device, "denoise_bilateral_v_bgl");
        let nlm_bgl = three_binding_bgl(device, "denoise_nlm_bgl");

        Self {
            guide_h_pipeline: make_pipeline(
                device,
                GUIDE_H_WGSL,
                "denoise_guide_h",
                &guide_h_bgl,
                "denoise_guide_h_pl",
            ),
            guide_h_bgl,
            guide_v_pipeline: make_pipeline(
                device,
                GUIDE_V_WGSL,
                "denoise_guide_v",
                &guide_v_bgl,
                "denoise_guide_v_pl",
            ),
            guide_v_bgl,
            bilateral_h_pipeline: make_pipeline(
                device,
                BILATERAL_H_WGSL,
                "denoise_bilateral_h",
                &bilateral_h_bgl,
                "denoise_bilateral_h_pl",
            ),
            bilateral_h_bgl,
            bilateral_v_pipeline: make_pipeline(
                device,
                BILATERAL_V_WGSL,
                "denoise_bilateral_v",
                &bilateral_v_bgl,
                "denoise_bilateral_v_pl",
            ),
            bilateral_v_bgl,
            nlm_pipeline: make_pipeline(
                device,
                NLM_WGSL,
                "denoise_nlm",
                &nlm_bgl,
                "denoise_nlm_pl",
            ),
            nlm_bgl,
        }
    }

    pub fn process(
        &self,
        ctx: &GpuContext,
        input_tex: &Texture,
        params: DenoiseParams,
        effect_space: EffectSpace,
    ) -> Texture {
        let device = &ctx.device;
        let (w, h) = (input_tex.width(), input_tex.height());

        if params.luma_strength == 0.0 && params.chroma_strength == 0.0 {
            let output = alloc_tex(device, w, h, "denoise_passthrough");
            let mut encoder = device.create_command_encoder(&CommandEncoderDescriptor {
                label: Some("denoise_passthrough"),
            });
            encoder.copy_texture_to_texture(
                input_tex.as_image_copy(),
                output.as_image_copy(),
                Extent3d {
                    width: w,
                    height: h,
                    depth_or_array_layers: 1,
                },
            );
            ctx.queue.submit(std::iter::once(encoder.finish()));
            return output;
        }

        let uniform = DenoiseUniform {
            luma_strength: params.luma_strength,
            chroma_strength: params.chroma_strength,
            step_x: effect_space.step_x,
            step_y: effect_space.step_y,
        };
        let params_buf = create_upload_buffer(
            device,
            &ctx.queue,
            "denoise_params",
            bytemuck::bytes_of(&uniform),
            BufferUsages::UNIFORM,
        );

        if params.mode == 1 {
            return self.run_nlm(ctx, input_tex, w, h, &params_buf);
        }

        // ── Bilateral mode ────────────────────────────────────────────────────
        // 1. Build guide: H-blur → V-blur of the noisy input
        let guide_h_tex = alloc_tex(device, w, h, "denoise_guide_h");
        let guide_tex = alloc_tex(device, w, h, "denoise_guide");
        let bilat_h_tex = alloc_tex(device, w, h, "denoise_bilateral_h");
        let output_tex = alloc_tex(device, w, h, "denoise_output");

        let in_view = input_tex.create_view(&Default::default());
        let guide_h_view = guide_h_tex.create_view(&Default::default());
        let guide_view = guide_tex.create_view(&Default::default());
        let bilat_h_view = bilat_h_tex.create_view(&Default::default());
        let out_view = output_tex.create_view(&Default::default());

        // Guide H pass
        let bg = device.create_bind_group(&BindGroupDescriptor {
            label: Some("denoise_guide_h_bg"),
            layout: &self.guide_h_bgl,
            entries: &[
                BindGroupEntry {
                    binding: 0,
                    resource: BindingResource::TextureView(&in_view),
                },
                BindGroupEntry {
                    binding: 1,
                    resource: BindingResource::TextureView(&guide_h_view),
                },
                BindGroupEntry {
                    binding: 2,
                    resource: params_buf.as_entire_binding(),
                },
            ],
        });
        dispatch(ctx, &self.guide_h_pipeline, &bg, w, h, "denoise_guide_h");

        // Guide V pass
        let bg = device.create_bind_group(&BindGroupDescriptor {
            label: Some("denoise_guide_v_bg"),
            layout: &self.guide_v_bgl,
            entries: &[
                BindGroupEntry {
                    binding: 0,
                    resource: BindingResource::TextureView(&guide_h_view),
                },
                BindGroupEntry {
                    binding: 1,
                    resource: BindingResource::TextureView(&guide_view),
                },
                BindGroupEntry {
                    binding: 2,
                    resource: params_buf.as_entire_binding(),
                },
            ],
        });
        dispatch(ctx, &self.guide_v_pipeline, &bg, w, h, "denoise_guide_v");

        // Bilateral H pass: filter=input, guide=guide → bilat_h
        let bg = device.create_bind_group(&BindGroupDescriptor {
            label: Some("denoise_bilateral_h_bg"),
            layout: &self.bilateral_h_bgl,
            entries: &[
                BindGroupEntry {
                    binding: 0,
                    resource: BindingResource::TextureView(&in_view),
                },
                BindGroupEntry {
                    binding: 1,
                    resource: BindingResource::TextureView(&guide_view),
                },
                BindGroupEntry {
                    binding: 2,
                    resource: BindingResource::TextureView(&bilat_h_view),
                },
                BindGroupEntry {
                    binding: 3,
                    resource: params_buf.as_entire_binding(),
                },
            ],
        });
        dispatch(
            ctx,
            &self.bilateral_h_pipeline,
            &bg,
            w,
            h,
            "denoise_bilateral_h",
        );

        // Bilateral V pass: filter=bilat_h, guide=guide → output
        let bg = device.create_bind_group(&BindGroupDescriptor {
            label: Some("denoise_bilateral_v_bg"),
            layout: &self.bilateral_v_bgl,
            entries: &[
                BindGroupEntry {
                    binding: 0,
                    resource: BindingResource::TextureView(&bilat_h_view),
                },
                BindGroupEntry {
                    binding: 1,
                    resource: BindingResource::TextureView(&guide_view),
                },
                BindGroupEntry {
                    binding: 2,
                    resource: BindingResource::TextureView(&out_view),
                },
                BindGroupEntry {
                    binding: 3,
                    resource: params_buf.as_entire_binding(),
                },
            ],
        });
        dispatch(
            ctx,
            &self.bilateral_v_pipeline,
            &bg,
            w,
            h,
            "denoise_bilateral_v",
        );

        output_tex
    }

    fn run_nlm(
        &self,
        ctx: &GpuContext,
        input_tex: &Texture,
        w: u32,
        h: u32,
        params_buf: &Buffer,
    ) -> Texture {
        let device = &ctx.device;
        let output_tex = alloc_tex(device, w, h, "denoise_nlm_output");
        let in_view = input_tex.create_view(&Default::default());
        let out_view = output_tex.create_view(&Default::default());
        let bg = device.create_bind_group(&BindGroupDescriptor {
            label: Some("denoise_nlm_bg"),
            layout: &self.nlm_bgl,
            entries: &[
                BindGroupEntry {
                    binding: 0,
                    resource: BindingResource::TextureView(&in_view),
                },
                BindGroupEntry {
                    binding: 1,
                    resource: BindingResource::TextureView(&out_view),
                },
                BindGroupEntry {
                    binding: 2,
                    resource: params_buf.as_entire_binding(),
                },
            ],
        });
        dispatch(ctx, &self.nlm_pipeline, &bg, w, h, "denoise_nlm");
        output_tex
    }
}
