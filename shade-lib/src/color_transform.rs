use crate::{context::{create_upload_buffer, GpuContext}, INTERNAL_TEXTURE_FORMAT};
use shade_lib::{ColorMatrix3x3, ColorSpace};
use wgpu::*;

const SHADER: &str = include_str!("../shaders/color_transform.wgsl");

/// GPU parameters matching the WGSL ColorTransformParams struct.
#[repr(C)]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
pub struct ColorTransformUniform {
    pub mode: u32,
    pub gamma: f32,
    pub _pad0: f32,
    pub _pad1: f32,
    pub row0: [f32; 4], // matrix row 0 + padding
    pub row1: [f32; 4], // matrix row 1 + padding
    pub row2: [f32; 4], // matrix row 2 + padding
}

impl ColorTransformUniform {
    pub fn identity() -> Self {
        Self {
            mode: 0,
            gamma: 1.0,
            _pad0: 0.0,
            _pad1: 0.0,
            row0: [1.0, 0.0, 0.0, 0.0],
            row1: [0.0, 1.0, 0.0, 0.0],
            row2: [0.0, 0.0, 1.0, 0.0],
        }
    }

    /// Build a uniform for converting from `src` colour space into the ACEScct working space.
    pub fn to_linear_srgb(src: &ColorSpace) -> Self {
        match src {
            ColorSpace::AcesCct => Self::identity(),
            ColorSpace::LinearSrgb => {
                // linear sRGB → AP1 linear → ACEScct (matrix + OETF, no gamma decode)
                Self::with_matrix(9, 1.0, &ColorMatrix3x3::LINEAR_SRGB_TO_AP1)
            }
            ColorSpace::Srgb | ColorSpace::Unknown | ColorSpace::Custom(_) => {
                // sRGB EOTF → AP1 matrix → ACEScct OETF
                Self::with_matrix(6, 1.0, &ColorMatrix3x3::LINEAR_SRGB_TO_AP1)
            }
            ColorSpace::DisplayP3 => {
                // P3 uses the sRGB transfer function; combined P3→sRGB→AP1 matrix
                let m = ColorMatrix3x3::LINEAR_SRGB_TO_AP1
                    .mul(&ColorMatrix3x3::DISPLAY_P3_TO_LINEAR_SRGB);
                Self::with_matrix(6, 1.0, &m)
            }
            ColorSpace::AdobeRgb => {
                let m = ColorMatrix3x3::LINEAR_SRGB_TO_AP1
                    .mul(&ColorMatrix3x3::ADOBE_RGB_TO_LINEAR_SRGB);
                Self::with_matrix(8, 2.2, &m)
            }
            ColorSpace::ProPhotoRgb => {
                let m = ColorMatrix3x3::LINEAR_SRGB_TO_AP1
                    .mul(&ColorMatrix3x3::PROPHOTO_TO_LINEAR_SRGB);
                Self::with_matrix(8, 1.8, &m)
            }
        }
    }

    /// Build a uniform for converting from the ACEScct working space to `dst` colour space.
    pub fn from_linear_srgb(dst: &ColorSpace) -> Self {
        match dst {
            ColorSpace::AcesCct => Self::identity(),
            ColorSpace::LinearSrgb => {
                // ACEScct EOTF → AP1 inverse → linear sRGB (no output gamma)
                Self::with_matrix(10, 1.0, &ColorMatrix3x3::AP1_TO_LINEAR_SRGB)
            }
            ColorSpace::Srgb | ColorSpace::Unknown => {
                // ACEScct EOTF → AP1 inverse → sRGB OETF
                Self::with_matrix(7, 1.0, &ColorMatrix3x3::AP1_TO_LINEAR_SRGB)
            }
            ColorSpace::DisplayP3 => {
                // ACEScct → AP1 linear → sRGB linear → P3 linear → P3 (sRGB OETF)
                let m = ColorMatrix3x3::LINEAR_SRGB_TO_DISPLAY_P3
                    .mul(&ColorMatrix3x3::AP1_TO_LINEAR_SRGB);
                Self::with_matrix(7, 1.0, &m)
            }
            _ => Self::with_matrix(7, 1.0, &ColorMatrix3x3::AP1_TO_LINEAR_SRGB),
        }
    }

    fn with_matrix(mode: u32, gamma: f32, m: &ColorMatrix3x3) -> Self {
        Self {
            mode,
            gamma,
            _pad0: 0.0,
            _pad1: 0.0,
            row0: [m.m[0][0], m.m[0][1], m.m[0][2], 0.0],
            row1: [m.m[1][0], m.m[1][1], m.m[1][2], 0.0],
            row2: [m.m[2][0], m.m[2][1], m.m[2][2], 0.0],
        }
    }
}

pub struct ColorTransformPipeline {
    pipeline: ComputePipeline,
    bgl: BindGroupLayout,
}

impl ColorTransformPipeline {
    pub fn new(ctx: &GpuContext) -> Self {
        let device = &ctx.device;
        let shader = device.create_shader_module(ShaderModuleDescriptor {
            label: Some("color_transform"),
            source: ShaderSource::Wgsl(SHADER.into()),
        });
        let bgl = device.create_bind_group_layout(&BindGroupLayoutDescriptor {
            label: Some("color_transform_bgl"),
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
        });
        let layout = device.create_pipeline_layout(&PipelineLayoutDescriptor {
            label: None,
            bind_group_layouts: &[&bgl],
            push_constant_ranges: &[],
        });
        let pipeline = device.create_compute_pipeline(&ComputePipelineDescriptor {
            label: Some("color_transform_pipeline"),
            layout: Some(&layout),
            module: &shader,
            entry_point: Some("main"),
            compilation_options: Default::default(),
            cache: None,
        });
        Self { pipeline, bgl }
    }

    /// Apply a colour transform to `input_tex`, returning a new texture.
    pub fn process(
        &self,
        ctx: &GpuContext,
        input_tex: &Texture,
        uniform: ColorTransformUniform,
    ) -> Texture {
        let device = &ctx.device;
        let queue = &ctx.queue;
        let (w, h) = (input_tex.width(), input_tex.height());

        let output_tex = device.create_texture(&TextureDescriptor {
            label: Some("color_transform_out"),
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
                | TextureUsages::TEXTURE_BINDING,
            view_formats: &[],
        });

        let ubuf = create_upload_buffer(
            device,
            &ctx.queue,
            "color_transform_uniform",
            bytemuck::bytes_of(&uniform),
            BufferUsages::UNIFORM,
        );

        let in_view = input_tex.create_view(&Default::default());
        let out_view = output_tex.create_view(&Default::default());

        let bg = device.create_bind_group(&BindGroupDescriptor {
            label: Some("color_transform_bg"),
            layout: &self.bgl,
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
                    resource: ubuf.as_entire_binding(),
                },
            ],
        });

        let mut encoder = device.create_command_encoder(&CommandEncoderDescriptor {
            label: Some("color_transform_enc"),
        });
        {
            let mut pass = encoder.begin_compute_pass(&ComputePassDescriptor {
                label: Some("color_transform_pass"),
                timestamp_writes: None,
            });
            pass.set_pipeline(&self.pipeline);
            pass.set_bind_group(0, &bg, &[]);
            pass.dispatch_workgroups((w + 15) / 16, (h + 15) / 16, 1);
        }
        queue.submit(Some(encoder.finish()));
        output_tex
    }
}
