//! GPU render pass for Slug-style text rendering.
//!
//! Consumes the storage-buffer layout produced by [`crate::text_buffer`] plus
//! a per-layer instance buffer and renders into an Rgba16Float color
//! attachment that the existing [`crate::CompositePipeline`] composites over
//! the rest of the layer stack.
//!
//! This is the first render pass in shade-lib (the rest are compute); the
//! output texture's `RENDER_ATTACHMENT` usage is supplied by the recently
//! widened [`crate::WORK_TEXTURE_USAGE`].

use anyhow::{anyhow, Result};
use bytemuck::{Pod, Zeroable};
use wgpu::{
    BindGroupDescriptor, BindGroupEntry, BindGroupLayout, BindGroupLayoutDescriptor,
    BindGroupLayoutEntry, BindingType, BlendComponent, BlendFactor, BlendOperation, BlendState,
    BufferBindingType, BufferUsages, ColorTargetState, ColorWrites, CommandEncoderDescriptor,
    Face, FragmentState, LoadOp, MultisampleState, Operations, PipelineLayoutDescriptor,
    PrimitiveState, PrimitiveTopology, RenderPassColorAttachment, RenderPassDescriptor,
    RenderPipeline, RenderPipelineDescriptor, ShaderStages, StoreOp, Texture,
    TextureViewDescriptor, VertexState,
};

use crate::context::create_upload_buffer;
use crate::text_buffer::{GlyphBufferLayout, GpuPlacedGlyph};
use crate::{GpuContext, INTERNAL_TEXTURE_FORMAT};

const TEXT_GLYPH_WGSL: &str = include_str!("../shaders/text_glyph.wgsl");

/// Vertices per instance — two triangles forming a unit-square quad.
pub const VERTICES_PER_GLYPH: u32 = 6;

/// 16-byte uniform matching the WGSL `ViewUniform` struct.
#[repr(C)]
#[derive(Debug, Clone, Copy, Pod, Zeroable)]
pub struct TextViewUniform {
    pub target_size: [f32; 2],
    pub _pad: [f32; 2],
}

pub struct TextPipeline {
    pipeline: RenderPipeline,
    bind_group_layout: BindGroupLayout,
}

