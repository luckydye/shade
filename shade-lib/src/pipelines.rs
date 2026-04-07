use anyhow::Result;
use bytemuck::{Pod, Zeroable};
use wgpu::util::DeviceExt;
use wgpu::{
    BindGroup, BindGroupDescriptor, BindGroupEntry, BindGroupLayout,
    BindGroupLayoutDescriptor, BindGroupLayoutEntry, BindingResource, BindingType,
    BufferBindingType, BufferUsages, ComputePipeline, ComputePipelineDescriptor,
    Extent3d, PipelineLayoutDescriptor, ShaderStages, StorageTextureAccess, Texture,
    TextureDescriptor, TextureDimension, TextureUsages, TextureViewDescriptor,
    TextureViewDimension,
};

use crate::{GpuContext, INTERNAL_TEXTURE_FORMAT};

const CURVES_WGSL: &str = include_str!("../shaders/curves.wgsl");
const LS_CURVE_WGSL: &str = include_str!("../shaders/ls_curve.wgsl");
const COLOR_WGSL: &str = include_str!("../shaders/color.wgsl");
const VIGNETTE_WGSL: &str = include_str!("../shaders/vignette.wgsl");
const SHARPEN_WGSL: &str = include_str!("../shaders/sharpen.wgsl");
const GRAIN_WGSL: &str = include_str!("../shaders/grain.wgsl");
const GLOW_WGSL: &str = include_str!("../shaders/glow.wgsl");
const HSL_WGSL: &str = include_str!("../shaders/hsl_adjust.wgsl");
const CROP_WGSL: &str = include_str!("../shaders/crop.wgsl");

// ─── Uniform structs ──────────────────────────────────────────────────────────

/// Uniform for CurvesPipeline. Single u32 padded to 16 bytes.
#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
struct CurvesUniform {
    apply_per_channel: u32,
    _pad: [u32; 3],
}

#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
pub struct CropUniform {
    /// Canvas-space region the output texture represents.
    pub out_x: f32,
    pub out_y: f32,
    pub out_width: f32,
    pub out_height: f32,
    /// Rotation pivot in canvas space.
    pub pivot_x: f32,
    pub pivot_y: f32,
    /// Canvas-space region the input texture represents.
    pub in_x: f32,
    pub in_y: f32,
    pub in_width: f32,
    pub in_height: f32,
    pub cos_r: f32,
    pub sin_r: f32,
}

