use anyhow::Result;
use bytemuck::{Pod, Zeroable};
use wgpu::util::DeviceExt;
use wgpu::{
    BindGroup, BindGroupDescriptor, BindGroupEntry, BindGroupLayout, BindGroupLayoutDescriptor,
    BindGroupLayoutEntry, BindingResource, BindingType, BufferBindingType, BufferUsages,
    ComputePipeline, ComputePipelineDescriptor, Extent3d, PipelineLayoutDescriptor,
    ShaderStages, StorageTextureAccess, Texture, TextureDescriptor, TextureDimension,
    TextureFormat, TextureUsages, TextureViewDescriptor, TextureViewDimension,
};

use crate::GpuContext;

const CURVES_WGSL: &str = include_str!("../../../shaders/curves.wgsl");
const COLOR_WGSL: &str = include_str!("../../../shaders/color.wgsl");
const VIGNETTE_WGSL: &str = include_str!("../../../shaders/vignette.wgsl");
const SHARPEN_WGSL: &str = include_str!("../../../shaders/sharpen.wgsl");
const GRAIN_WGSL: &str = include_str!("../../../shaders/grain.wgsl");

// ─── Uniform structs ──────────────────────────────────────────────────────────

/// Uniform for CurvesPipeline. Single u32 padded to 16 bytes.
#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
struct CurvesUniform {
    apply_per_channel: u32,
    _pad: [u32; 3],
}

// ─── Helper: create a simple 3-binding compute pipeline ──────────────────────
// binding 0: texture_2d<f32>  (TEXTURE_BINDING)
// binding 1: texture_storage_2d (STORAGE_BINDING write)
// binding 2: uniform buffer

fn make_simple_bind_group_layout(device: &wgpu::Device, label: &str) -> BindGroupLayout {
    device.create_bind_group_layout(&BindGroupLayoutDescriptor {
        label: Some(label),
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
    })
}

fn make_simple_pipeline(
    device: &wgpu::Device,
    shader_src: &str,
    shader_label: &str,
    layout_label: &str,
    pipeline_label: &str,
    bind_group_layout: &BindGroupLayout,
) -> ComputePipeline {
    let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
        label: Some(shader_label),
        source: wgpu::ShaderSource::Wgsl(shader_src.into()),
    });

    let pipeline_layout = device.create_pipeline_layout(&PipelineLayoutDescriptor {
        label: Some(layout_label),
        bind_group_layouts: &[bind_group_layout],
        push_constant_ranges: &[],
    });

    device.create_compute_pipeline(&ComputePipelineDescriptor {
        label: Some(pipeline_label),
        layout: Some(&pipeline_layout),
        module: &shader,
        entry_point: Some("main"),
        compilation_options: Default::default(),
        cache: None,
    })
}

/// Create an output texture (Rgba8Unorm, STORAGE_BINDING | COPY_SRC | TEXTURE_BINDING).
fn create_output_texture(device: &wgpu::Device, width: u32, height: u32, label: &str) -> Texture {
    device.create_texture(&TextureDescriptor {
        label: Some(label),
        size: Extent3d {
            width,
            height,
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
    })
}

fn dispatch_simple(
    ctx: &GpuContext,
    pipeline: &ComputePipeline,
    bind_group: &BindGroup,
    width: u32,
    height: u32,
    label: &str,
) {
    let mut encoder =
        ctx.device
            .create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some(label) });
    {
        let mut pass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor {
            label: Some(label),
            timestamp_writes: None,
        });
        pass.set_pipeline(pipeline);
        pass.set_bind_group(0, bind_group, &[]);
        pass.dispatch_workgroups((width + 15) / 16, (height + 15) / 16, 1);
    }
    ctx.queue.submit(std::iter::once(encoder.finish()));
}

// ─── CurvesPipeline ───────────────────────────────────────────────────────────

pub struct CurvesPipeline {
    pipeline: ComputePipeline,
    bind_group_layout: BindGroupLayout,
}

impl CurvesPipeline {
    pub fn new(ctx: &GpuContext) -> Result<Self> {
        let device = &ctx.device;

        // Custom layout: 7 bindings (tex_in, tex_out, lut_r, lut_g, lut_b, lut_master, uniform)
        let bind_group_layout = device.create_bind_group_layout(&BindGroupLayoutDescriptor {
            label: Some("curves bind group layout"),
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
                        ty: BufferBindingType::Storage { read_only: true },
                        has_dynamic_offset: false,
                        min_binding_size: None,
                    },
                    count: None,
                },
                BindGroupLayoutEntry {
                    binding: 3,
                    visibility: ShaderStages::COMPUTE,
                    ty: BindingType::Buffer {
                        ty: BufferBindingType::Storage { read_only: true },
                        has_dynamic_offset: false,
                        min_binding_size: None,
                    },
                    count: None,
                },
                BindGroupLayoutEntry {
                    binding: 4,
                    visibility: ShaderStages::COMPUTE,
                    ty: BindingType::Buffer {
                        ty: BufferBindingType::Storage { read_only: true },
                        has_dynamic_offset: false,
                        min_binding_size: None,
                    },
                    count: None,
                },
                BindGroupLayoutEntry {
                    binding: 5,
                    visibility: ShaderStages::COMPUTE,
                    ty: BindingType::Buffer {
                        ty: BufferBindingType::Storage { read_only: true },
                        has_dynamic_offset: false,
                        min_binding_size: None,
                    },
                    count: None,
                },
                BindGroupLayoutEntry {
                    binding: 6,
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

        let shader = ctx.device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("curves.wgsl"),
            source: wgpu::ShaderSource::Wgsl(CURVES_WGSL.into()),
        });

