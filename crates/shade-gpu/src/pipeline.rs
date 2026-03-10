use anyhow::Result;
use bytemuck::{Pod, Zeroable};
use shade_core::ToneParams;
use wgpu::util::DeviceExt;
use wgpu::{
    BindGroup, BindGroupDescriptor, BindGroupEntry, BindGroupLayout, BindGroupLayoutDescriptor,
    BindGroupLayoutEntry, BindingResource, BindingType, BufferBindingType, BufferUsages,
    ComputePipeline, ComputePipelineDescriptor, Extent3d, PipelineLayoutDescriptor,
    ShaderStages, StorageTextureAccess, Texture, TextureDescriptor, TextureDimension,
    TextureFormat, TextureUsages, TextureViewDescriptor, TextureViewDimension,
};

use crate::GpuContext;

// The tone.wgsl shader is embedded at compile time.
// Path is relative to crates/shade-gpu/src/: go up 3 levels to shade/, then shaders/tone.wgsl.
const TONE_WGSL: &str = include_str!("../../../shaders/tone.wgsl");

/// GPU-side representation of ToneParams — must be Pod + have repr(C).
#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
struct ToneParamsGpu {
    exposure: f32,
    contrast: f32,
    blacks: f32,
    highlights: f32,
    shadows: f32,
    // Pad to 32 bytes (wgpu uniform buffers need 16-byte alignment; 5 × f32 = 20 bytes,
    // nearest multiple of 16 = 32 bytes → add 3 floats of padding).
    _pad: [f32; 3],
}

impl From<ToneParams> for ToneParamsGpu {
    fn from(p: ToneParams) -> Self {
        Self {
            exposure: p.exposure,
            contrast: p.contrast,
            blacks: p.blacks,
            highlights: p.highlights,
            shadows: p.shadows,
            _pad: [0.0; 3],
        }
    }
}

/// A compute pipeline that applies tone adjustments to a texture.
pub struct TonePipeline {
    pipeline: ComputePipeline,
    bind_group_layout: BindGroupLayout,
}

impl TonePipeline {
    /// Compile the tone WGSL compute pipeline.
    pub fn new(ctx: &GpuContext) -> Result<Self> {
        let device = &ctx.device;

        let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("tone.wgsl"),
            source: wgpu::ShaderSource::Wgsl(TONE_WGSL.into()),
        });

        // Bind group layout:
        //   binding 0 — input texture (texture_2d<f32>, read via textureLoad)
        //   binding 1 — output storage texture (rgba8unorm, write)
        //   binding 2 — uniform buffer (ToneParams)
        let bind_group_layout = device.create_bind_group_layout(&BindGroupLayoutDescriptor {
            label: Some("tone bind group layout"),
            entries: &[
                BindGroupLayoutEntry {
                    binding: 0,
                    visibility: ShaderStages::COMPUTE,
                    ty: BindingType::Texture {
                        sample_type: wgpu::TextureSampleType::Float { filterable: false },
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
        });

        let pipeline_layout = device.create_pipeline_layout(&PipelineLayoutDescriptor {
            label: Some("tone pipeline layout"),
            bind_group_layouts: &[&bind_group_layout],
            push_constant_ranges: &[],
        });

        let pipeline = device.create_compute_pipeline(&ComputePipelineDescriptor {
            label: Some("tone compute pipeline"),
            layout: Some(&pipeline_layout),
            module: &shader,
            entry_point: Some("main"),
            compilation_options: Default::default(),
            cache: None,
        });

        Ok(Self {
            pipeline,
            bind_group_layout,
        })
    }

    /// Apply tone adjustments: reads from `input_tex`, writes to a new Rgba8Unorm texture.
    ///
    /// Returns the output texture (same dimensions as input).
    pub fn process(
        &self,
        ctx: &GpuContext,
        input_tex: &Texture,
        params: ToneParams,
    ) -> Result<Texture> {
        let device = &ctx.device;
        let queue = &ctx.queue;

        let size = input_tex.size();
        let width = size.width;
        let height = size.height;

        // Create output texture (Rgba8Unorm, storage + copy-src for readback).
        let output_tex = device.create_texture(&TextureDescriptor {
            label: Some("tone output texture"),
            size: Extent3d {
                width,
                height,
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: TextureDimension::D2,
            format: TextureFormat::Rgba8Unorm,
            usage: TextureUsages::STORAGE_BINDING | TextureUsages::COPY_SRC,
            view_formats: &[],
        });

        // Uniform buffer for ToneParams.
        let params_gpu = ToneParamsGpu::from(params);
        let uniform_buf = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("tone params uniform"),
            contents: bytemuck::bytes_of(&params_gpu),
            usage: BufferUsages::UNIFORM,
        });

        let input_view = input_tex.create_view(&TextureViewDescriptor::default());
        let output_view = output_tex.create_view(&TextureViewDescriptor::default());

        let bind_group = device.create_bind_group(&BindGroupDescriptor {
            label: Some("tone bind group"),
            layout: &self.bind_group_layout,
            entries: &[
                BindGroupEntry {
                    binding: 0,
                    resource: BindingResource::TextureView(&input_view),
                },
                BindGroupEntry {
                    binding: 1,
                    resource: BindingResource::TextureView(&output_view),
                },
                BindGroupEntry {
                    binding: 2,
                    resource: uniform_buf.as_entire_binding(),
                },
            ],
        });

        // Dispatch compute shader.
        let mut encoder =
            device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("tone") });

        {
            let mut pass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor {
                label: Some("tone pass"),
                timestamp_writes: None,
            });
            pass.set_pipeline(&self.pipeline);
            pass.set_bind_group(0, &bind_group, &[]);
            // Workgroup size is 16×16; dispatch enough groups to cover all pixels.
            let wg_x = (width + 15) / 16;
            let wg_y = (height + 15) / 16;
            pass.dispatch_workgroups(wg_x, wg_y, 1);
        }

        queue.submit(std::iter::once(encoder.finish()));

        Ok(output_tex)
    }

    /// Build a bind group for the given textures and params.
    /// Exposed for use by the Renderer.
    pub fn make_bind_group(
        &self,
        ctx: &GpuContext,
        input_view: &wgpu::TextureView,
        output_view: &wgpu::TextureView,
        uniform_buf: &wgpu::Buffer,
    ) -> BindGroup {
        ctx.device.create_bind_group(&BindGroupDescriptor {
            label: Some("tone bind group"),
            layout: &self.bind_group_layout,
            entries: &[
                BindGroupEntry {
                    binding: 0,
                    resource: BindingResource::TextureView(input_view),
                },
                BindGroupEntry {
                    binding: 1,
                    resource: BindingResource::TextureView(output_view),
                },
                BindGroupEntry {
                    binding: 2,
                    resource: uniform_buf.as_entire_binding(),
                },
            ],
        })
    }
}
