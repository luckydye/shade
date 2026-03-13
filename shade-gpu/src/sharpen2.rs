// Two-pass separable Gaussian unsharp mask pipeline
use crate::context::GpuContext;
use bytemuck::{Pod, Zeroable};
use shade_core::SharpenParams;
use wgpu::*;

const SHADER_H: &str = include_str!("../../shaders/sharpen_h.wgsl");
const SHADER_V: &str = include_str!("../../shaders/sharpen_v.wgsl");

pub struct SharpenTwoPassPipeline {
    h_pipeline: ComputePipeline,
    h_bgl: BindGroupLayout,
    v_pipeline: ComputePipeline,
    v_bgl: BindGroupLayout,
}

impl SharpenTwoPassPipeline {
    pub fn new(ctx: &GpuContext) -> Self {
        let device = &ctx.device;

        // ── Horizontal pass ───────────────────────────────────────────────────
        let shader_h = device.create_shader_module(ShaderModuleDescriptor {
            label: Some("sharpen_h"),
            source: ShaderSource::Wgsl(SHADER_H.into()),
        });
        let h_bgl = device.create_bind_group_layout(&BindGroupLayoutDescriptor {
            label: Some("sharpen_h_bgl"),
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
                        format: TextureFormat::Rgba8Unorm,
                        view_dimension: TextureViewDimension::D2,
                    },
                    count: None,
                },
            ],
        });
        let h_layout = device.create_pipeline_layout(&PipelineLayoutDescriptor {
            label: None,
            bind_group_layouts: &[&h_bgl],
            push_constant_ranges: &[],
        });
        let h_pipeline = device.create_compute_pipeline(&ComputePipelineDescriptor {
            label: Some("sharpen_h_pipeline"),
            layout: Some(&h_layout),
            module: &shader_h,
            entry_point: Some("main"),
            compilation_options: Default::default(),
            cache: None,
        });

        // ── Vertical pass + USM ────────────────────────────────────────────────
        let shader_v = device.create_shader_module(ShaderModuleDescriptor {
            label: Some("sharpen_v"),
            source: ShaderSource::Wgsl(SHADER_V.into()),
        });
        let v_bgl = device.create_bind_group_layout(&BindGroupLayoutDescriptor {
            label: Some("sharpen_v_bgl"),
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
                        format: TextureFormat::Rgba8Unorm,
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
        });
        let v_layout = device.create_pipeline_layout(&PipelineLayoutDescriptor {
            label: None,
            bind_group_layouts: &[&v_bgl],
            push_constant_ranges: &[],
        });
        let v_pipeline = device.create_compute_pipeline(&ComputePipelineDescriptor {
            label: Some("sharpen_v_pipeline"),
            layout: Some(&v_layout),
            module: &shader_v,
            entry_point: Some("main"),
            compilation_options: Default::default(),
            cache: None,
        });

        Self {
            h_pipeline,
            h_bgl,
            v_pipeline,
            v_bgl,
        }
    }

    pub fn process(&self, ctx: &GpuContext, input_tex: &Texture, params: SharpenParams) -> Texture {
        let device = &ctx.device;
        let queue = &ctx.queue;
        let (w, h) = (input_tex.width(), input_tex.height());

        // Intermediate texture for the horizontal blur result
        let h_blur_tex = device.create_texture(&TextureDescriptor {
            label: Some("sharpen_h_blur"),
            size: Extent3d {
                width: w,
                height: h,
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: TextureDimension::D2,
            format: TextureFormat::Rgba8Unorm,
            usage: TextureUsages::STORAGE_BINDING | TextureUsages::TEXTURE_BINDING,
            view_formats: &[],
        });

        let output_tex = device.create_texture(&TextureDescriptor {
            label: Some("sharpen_output"),
            size: Extent3d {
                width: w,
                height: h,
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: TextureDimension::D2,
            format: TextureFormat::Rgba8Unorm,
            usage: TextureUsages::STORAGE_BINDING
                | TextureUsages::COPY_SRC
                | TextureUsages::TEXTURE_BINDING,
            view_formats: &[],
        });

        use wgpu::util::DeviceExt;

        // Pad SharpenParams to 16 bytes for uniform alignment
        #[repr(C)]
        #[derive(Pod, Zeroable, Clone, Copy)]
        struct SharpenUniform {
            amount: f32,
            threshold: f32,
            _pad: [f32; 2],
        }
        let uniform = SharpenUniform {
            amount: params.amount,
            threshold: params.threshold,
            _pad: [0.0; 2],
        };
        let params_buf = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("sharpen_params"),
            contents: bytemuck::bytes_of(&uniform),
            usage: BufferUsages::UNIFORM,
        });

        let in_view = input_tex.create_view(&Default::default());
        let hblur_view = h_blur_tex.create_view(&Default::default());
        let out_view = output_tex.create_view(&Default::default());

        let h_bg = device.create_bind_group(&BindGroupDescriptor {
            label: Some("sharpen_h_bg"),
            layout: &self.h_bgl,
            entries: &[
                BindGroupEntry {
                    binding: 0,
                    resource: BindingResource::TextureView(&in_view),
                },
                BindGroupEntry {
                    binding: 1,
                    resource: BindingResource::TextureView(&hblur_view),
                },
            ],
        });
        let v_bg = device.create_bind_group(&BindGroupDescriptor {
            label: Some("sharpen_v_bg"),
            layout: &self.v_bgl,
            entries: &[
                BindGroupEntry {
                    binding: 0,
                    resource: BindingResource::TextureView(&in_view),
                },
                BindGroupEntry {
                    binding: 1,
                    resource: BindingResource::TextureView(&hblur_view),
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

        let mut encoder = device.create_command_encoder(&CommandEncoderDescriptor {
            label: Some("sharpen_enc"),
        });
        {
            let mut pass = encoder.begin_compute_pass(&ComputePassDescriptor {
                label: Some("sharpen_h"),
                timestamp_writes: None,
            });
            pass.set_pipeline(&self.h_pipeline);
            pass.set_bind_group(0, &h_bg, &[]);
            pass.dispatch_workgroups((w + 15) / 16, (h + 15) / 16, 1);
        }
        {
            let mut pass = encoder.begin_compute_pass(&ComputePassDescriptor {
                label: Some("sharpen_v"),
                timestamp_writes: None,
            });
            pass.set_pipeline(&self.v_pipeline);
            pass.set_bind_group(0, &v_bg, &[]);
            pass.dispatch_workgroups((w + 15) / 16, (h + 15) / 16, 1);
        }
        queue.submit(Some(encoder.finish()));
        output_tex
    }
}