        let pipeline_layout = ctx.device.create_pipeline_layout(&PipelineLayoutDescriptor {
            label: Some("curves pipeline layout"),
            bind_group_layouts: &[&bind_group_layout],
            push_constant_ranges: &[],
        });

        let pipeline = ctx.device.create_compute_pipeline(&ComputePipelineDescriptor {
            label: Some("curves compute pipeline"),
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

    pub fn process(
        &self,
        ctx: &GpuContext,
        input_tex: &Texture,
        lut_r: &[f32],
        lut_g: &[f32],
        lut_b: &[f32],
        lut_master: &[f32],
        per_channel: bool,
    ) -> Result<Texture> {
        let device = &ctx.device;
        let size = input_tex.size();
        let (width, height) = (size.width, size.height);

        let output_tex = create_output_texture(device, width, height, "curves output texture");

        let make_lut_buf = |data: &[f32], label: &str| {
            device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
                label: Some(label),
                contents: bytemuck::cast_slice(data),
                usage: BufferUsages::STORAGE,
            })
        };

        let buf_r = make_lut_buf(lut_r, "lut_r");
        let buf_g = make_lut_buf(lut_g, "lut_g");
        let buf_b = make_lut_buf(lut_b, "lut_b");
        let buf_master = make_lut_buf(lut_master, "lut_master");

        let uniform = CurvesUniform {
            apply_per_channel: if per_channel { 1 } else { 0 },
            _pad: [0; 3],
        };
        let uniform_buf = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("curves uniform"),
            contents: bytemuck::bytes_of(&uniform),
            usage: BufferUsages::UNIFORM,
        });

        let input_view = input_tex.create_view(&TextureViewDescriptor::default());
        let output_view = output_tex.create_view(&TextureViewDescriptor::default());

        let bind_group = device.create_bind_group(&BindGroupDescriptor {
            label: Some("curves bind group"),
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
                    resource: buf_r.as_entire_binding(),
                },
                BindGroupEntry {
                    binding: 3,
                    resource: buf_g.as_entire_binding(),
                },
                BindGroupEntry {
                    binding: 4,
                    resource: buf_b.as_entire_binding(),
                },
                BindGroupEntry {
                    binding: 5,
                    resource: buf_master.as_entire_binding(),
                },
                BindGroupEntry {
                    binding: 6,
                    resource: uniform_buf.as_entire_binding(),
                },
            ],
        });

        dispatch_simple(ctx, &self.pipeline, &bind_group, width, height, "curves pass");

        Ok(output_tex)
    }
}

// ─── ColorPipeline ────────────────────────────────────────────────────────────

pub struct ColorPipeline {
    pipeline: ComputePipeline,
    bind_group_layout: BindGroupLayout,
}

impl ColorPipeline {
    pub fn new(ctx: &GpuContext) -> Result<Self> {
        let device = &ctx.device;
        let bind_group_layout =
            make_simple_bind_group_layout(device, "color bind group layout");
        let pipeline = make_simple_pipeline(
            device,
            COLOR_WGSL,
            "color.wgsl",
            "color pipeline layout",
            "color compute pipeline",
            &bind_group_layout,
        );
        Ok(Self { pipeline, bind_group_layout })
    }

    pub fn process(
        &self,
        ctx: &GpuContext,
        input_tex: &Texture,
        params: shade_core::ColorParams,
    ) -> Result<Texture> {
        let device = &ctx.device;
        let size = input_tex.size();
        let (width, height) = (size.width, size.height);

        let output_tex = create_output_texture(device, width, height, "color output texture");

        let uniform_buf = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("color params uniform"),
            contents: bytemuck::bytes_of(&params),
            usage: BufferUsages::UNIFORM,
        });

        let input_view = input_tex.create_view(&TextureViewDescriptor::default());
        let output_view = output_tex.create_view(&TextureViewDescriptor::default());

        let bind_group = device.create_bind_group(&BindGroupDescriptor {
            label: Some("color bind group"),
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

        dispatch_simple(ctx, &self.pipeline, &bind_group, width, height, "color pass");

        Ok(output_tex)
    }
}

// ─── VignettePipeline ─────────────────────────────────────────────────────────

