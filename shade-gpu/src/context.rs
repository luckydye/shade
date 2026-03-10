use anyhow::{anyhow, Result};
use wgpu::{Adapter, Device, Instance, Queue};

/// Owns the core wgpu objects needed for headless GPU compute.
pub struct GpuContext {
    pub instance: Instance,
    pub adapter: Adapter,
    pub device: Device,
    pub queue: Queue,
}

impl GpuContext {
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
        let enabled_features = required_features | (adapter.features() & optional_features);

        let (device, queue) = adapter
            .request_device(
                &wgpu::DeviceDescriptor {
                    label: Some("shade-gpu device"),
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
        })
    }
}