impl TextPipeline {
    pub fn new(ctx: &GpuContext) -> Result<Self> {
        let device = &ctx.device;

        let bind_group_layout = device.create_bind_group_layout(&BindGroupLayoutDescriptor {
            label: Some("text glyph bind group layout"),
            entries: &[
                storage_entry(0),
                storage_entry(1),
                storage_entry(2),
                storage_entry(3),
                storage_entry(4),
                BindGroupLayoutEntry {
                    binding: 5,
                    visibility: ShaderStages::VERTEX_FRAGMENT,
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
            label: Some("text_glyph.wgsl"),
            source: wgpu::ShaderSource::Wgsl(TEXT_GLYPH_WGSL.into()),
        });

        let pipeline_layout = device.create_pipeline_layout(&PipelineLayoutDescriptor {
            label: Some("text glyph pipeline layout"),
            bind_group_layouts: &[&bind_group_layout],
            push_constant_ranges: &[],
        });

        let pipeline = device.create_render_pipeline(&RenderPipelineDescriptor {
            label: Some("text glyph render pipeline"),
            layout: Some(&pipeline_layout),
            vertex: VertexState {
                module: &shader,
                entry_point: Some("vs_main"),
                compilation_options: Default::default(),
                buffers: &[],
            },
            primitive: PrimitiveState {
                topology: PrimitiveTopology::TriangleList,
                strip_index_format: None,
                front_face: wgpu::FrontFace::Ccw,
                // No culling — overlapping glyphs (rare) and back-facing
                // triangles from negative scaling shouldn't drop fragments.
                cull_mode: None as Option<Face>,
                unclipped_depth: false,
                polygon_mode: wgpu::PolygonMode::Fill,
                conservative: false,
            },
            depth_stencil: None,
            multisample: MultisampleState::default(),
            fragment: Some(FragmentState {
                module: &shader,
                entry_point: Some("fs_main"),
                compilation_options: Default::default(),
                targets: &[Some(ColorTargetState {
                    format: INTERNAL_TEXTURE_FORMAT,
                    // Standard "src-over" with straight alpha — matches the
                    // CompositePipeline's input contract and lets adjacent
                    // glyph quads with overlapping margins composite cleanly.
                    blend: Some(BlendState {
                        color: BlendComponent {
                            src_factor: BlendFactor::SrcAlpha,
                            dst_factor: BlendFactor::OneMinusSrcAlpha,
                            operation: BlendOperation::Add,
                        },
                        alpha: BlendComponent {
                            src_factor: BlendFactor::One,
                            dst_factor: BlendFactor::OneMinusSrcAlpha,
                            operation: BlendOperation::Add,
                        },
                    }),
                    write_mask: ColorWrites::ALL,
                })],
            }),
            multiview: None,
            cache: None,
        });

        Ok(Self {
            pipeline,
            bind_group_layout,
        })
    }

    /// Render `instances` into a fresh Rgba16Float texture sized
    /// `target_width × target_height`. The texture is cleared to transparent
    /// before drawing; on empty input it is returned cleared without invoking
    /// the pipeline.
    pub fn process(
        &self,
        ctx: &GpuContext,
        layout: &GlyphBufferLayout,
        instances: &[GpuPlacedGlyph],
        target_width: u32,
        target_height: u32,
    ) -> Result<Texture> {
        if target_width == 0 || target_height == 0 {
            return Err(anyhow!(
                "text pipeline target must be non-zero, got {target_width}×{target_height}"
            ));
        }

        let device = &ctx.device;
        let queue = &ctx.queue;
        let target = ctx.acquire_work_texture(target_width, target_height, "text layer");
        let view = target.create_view(&TextureViewDescriptor::default());

        // Upload all storage data, padding empty buffers so the bind group
        // remains valid even when no glyphs are queued.
        let curves_buf = upload_storage(
            device,
            queue,
            "text curves",
            bytemuck::cast_slice(&layout.curves),
        );
        let headers_buf = upload_storage(
            device,
            queue,
            "text band headers",
            bytemuck::cast_slice(&layout.band_headers),
        );
        let band_curves_buf = upload_storage(
            device,
            queue,
            "text band curves",
            bytemuck::cast_slice(&layout.band_curves),
        );
        let metas_buf = upload_storage(
            device,
            queue,
            "text glyph metas",
            bytemuck::cast_slice(&layout.glyph_metas),
        );
        let instances_buf = upload_storage(
            device,
            queue,
            "text instances",
            bytemuck::cast_slice(instances),
        );

        let view_uniform = TextViewUniform {
            target_size: [target_width as f32, target_height as f32],
            _pad: [0.0; 2],
        };
        let view_buf = create_upload_buffer(
            device,
            queue,
            "text view uniform",
            bytemuck::bytes_of(&view_uniform),
            BufferUsages::UNIFORM,
        );

        let bind_group = device.create_bind_group(&BindGroupDescriptor {
            label: Some("text glyph bind group"),
            layout: &self.bind_group_layout,
            entries: &[
                BindGroupEntry {
                    binding: 0,
                    resource: curves_buf.as_entire_binding(),
                },
                BindGroupEntry {
                    binding: 1,
                    resource: headers_buf.as_entire_binding(),
                },
                BindGroupEntry {
                    binding: 2,
                    resource: band_curves_buf.as_entire_binding(),
                },
                BindGroupEntry {
                    binding: 3,
                    resource: metas_buf.as_entire_binding(),
                },
                BindGroupEntry {
                    binding: 4,
                    resource: instances_buf.as_entire_binding(),
                },
                BindGroupEntry {
                    binding: 5,
                    resource: view_buf.as_entire_binding(),
                },
            ],
        });

        let mut encoder = device.create_command_encoder(&CommandEncoderDescriptor {
            label: Some("text encoder"),
        });

        {
            let mut pass = encoder.begin_render_pass(&RenderPassDescriptor {
                label: Some("text render pass"),
                color_attachments: &[Some(RenderPassColorAttachment {
                    view: &view,
                    resolve_target: None,
                    ops: Operations {
                        load: LoadOp::Clear(wgpu::Color::TRANSPARENT),
                        store: StoreOp::Store,
                    },
                })],
                depth_stencil_attachment: None,
                timestamp_writes: None,
                occlusion_query_set: None,
            });

            if !instances.is_empty() {
                pass.set_pipeline(&self.pipeline);
                pass.set_bind_group(0, &bind_group, &[]);
                pass.draw(0..VERTICES_PER_GLYPH, 0..instances.len() as u32);
            }
        }

        queue.submit(std::iter::once(encoder.finish()));
        Ok(target)
    }
}

fn storage_entry(binding: u32) -> BindGroupLayoutEntry {
    BindGroupLayoutEntry {
        binding,
        visibility: ShaderStages::VERTEX_FRAGMENT,
        ty: BindingType::Buffer {
            ty: BufferBindingType::Storage { read_only: true },
            has_dynamic_offset: false,
            min_binding_size: None,
        },
        count: None,
    }
}

/// Upload `bytes` as a STORAGE buffer; substitute a 16-byte zero buffer if
/// empty so wgpu validation accepts the binding when the layout has no data.
fn upload_storage(
    device: &wgpu::Device,
    queue: &wgpu::Queue,
    label: &'static str,
    bytes: &[u8],
) -> wgpu::Buffer {
    let payload: &[u8] = if bytes.is_empty() { &[0u8; 16] } else { bytes };
    create_upload_buffer(device, queue, label, payload, BufferUsages::STORAGE)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn text_view_uniform_is_16_bytes() {
        assert_eq!(std::mem::size_of::<TextViewUniform>(), 16);
    }

    /// Parse + validate the WGSL through naga without needing a GPU. Catches
    /// syntax and type-checking errors at `cargo test` time on any host.
    #[test]
    fn shader_parses_and_validates_under_naga() {
        use wgpu::naga::{
            front::wgsl,
            valid::{Capabilities, ValidationFlags, Validator},
        };
        let module = wgsl::parse_str(TEXT_GLYPH_WGSL).unwrap_or_else(|e| {
            panic!("WGSL parse failed:\n{}", e.emit_to_string(TEXT_GLYPH_WGSL))
        });
        Validator::new(ValidationFlags::all(), Capabilities::default())
            .validate(&module)
            .unwrap_or_else(|e| panic!("WGSL validation failed: {e:?}"));
    }
}