pub struct VignettePipeline {
    pipeline: ComputePipeline,
    bind_group_layout: BindGroupLayout,
}

impl VignettePipeline {
    pub fn new(ctx: &GpuContext) -> Result<Self> {
        let device = &ctx.device;
        let bind_group_layout =
            make_simple_bind_group_layout(device, "vignette bind group layout");
        let pipeline = make_simple_pipeline(
            device,
            VIGNETTE_WGSL,
            "vignette.wgsl",
            "vignette pipeline layout",
            "vignette compute pipeline",
            &bind_group_layout,
        );
        Ok(Self { pipeline, bind_group_layout })
    }

    pub fn process(
        &self,
        ctx: &GpuContext,
        input_tex: &Texture,
        params: shade_core::VignetteParams,
    ) -> Result<Texture> {
        let device = &ctx.device;
        let size = input_tex.size();
        let (width, height) = (size.width, size.height);

        let output_tex = create_output_texture(device, width, height, "vignette output texture");

        let uniform_buf = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("vignette params uniform"),
            contents: bytemuck::bytes_of(&params),
            usage: BufferUsages::UNIFORM,
        });

        let input_view = input_tex.create_view(&TextureViewDescriptor::default());
        let output_view = output_tex.create_view(&TextureViewDescriptor::default());

        let bind_group = device.create_bind_group(&BindGroupDescriptor {
            label: Some("vignette bind group"),
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

        dispatch_simple(ctx, &self.pipeline, &bind_group, width, height, "vignette pass");

        Ok(output_tex)
    }
}

// ─── SharpenPipeline ──────────────────────────────────────────────────────────

pub struct SharpenPipeline {
    pipeline: ComputePipeline,
    bind_group_layout: BindGroupLayout,
}

impl SharpenPipeline {
    pub fn new(ctx: &GpuContext) -> Result<Self> {
        let device = &ctx.device;
        let bind_group_layout =
            make_simple_bind_group_layout(device, "sharpen bind group layout");
        let pipeline = make_simple_pipeline(
            device,
            SHARPEN_WGSL,
            "sharpen.wgsl",
            "sharpen pipeline layout",
            "sharpen compute pipeline",
            &bind_group_layout,
        );
        Ok(Self { pipeline, bind_group_layout })
    }

    pub fn process(
        &self,
        ctx: &GpuContext,
        input_tex: &Texture,
        params: shade_core::SharpenParams,
    ) -> Result<Texture> {
        let device = &ctx.device;
        let size = input_tex.size();
        let (width, height) = (size.width, size.height);

        let output_tex = create_output_texture(device, width, height, "sharpen output texture");

        // SharpenParams is 2×f32 = 8 bytes; pad to 16 for uniform alignment
        #[repr(C)]
        #[derive(Clone, Copy, Pod, Zeroable)]
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

        let uniform_buf = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("sharpen params uniform"),
            contents: bytemuck::bytes_of(&uniform),
            usage: BufferUsages::UNIFORM,
        });

        let input_view = input_tex.create_view(&TextureViewDescriptor::default());
        let output_view = output_tex.create_view(&TextureViewDescriptor::default());

        let bind_group = device.create_bind_group(&BindGroupDescriptor {
            label: Some("sharpen bind group"),
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

        dispatch_simple(ctx, &self.pipeline, &bind_group, width, height, "sharpen pass");

        Ok(output_tex)
    }
}

// ─── GrainPipeline ────────────────────────────────────────────────────────────

pub struct GrainPipeline {
    pipeline: ComputePipeline,
    bind_group_layout: BindGroupLayout,
}

impl GrainPipeline {
    pub fn new(ctx: &GpuContext) -> Result<Self> {
        let device = &ctx.device;
        let bind_group_layout =
            make_simple_bind_group_layout(device, "grain bind group layout");
        let pipeline = make_simple_pipeline(
            device,
            GRAIN_WGSL,
            "grain.wgsl",
            "grain pipeline layout",
            "grain compute pipeline",
            &bind_group_layout,
        );
        Ok(Self { pipeline, bind_group_layout })
    }

    pub fn process(
        &self,
        ctx: &GpuContext,
        input_tex: &Texture,
        params: shade_core::GrainParams,
    ) -> Result<Texture> {
        let device = &ctx.device;
        let size = input_tex.size();
        let (width, height) = (size.width, size.height);

        let output_tex = create_output_texture(device, width, height, "grain output texture");

        let uniform_buf = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("grain params uniform"),
            contents: bytemuck::bytes_of(&params),
            usage: BufferUsages::UNIFORM,
        });

        let input_view = input_tex.create_view(&TextureViewDescriptor::default());
        let output_view = output_tex.create_view(&TextureViewDescriptor::default());

        let bind_group = device.create_bind_group(&BindGroupDescriptor {
            label: Some("grain bind group"),
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

        dispatch_simple(ctx, &self.pipeline, &bind_group, width, height, "grain pass");

        Ok(output_tex)
    }
}
