// Fused tone + color pipeline using shaders/basic_adjust.wgsl
use crate::{context::GpuContext, INTERNAL_TEXTURE_FORMAT};
use bytemuck::{Pod, Zeroable};
use shade_core::{ColorParams, ToneParams};
use wgpu::*;

const SHADER: &str = include_str!("../../shaders/basic_adjust.wgsl");

/// GPU-side representation of ToneParams — must be Pod + have repr(C).
/// 8 × f32 = 32 bytes (no padding needed).
#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
struct ToneParamsGpu {
    exposure: f32,
    contrast: f32,
    blacks: f32,
    whites: f32,
    highlights: f32,
    shadows: f32,
    gamma: f32,
    _pad: f32,
}

impl From<ToneParams> for ToneParamsGpu {
    fn from(p: ToneParams) -> Self {
        Self {
            exposure: p.exposure,
            contrast: p.contrast,
            blacks: p.blacks,
            whites: p.whites,
            highlights: p.highlights,
            shadows: p.shadows,
            gamma: p.gamma,
            _pad: 0.0,
        }
    }
}

pub struct BasicAdjustPipeline {
    pipeline: ComputePipeline,
    bind_group_layout: BindGroupLayout,
}

impl BasicAdjustPipeline {
    pub fn new(ctx: &GpuContext) -> Self {
        let device = &ctx.device;
        let shader = device.create_shader_module(ShaderModuleDescriptor {
            label: Some("basic_adjust"),
            source: ShaderSource::Wgsl(SHADER.into()),
        });
        let bind_group_layout = device.create_bind_group_layout(&BindGroupLayoutDescriptor {
            label: Some("basic_adjust_bgl"),
            entries: &[
                // input texture
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
                // output storage texture
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
                // tone uniform
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
                // color uniform
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
        });
        let pipeline_layout = device.create_pipeline_layout(&PipelineLayoutDescriptor {
            label: Some("basic_adjust_layout"),
            bind_group_layouts: &[&bind_group_layout],
            push_constant_ranges: &[],
        });
        let pipeline = device.create_compute_pipeline(&ComputePipelineDescriptor {
            label: Some("basic_adjust_pipeline"),
            layout: Some(&pipeline_layout),
            module: &shader,
            entry_point: Some("main"),
            compilation_options: Default::default(),
            cache: None,
        });
        Self {
            pipeline,
            bind_group_layout,
        }
    }

    pub fn process(
        &self,
        ctx: &GpuContext,
        input_tex: &Texture,
        tone: ToneParams,
        color: ColorParams,
    ) -> Texture {
        let device = &ctx.device;
        let queue = &ctx.queue;

        let (width, height) = (input_tex.width(), input_tex.height());
        let output_tex = device.create_texture(&TextureDescriptor {
            label: Some("basic_adjust_out"),
            size: Extent3d {
                width,
                height,
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: TextureDimension::D2,
            format: INTERNAL_TEXTURE_FORMAT,
            usage: TextureUsages::STORAGE_BINDING
                | TextureUsages::COPY_SRC
                | TextureUsages::TEXTURE_BINDING,
            view_formats: &[],
        });

        use wgpu::util::DeviceExt;
        let tone_gpu = ToneParamsGpu::from(tone);
        let tone_buf = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("tone_uniform"),
            contents: bytemuck::bytes_of(&tone_gpu),
            usage: BufferUsages::UNIFORM,
        });
        let color_buf = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("color_uniform"),
            contents: bytemuck::bytes_of(&color),
            usage: BufferUsages::UNIFORM,
        });

        let in_view = input_tex.create_view(&Default::default());
        let out_view = output_tex.create_view(&Default::default());

        let bind_group = device.create_bind_group(&BindGroupDescriptor {
            label: Some("basic_adjust_bg"),
            layout: &self.bind_group_layout,
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
                    resource: tone_buf.as_entire_binding(),
                },
                BindGroupEntry {
                    binding: 3,
                    resource: color_buf.as_entire_binding(),
                },
            ],
        });

        let mut encoder = device.create_command_encoder(&CommandEncoderDescriptor {
            label: Some("basic_adjust_enc"),
        });
        {
            let mut pass = encoder.begin_compute_pass(&ComputePassDescriptor {
                label: Some("basic_adjust_pass"),
                timestamp_writes: None,
            });
            pass.set_pipeline(&self.pipeline);
            pass.set_bind_group(0, &bind_group, &[]);
            pass.dispatch_workgroups((width + 15) / 16, (height + 15) / 16, 1);
        }
        queue.submit(Some(encoder.finish()));
        output_tex
    }
}