#[derive(Clone, Copy, Debug)]
pub struct EffectSpace {
    pub origin_x: f32,
    pub origin_y: f32,
    pub step_x: f32,
    pub step_y: f32,
    pub reference_width: f32,
    pub reference_height: f32,
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
fn create_output_texture(
    device: &wgpu::Device,
    width: u32,
    height: u32,
    label: &str,
) -> Texture {
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
        format: INTERNAL_TEXTURE_FORMAT,
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
    let mut encoder = ctx
        .device
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

pub struct CropPipeline {
    pipeline: ComputePipeline,
    bind_group_layout: BindGroupLayout,
}

impl CropPipeline {
    pub fn new(ctx: &GpuContext) -> Result<Self> {
        let bind_group_layout =
            make_simple_bind_group_layout(&ctx.device, "crop bind group layout");
        let pipeline = make_simple_pipeline(
            &ctx.device,
            CROP_WGSL,
            "crop.wgsl",
            "crop pipeline layout",
            "crop pipeline",
            &bind_group_layout,
        );
        Ok(Self {
            pipeline,
            bind_group_layout,
        })
    }

    pub fn process(
        &self,
        ctx: &GpuContext,
        input_tex: &Texture,
        params: CropUniform,
    ) -> Result<Texture> {
        let size = input_tex.size();
        self.process_to_size(ctx, input_tex, size.width, size.height, params)
    }

    pub fn process_to_size(
        &self,
        ctx: &GpuContext,
        input_tex: &Texture,
        output_width: u32,
        output_height: u32,
        params: CropUniform,
    ) -> Result<Texture> {
        let output_tex = create_output_texture(
            &ctx.device,
            output_width,
            output_height,
            "crop output",
        );
        let uniform_buf =
            ctx.device
                .create_buffer_init(&wgpu::util::BufferInitDescriptor {
                    label: Some("crop uniform"),
                    contents: bytemuck::bytes_of(&params),
                    usage: BufferUsages::UNIFORM,
                });
        let in_view = input_tex.create_view(&TextureViewDescriptor::default());
        let out_view = output_tex.create_view(&TextureViewDescriptor::default());
        let bind_group = ctx.device.create_bind_group(&BindGroupDescriptor {
            label: Some("crop bind group"),
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
                    resource: uniform_buf.as_entire_binding(),
                },
            ],
        });
        dispatch_simple(
            ctx,
            &self.pipeline,
            &bind_group,
            output_width,
            output_height,
            "crop pass",
        );
        Ok(output_tex)
    }
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
        let bind_group_layout =
            device.create_bind_group_layout(&BindGroupLayoutDescriptor {
                label: Some("curves bind group layout"),
                entries: &[
                    BindGroupLayoutEntry {
                        binding: 0,
                        visibility: ShaderStages::COMPUTE,
                        ty: BindingType::Texture {
                            sample_type: wgpu::TextureSampleType::Float {
                                filterable: false,
                            },
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

        let shader = ctx
            .device
            .create_shader_module(wgpu::ShaderModuleDescriptor {
                label: Some("curves.wgsl"),
                source: wgpu::ShaderSource::Wgsl(CURVES_WGSL.into()),
            });

        let pipeline_layout =
            ctx.device
                .create_pipeline_layout(&PipelineLayoutDescriptor {
                    label: Some("curves pipeline layout"),
                    bind_group_layouts: &[&bind_group_layout],
                    push_constant_ranges: &[],
                });

        let pipeline = ctx
            .device
            .create_compute_pipeline(&ComputePipelineDescriptor {
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

        let output_tex =
            create_output_texture(device, width, height, "curves output texture");

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

        dispatch_simple(
            ctx,
            &self.pipeline,
            &bind_group,
            width,
            height,
            "curves pass",
        );

        Ok(output_tex)
    }
}

// ─── LsCurvePipeline ───────────────────────────────────────────────────────────

pub struct LsCurvePipeline {
    pipeline: ComputePipeline,
    bind_group_layout: BindGroupLayout,
}

impl LsCurvePipeline {
    pub fn new(ctx: &GpuContext) -> Result<Self> {
        let device = &ctx.device;

        let bind_group_layout =
            device.create_bind_group_layout(&BindGroupLayoutDescriptor {
                label: Some("ls_curve bind group layout"),
                entries: &[
                    BindGroupLayoutEntry {
                        binding: 0,
                        visibility: ShaderStages::COMPUTE,
                        ty: BindingType::Texture {
                            sample_type: wgpu::TextureSampleType::Float {
                                filterable: false,
                            },
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
                            ty: BufferBindingType::Storage { read_only: true },
                            has_dynamic_offset: false,
                            min_binding_size: None,
                        },
                        count: None,
                    },
                ],
            });

        let shader = ctx
            .device
            .create_shader_module(wgpu::ShaderModuleDescriptor {
                label: Some("ls_curve.wgsl"),
                source: wgpu::ShaderSource::Wgsl(LS_CURVE_WGSL.into()),
            });

        let pipeline_layout =
            ctx.device
                .create_pipeline_layout(&PipelineLayoutDescriptor {
                    label: Some("ls_curve pipeline layout"),
                    bind_group_layouts: &[&bind_group_layout],
                    push_constant_ranges: &[],
                });

        let pipeline = ctx
            .device
            .create_compute_pipeline(&ComputePipelineDescriptor {
                label: Some("ls_curve compute pipeline"),
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
        lut: &[f32],
    ) -> Result<Texture> {
        let device = &ctx.device;
        let size = input_tex.size();
        let (width, height) = (size.width, size.height);

        let output_tex =
            create_output_texture(device, width, height, "ls_curve output texture");

        let lut_buf = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("ls_curve lut"),
            contents: bytemuck::cast_slice(lut),
            usage: BufferUsages::STORAGE,
        });

        let input_view = input_tex.create_view(&TextureViewDescriptor::default());
        let output_view = output_tex.create_view(&TextureViewDescriptor::default());

        let bind_group = device.create_bind_group(&BindGroupDescriptor {
            label: Some("ls_curve bind group"),
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
                    resource: lut_buf.as_entire_binding(),
                },
            ],
        });

        dispatch_simple(
            ctx,
            &self.pipeline,
            &bind_group,
            width,
            height,
            "ls_curve pass",
        );

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
        Ok(Self {
            pipeline,
            bind_group_layout,
        })
    }

    pub fn process(
        &self,
        ctx: &GpuContext,
        input_tex: &Texture,
        params: shade_lib::ColorParams,
    ) -> Result<Texture> {
        let device = &ctx.device;
        let size = input_tex.size();
        let (width, height) = (size.width, size.height);

        let output_tex =
            create_output_texture(device, width, height, "color output texture");

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

        dispatch_simple(
            ctx,
            &self.pipeline,
            &bind_group,
            width,
            height,
            "color pass",
        );

        Ok(output_tex)
    }
}

// ─── VignettePipeline ─────────────────────────────────────────────────────────

#[repr(C)]
#[derive(Copy, Clone, bytemuck::Pod, bytemuck::Zeroable)]
struct VignetteGpuUniform {
    amount: f32,
    midpoint: f32,
    feather: f32,
    roundness: f32,
    uv_offset_x: f32,
    uv_offset_y: f32,
    uv_scale_x: f32,
    uv_scale_y: f32,
}

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
        Ok(Self {
            pipeline,
            bind_group_layout,
        })
    }

    pub fn process(
        &self,
        ctx: &GpuContext,
        input_tex: &Texture,
        params: shade_lib::VignetteParams,
        uv_offset: (f32, f32),
        uv_scale: (f32, f32),
    ) -> Result<Texture> {
        let device = &ctx.device;
        let size = input_tex.size();
        let (width, height) = (size.width, size.height);

        let output_tex =
            create_output_texture(device, width, height, "vignette output texture");

        let gpu_params = VignetteGpuUniform {
            amount: params.amount,
            midpoint: params.midpoint,
            feather: params.feather,
            roundness: params.roundness,
            uv_offset_x: uv_offset.0,
            uv_offset_y: uv_offset.1,
            uv_scale_x: uv_scale.0,
            uv_scale_y: uv_scale.1,
        };
        let uniform_buf = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("vignette params uniform"),
            contents: bytemuck::bytes_of(&gpu_params),
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

        dispatch_simple(
            ctx,
            &self.pipeline,
            &bind_group,
            width,
            height,
            "vignette pass",
        );

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
        Ok(Self {
            pipeline,
            bind_group_layout,
        })
    }

    pub fn process(
        &self,
        ctx: &GpuContext,
        input_tex: &Texture,
        params: shade_lib::SharpenParams,
    ) -> Result<Texture> {
        let device = &ctx.device;
        let size = input_tex.size();
        let (width, height) = (size.width, size.height);

        let output_tex =
            create_output_texture(device, width, height, "sharpen output texture");

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

        dispatch_simple(
            ctx,
            &self.pipeline,
            &bind_group,
            width,
            height,
            "sharpen pass",
        );

        Ok(output_tex)
    }
}

// ─── GrainPipeline ────────────────────────────────────────────────────────────

pub struct GrainPipeline {
    pipeline: ComputePipeline,
    bind_group_layout: BindGroupLayout,
}

#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
struct GrainUniform {
    grain: [f32; 4],
    image_space0: [f32; 4],
    image_space1: [f32; 4],
}

impl GrainUniform {
    fn new(params: shade_lib::GrainParams, effect_space: EffectSpace) -> Self {
        Self {
            grain: [params.amount, params.size, params.roughness, params.seed],
            image_space0: [
                effect_space.origin_x,
                effect_space.origin_y,
                effect_space.step_x,
                effect_space.step_y,
            ],
            image_space1: [
                effect_space.reference_width,
                effect_space.reference_height,
                0.0,
                0.0,
            ],
        }
    }
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
        Ok(Self {
            pipeline,
            bind_group_layout,
        })
    }

    pub fn process(
        &self,
        ctx: &GpuContext,
        input_tex: &Texture,
        params: shade_lib::GrainParams,
        effect_space: EffectSpace,
    ) -> Result<Texture> {
        let device = &ctx.device;
        let size = input_tex.size();
        let (width, height) = (size.width, size.height);

        let output_tex =
            create_output_texture(device, width, height, "grain output texture");
        let uniform = GrainUniform::new(params, effect_space);

        let uniform_buf = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("grain params uniform"),
            contents: bytemuck::bytes_of(&uniform),
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

        dispatch_simple(
            ctx,
            &self.pipeline,
            &bind_group,
            width,
            height,
            "grain pass",
        );

        Ok(output_tex)
    }
}

// ─── HslPipeline ──────────────────────────────────────────────────────────────

pub struct GlowPipeline {
    pipeline: ComputePipeline,
    bind_group_layout: BindGroupLayout,
}

#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
struct GlowUniform {
    glow: [f32; 4],
    image_space: [f32; 4],
}

impl GlowUniform {
    fn new(params: shade_lib::GlowParams, effect_space: EffectSpace) -> Self {
        Self {
            glow: [params.amount, effect_space.step_x, effect_space.step_y, 0.0],
            image_space: [
                effect_space.reference_width,
                effect_space.reference_height,
                0.0,
                0.0,
            ],
        }
    }
}

impl GlowPipeline {
    pub fn new(ctx: &GpuContext) -> Result<Self> {
        let device = &ctx.device;
        let bind_group_layout =
            make_simple_bind_group_layout(device, "glow bind group layout");
        let pipeline = make_simple_pipeline(
            device,
            GLOW_WGSL,
            "glow.wgsl",
            "glow pipeline layout",
            "glow compute pipeline",
            &bind_group_layout,
        );
        Ok(Self {
            pipeline,
            bind_group_layout,
        })
    }

