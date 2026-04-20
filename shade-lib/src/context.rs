use anyhow::{anyhow, Result};
use std::collections::HashMap;
use std::sync::Mutex;
use wgpu::{Adapter, Buffer, BufferDescriptor, BufferUsages, Device, Instance, Queue};

/// Owns the core wgpu objects needed for headless GPU compute.
pub struct GpuContext {
    pub instance: Instance,
    pub adapter: Adapter,
    pub device: Device,
    pub queue: Queue,
    work_texture_pool: Mutex<HashMap<(u32, u32), Vec<wgpu::Texture>>>,
}

pub fn create_upload_buffer(
    device: &Device,
    queue: &Queue,
    label: &'static str,
    contents: &[u8],
    usage: BufferUsages,
) -> Buffer {
    let buffer = device.create_buffer(&BufferDescriptor {
        label: Some(label),
        size: contents.len() as u64,
        usage: usage | BufferUsages::COPY_DST,
        mapped_at_creation: false,
    });
    queue.write_buffer(&buffer, 0, contents);
    buffer
}

impl GpuContext {
    pub fn acquire_work_texture(
        &self,
        width: u32,
        height: u32,
        label: &'static str,
    ) -> wgpu::Texture {
        if let Some(texture) = self
            .work_texture_pool
            .lock()
            .expect("work texture pool poisoned")
            .get_mut(&(width, height))
            .and_then(Vec::pop)
        {
            return texture;
        }
        self.device.create_texture(&wgpu::TextureDescriptor {
            label: Some(label),
            size: wgpu::Extent3d {
                width,
                height,
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: crate::INTERNAL_TEXTURE_FORMAT,
            usage: crate::WORK_TEXTURE_USAGE,
            view_formats: &[],
        })
    }

    pub fn release_work_texture(&self, texture: wgpu::Texture) {
        let size = texture.size();
        self.work_texture_pool
            .lock()
            .expect("work texture pool poisoned")
            .entry((size.width, size.height))
            .or_default()
            .push(texture);
    }

    /// Create a headless wgpu context (no surface / window required).
    ///
    /// Requests the high-performance adapter and enables the features needed
    /// for compute shaders with storage-texture writes (rgba8unorm).
    pub async fn new_headless() -> Result<Self> {
        let instance = Instance::new(wgpu::InstanceDescriptor {
            backends: wgpu::Backends::all(),
            ..Default::default()
        });

        let adapter = instance
            .request_adapter(&wgpu::RequestAdapterOptions {
                power_preference: wgpu::PowerPreference::HighPerformance,
                compatible_surface: None,
                force_fallback_adapter: false,
            })
            .await
            .ok_or_else(|| anyhow!("No suitable wgpu adapter found"))?;

        log::info!(
            "Using adapter: {} ({:?})",
            adapter.get_info().name,
            adapter.get_info().backend
        );

        // Enable backend-specific texture format features when available so
        // native backends can use read-write storage textures for mask stamping.
        let optional_features = wgpu::Features::TEXTURE_ADAPTER_SPECIFIC_FORMAT_FEATURES;
        let required_features = wgpu::Features::empty();
        let enabled_features =
            required_features | (adapter.features() & optional_features);

        let (device, queue) = adapter
            .request_device(
                &wgpu::DeviceDescriptor {
                    label: Some("shade-lib device"),
                    required_features: enabled_features,
                    required_limits: wgpu::Limits::default(),
                    memory_hints: wgpu::MemoryHints::default(),
                },
                None,
            )
            .await?;

        Ok(Self {
            instance,
            adapter,
            device,
            queue,
            work_texture_pool: Mutex::new(HashMap::new()),
        })
    }
}
