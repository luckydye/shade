use anyhow::{anyhow, Result};
use std::collections::{HashMap, VecDeque};
use std::sync::Mutex;
use wgpu::{Adapter, Buffer, BufferDescriptor, BufferUsages, Device, Instance, Queue};

const WORK_TEXTURE_POOL_BUDGET_BYTES: u64 = 384 * 1024 * 1024;
const INTERNAL_TEXTURE_BYTES_PER_PIXEL: u64 = 8;

pub struct WorkTexturePool {
    pub textures: HashMap<(u32, u32), Vec<wgpu::Texture>>,
    pub lru: VecDeque<(u32, u32)>,
    pub bytes: u64,
}

impl WorkTexturePool {
    pub fn new() -> Self {
        Self {
            textures: HashMap::new(),
            lru: VecDeque::new(),
            bytes: 0,
        }
    }
}

/// Owns the core wgpu objects needed for headless GPU compute.
pub struct GpuContext {
    pub instance: Instance,
    pub adapter: Adapter,
    pub device: Device,
    pub queue: Queue,
    pub work_texture_pool: Mutex<WorkTexturePool>,
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
        let key = (width, height);
        let bytes = work_texture_bytes(width, height);
        {
            let mut pool = self
                .work_texture_pool
                .lock()
                .expect("work texture pool poisoned");
            if let Some(texture) = pool.textures.get_mut(&key).and_then(Vec::pop) {
                if pool.textures.get(&key).is_some_and(Vec::is_empty) {
                    pool.textures.remove(&key);
                }
                pool.bytes -= bytes;
                return texture;
            }
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
        let key = (size.width, size.height);
        let bytes = work_texture_bytes(size.width, size.height);
        if bytes > WORK_TEXTURE_POOL_BUDGET_BYTES {
            return;
        }
        let mut pool = self
            .work_texture_pool
            .lock()
            .expect("work texture pool poisoned");
        pool.textures.entry(key).or_default().push(texture);
        pool.lru.push_back(key);
        pool.bytes += bytes;
        trim_work_texture_pool(&mut pool);
    }

    pub fn clear_work_texture_pool(&self) {
        let mut pool = self
            .work_texture_pool
            .lock()
            .expect("work texture pool poisoned");
        pool.textures.clear();
        pool.lru.clear();
        pool.bytes = 0;
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
            work_texture_pool: Mutex::new(WorkTexturePool::new()),
        })
    }
}

pub fn work_texture_bytes(width: u32, height: u32) -> u64 {
    u64::from(width) * u64::from(height) * INTERNAL_TEXTURE_BYTES_PER_PIXEL
}

pub fn trim_work_texture_pool(pool: &mut WorkTexturePool) {
    while pool.bytes > WORK_TEXTURE_POOL_BUDGET_BYTES {
        let key = pool
            .lru
            .pop_front()
            .expect("work texture pool lru must contain evictable texture");
        let Some(textures) = pool.textures.get_mut(&key) else {
            continue;
        };
        if textures.pop().is_none() {
            continue;
        }
        pool.bytes -= work_texture_bytes(key.0, key.1);
        if textures.is_empty() {
            pool.textures.remove(&key);
        }
    }
}