    pub fn process(
        &self,
        ctx: &GpuContext,
        input_tex: &Texture,
        params: shade_lib::GlowParams,
        effect_space: EffectSpace,
    ) -> Result<Texture> {
        let device = &ctx.device;
        let size = input_tex.size();
        let (width, height) = (size.width, size.height);

        let output_tex =
            create_output_texture(device, width, height, "glow output texture");
        let uniform = GlowUniform::new(params, effect_space);

        let uniform_buf = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("glow params uniform"),
            contents: bytemuck::bytes_of(&uniform),
            usage: BufferUsages::UNIFORM,
        });

        let input_view = input_tex.create_view(&TextureViewDescriptor::default());
        let output_view = output_tex.create_view(&TextureViewDescriptor::default());

        let bind_group = device.create_bind_group(&BindGroupDescriptor {
            label: Some("glow bind group"),
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

        dispatch_simple(ctx, &self.pipeline, &bind_group, width, height, "glow pass");

        Ok(output_tex)
    }
}

// ─── HslPipeline ──────────────────────────────────────────────────────────────

#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
struct HslParamsGpu {
    red: [f32; 4], // hue, sat, lum, 0
    green: [f32; 4],
    blue: [f32; 4],
}

impl From<shade_lib::HslParams> for HslParamsGpu {
    fn from(p: shade_lib::HslParams) -> Self {
        Self {
            red: [p.red_hue, p.red_sat, p.red_lum, 0.0],
            green: [p.green_hue, p.green_sat, p.green_lum, 0.0],
            blue: [p.blue_hue, p.blue_sat, p.blue_lum, 0.0],
        }
    }
}

pub struct HslPipeline {
    pipeline: ComputePipeline,
    bind_group_layout: BindGroupLayout,
}

impl HslPipeline {
    pub fn new(ctx: &GpuContext) -> Result<Self> {
        let device = &ctx.device;
        let bind_group_layout =
            make_simple_bind_group_layout(device, "hsl bind group layout");
        let pipeline = make_simple_pipeline(
            device,
            HSL_WGSL,
            "hsl_adjust.wgsl",
            "hsl pipeline layout",
            "hsl compute pipeline",
            &bind_group_layout,
        );
        Ok(Self {
            pipeline,
            bind_group_layout,
        })
    }

    pub fn process(
        &self,
        ctx: &GpuContext,
        input_tex: &Texture,
        params: shade_lib::HslParams,
    ) -> Result<Texture> {
        let device = &ctx.device;
        let size = input_tex.size();
        let (width, height) = (size.width, size.height);
        let output_tex =
            create_output_texture(device, width, height, "hsl output texture");
        let gpu = HslParamsGpu::from(params);
        let uniform_buf = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("hsl params uniform"),
            contents: bytemuck::bytes_of(&gpu),
            usage: BufferUsages::UNIFORM,
        });
        let input_view = input_tex.create_view(&TextureViewDescriptor::default());
        let output_view = output_tex.create_view(&TextureViewDescriptor::default());
        let bind_group = device.create_bind_group(&BindGroupDescriptor {
            label: Some("hsl bind group"),
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
        dispatch_simple(ctx, &self.pipeline, &bind_group, width, height, "hsl pass");
        Ok(output_tex)
    }
}
