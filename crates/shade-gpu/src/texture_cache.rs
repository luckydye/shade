use std::collections::HashMap;
use wgpu::{
    Device, Extent3d, Queue, Texture, TextureDescriptor, TextureDimension, TextureFormat,
    TextureUsages,
};
use wgpu::util::DeviceExt;

/// Caches GPU textures keyed by a u64 content hash.
/// Avoids re-uploading unchanged source images every render call.
pub struct TextureCache {
    map: HashMap<u64, Texture>,
}

impl TextureCache {
    pub fn new() -> Self {
        Self {
            map: HashMap::new(),
        }
    }

    /// Returns a cached texture for `key`, or uploads `pixels` and caches it.
    pub fn get_or_upload(
        &mut self,
        device: &Device,
        queue: &Queue,
        key: u64,
        pixels: &[u8],
        width: u32,
        height: u32,
    ) -> &Texture {
        self.map.entry(key).or_insert_with(|| {
            device.create_texture_with_data(
                queue,
                &TextureDescriptor {
                    label: Some("cached_source"),
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
                },
                wgpu::util::TextureDataOrder::LayerMajor,
                pixels,
            )
        })
    }

    /// Evict a cached entry (call when image source is replaced).
    pub fn evict(&mut self, key: u64) {
        self.map.remove(&key);
    }

    /// Clear all cached textures.
    pub fn clear(&mut self) {
        self.map.clear();
    }
}

impl Default for TextureCache {
    fn default() -> Self {
        Self::new()
    }
}
