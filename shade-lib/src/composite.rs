use anyhow::Result;
use bytemuck::{Pod, Zeroable};
use wgpu::{
    BindGroupDescriptor, BindGroupEntry, BindGroupLayout, BindGroupLayoutDescriptor,
    BindGroupLayoutEntry, BindingResource, BindingType, BufferBindingType, BufferUsages,
    ComputePipeline, ComputePipelineDescriptor, Extent3d, PipelineLayoutDescriptor,
    ShaderStages, StorageTextureAccess, Texture, TextureDescriptor, TextureDimension,
    TextureFormat, TextureUsages, TextureViewDescriptor, TextureViewDimension,
};

use crate::{context::create_upload_buffer, GpuContext, INTERNAL_TEXTURE_FORMAT};

const COMPOSITE_WGSL: &str = include_str!("../shaders/composite.wgsl");

/// GPU uniform matching the WGSL `CompositeParams` struct (16 bytes).
#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
pub struct CompositeUniform {
    pub opacity: f32,
    pub blend_mode: u32,
    pub has_mask: u32,
    pub _pad: f32,
}

pub struct CompositePipeline {
    pipeline: ComputePipeline,
    bind_group_layout: BindGroupLayout,
}

impl CompositePipeline {
    pub fn new(ctx: &GpuContext) -> Result<Self> {
        let device = &ctx.device;

        // 5 bindings:
        //   0 — base_tex (texture_2d<f32>, non-filterable float)
        //   1 — layer_tex (texture_2d<f32>, non-filterable float)
        //   2 — mask_tex (texture_2d<f32>, non-filterable float)
        //   3 — output_tex (storage texture write, rgba8unorm)
        //   4 — params uniform
        let bind_group_layout =
            device.create_bind_group_layout(&BindGroupLayoutDescriptor {
                label: Some("composite bind group layout"),
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
                        binding: 2,
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
                        binding: 3,
                        visibility: ShaderStages::COMPUTE,
                        ty: BindingType::StorageTexture {
                            access: StorageTextureAccess::WriteOnly,
                            format: INTERNAL_TEXTURE_FORMAT,
                            view_dimension: TextureViewDimension::D2,
                        },
                        count: None,
                    },
                    BindGroupLayoutEntry {
                        binding: 4,
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

        let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("composite.wgsl"),
            source: wgpu::ShaderSource::Wgsl(COMPOSITE_WGSL.into()),
        });

        let pipeline_layout = device.create_pipeline_layout(&PipelineLayoutDescriptor {
            label: Some("composite pipeline layout"),
            bind_group_layouts: &[&bind_group_layout],
            push_constant_ranges: &[],
        });

        let pipeline = device.create_compute_pipeline(&ComputePipelineDescriptor {
            label: Some("composite compute pipeline"),
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

    /// Composite `layer_tex` over `base_tex` using the given params.
    ///
    /// When `mask_tex` is `None`, a 1×1 white dummy texture is used so the
    /// shader binding is always satisfied.
    ///
    /// Returns a new output texture (same dimensions as `base_tex`).
    pub fn process(
        &self,
        ctx: &GpuContext,
        base_tex: &Texture,
        layer_tex: &Texture,
        mask_tex: Option<&Texture>,
        params: CompositeUniform,
    ) -> Result<Texture> {
        let device = &ctx.device;
        let queue = &ctx.queue;

        let size = base_tex.size();
        let (width, height) = (size.width, size.height);

        // Output texture.
        let output_tex = device.create_texture(&TextureDescriptor {
            label: Some("composite output texture"),
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

        // Dummy 1×1 white texture for when mask_tex is None.
        let dummy_mask_tex;
        let effective_mask_tex: &Texture = if let Some(m) = mask_tex {
            m
        } else {
            dummy_mask_tex = create_white_mask_texture(device, queue);
            &dummy_mask_tex
        };

        let uniform_buf = create_upload_buffer(
            device,
            queue,
            "composite params uniform",
            bytemuck::bytes_of(&params),
            BufferUsages::UNIFORM,
        );

        let base_view = base_tex.create_view(&TextureViewDescriptor::default());
        let layer_view = layer_tex.create_view(&TextureViewDescriptor::default());
        let mask_view = effective_mask_tex.create_view(&TextureViewDescriptor::default());
        let output_view = output_tex.create_view(&TextureViewDescriptor::default());

        let bind_group = device.create_bind_group(&BindGroupDescriptor {
            label: Some("composite bind group"),
            layout: &self.bind_group_layout,
            entries: &[
                BindGroupEntry {
                    binding: 0,
                    resource: BindingResource::TextureView(&base_view),
                },
                BindGroupEntry {
                    binding: 1,
                    resource: BindingResource::TextureView(&layer_view),
                },
                BindGroupEntry {
                    binding: 2,
                    resource: BindingResource::TextureView(&mask_view),
                },
                BindGroupEntry {
                    binding: 3,
                    resource: BindingResource::TextureView(&output_view),
                },
                BindGroupEntry {
                    binding: 4,
                    resource: uniform_buf.as_entire_binding(),
                },
            ],
        });

        let mut encoder =
            device.create_command_encoder(&wgpu::CommandEncoderDescriptor {
                label: Some("composite encoder"),
            });

        {
            let mut pass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor {
                label: Some("composite pass"),
                timestamp_writes: None,
            });
            pass.set_pipeline(&self.pipeline);
            pass.set_bind_group(0, &bind_group, &[]);
            pass.dispatch_workgroups((width + 15) / 16, (height + 15) / 16, 1);
        }

        queue.submit(std::iter::once(encoder.finish()));

        Ok(output_tex)
    }
}

/// Create a 1×1 Rgba8Unorm texture with all pixels set to white (used as a dummy mask).
fn create_white_mask_texture(device: &wgpu::Device, queue: &wgpu::Queue) -> Texture {
    let tex = device.create_texture(&TextureDescriptor {
        label: Some("dummy white mask"),
        size: Extent3d {
            width: 1,
            height: 1,
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
        wgpu::ImageCopyTexture {
            texture: &tex,
            mip_level: 0,
            origin: wgpu::Origin3d::ZERO,
            aspect: wgpu::TextureAspect::All,
        },
        &[255u8, 255u8, 255u8, 255u8],
        wgpu::ImageDataLayout {
            offset: 0,
            bytes_per_row: Some(4),
            rows_per_image: Some(1),
        },
        Extent3d {
            width: 1,
            height: 1,
            depth_or_array_layers: 1,
        },
    );

    tex
}

/// Create a mask texture (Rgba8Unorm) from R8 pixel data.
/// The input `r8_pixels` has one byte per pixel; it is expanded to RGBA
/// with the value in the R channel and G=B=0, A=255.
pub fn upload_mask_texture(
    device: &wgpu::Device,
    queue: &wgpu::Queue,
    r8_pixels: &[u8],
    width: u32,
    height: u32,
) -> Texture {
    // Expand R8 → RGBA8 (R=value, G=0, B=0, A=255)
    let mut rgba: Vec<u8> = Vec::with_capacity((width * height * 4) as usize);
    for &v in r8_pixels {
        rgba.push(v);
        rgba.push(0);
        rgba.push(0);
        rgba.push(255);
    }

    let tex = device.create_texture(&TextureDescriptor {
        label: Some("mask texture"),
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
        wgpu::ImageCopyTexture {
            texture: &tex,
            mip_level: 0,
            origin: wgpu::Origin3d::ZERO,
            aspect: wgpu::TextureAspect::All,
        },
        &rgba,
        wgpu::ImageDataLayout {
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

    tex
}

// ─── BrushStampPipeline ───────────────────────────────────────────────────────

const BRUSH_STAMP_WGSL: &str = include_str!("../shaders/brush_stamp.wgsl");

/// GPU uniform matching the WGSL `BrushParams` struct (32 bytes).
#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
pub struct BrushStampUniform {
    pub center_x: f32,
    pub center_y: f32,
    pub radius: f32,
    pub hardness: f32,
    pub pressure: f32,
    pub erase: u32,
    pub _pad0: f32,
    pub _pad1: f32,
}

pub struct BrushStampPipeline {
    pipeline: ComputePipeline,
    bind_group_layout: BindGroupLayout,
}

impl BrushStampPipeline {
    pub fn new(ctx: &GpuContext) -> Result<Self> {
        let device = &ctx.device;

        // 2 bindings:
        //   0 — mask_tex (storage texture read_write, rgba8unorm)
        //   1 — params uniform
        let bind_group_layout =
            device.create_bind_group_layout(&BindGroupLayoutDescriptor {
                label: Some("brush stamp bind group layout"),
                entries: &[
                    BindGroupLayoutEntry {
                        binding: 0,
                        visibility: ShaderStages::COMPUTE,
                        ty: BindingType::StorageTexture {
                            access: StorageTextureAccess::ReadWrite,
                            format: TextureFormat::Rgba8Unorm,
                            view_dimension: TextureViewDimension::D2,
                        },
                        count: None,
                    },
                    BindGroupLayoutEntry {
                        binding: 1,
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

        let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("brush_stamp.wgsl"),
            source: wgpu::ShaderSource::Wgsl(BRUSH_STAMP_WGSL.into()),
        });

        let pipeline_layout = device.create_pipeline_layout(&PipelineLayoutDescriptor {
            label: Some("brush stamp pipeline layout"),
            bind_group_layouts: &[&bind_group_layout],
            push_constant_ranges: &[],
        });

        let pipeline = device.create_compute_pipeline(&ComputePipelineDescriptor {
            label: Some("brush stamp compute pipeline"),
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

    /// Stamp a brush footprint onto `mask_tex` in-place.
    ///
    /// `mask_tex` must be Rgba8Unorm with STORAGE_BINDING | COPY_SRC usage.
    pub fn stamp(
        &self,
        ctx: &GpuContext,
        mask_tex: &Texture,
        params: BrushStampUniform,
    ) -> Result<()> {
        let device = &ctx.device;
        let queue = &ctx.queue;

        let size = mask_tex.size();
        let (width, height) = (size.width, size.height);

        let uniform_buf = create_upload_buffer(
            device,
            queue,
            "brush stamp params uniform",
            bytemuck::bytes_of(&params),
            BufferUsages::UNIFORM,
        );

        let mask_view = mask_tex.create_view(&TextureViewDescriptor::default());

        let bind_group = device.create_bind_group(&BindGroupDescriptor {
            label: Some("brush stamp bind group"),
            layout: &self.bind_group_layout,
            entries: &[
                BindGroupEntry {
                    binding: 0,
                    resource: BindingResource::TextureView(&mask_view),
                },
                BindGroupEntry {
                    binding: 1,
                    resource: uniform_buf.as_entire_binding(),
                },
            ],
        });

        let mut encoder =
            device.create_command_encoder(&wgpu::CommandEncoderDescriptor {
                label: Some("brush stamp encoder"),
            });

        {
            let mut pass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor {
                label: Some("brush stamp pass"),
                timestamp_writes: None,
            });
            pass.set_pipeline(&self.pipeline);
            pass.set_bind_group(0, &bind_group, &[]);
            pass.dispatch_workgroups((width + 15) / 16, (height + 15) / 16, 1);
        }

        queue.submit(std::iter::once(encoder.finish()));

        Ok(())
    }
}

/// Create a mutable Rgba8Unorm mask texture suitable for brush stamping.
/// `r8_pixels` is expanded to RGBA (R=value, G=B=0, A=255).
pub fn create_rw_mask_texture(
    device: &wgpu::Device,
    queue: &wgpu::Queue,
    r8_pixels: &[u8],
    width: u32,
    height: u32,
) -> Texture {
    let mut rgba: Vec<u8> = Vec::with_capacity((width * height * 4) as usize);
    for &v in r8_pixels {
        rgba.push(v);
        rgba.push(0);
        rgba.push(0);
        rgba.push(255);
    }

    let tex = device.create_texture(&TextureDescriptor {
        label: Some("rw mask texture"),
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
            | TextureUsages::COPY_DST,
        view_formats: &[],
    });

    queue.write_texture(
        wgpu::ImageCopyTexture {
            texture: &tex,
            mip_level: 0,
            origin: wgpu::Origin3d::ZERO,
            aspect: wgpu::TextureAspect::All,
        },
        &rgba,
        wgpu::ImageDataLayout {
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

    tex
}
