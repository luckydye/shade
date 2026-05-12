use std::cell::RefCell;
use std::collections::{hash_map::DefaultHasher, HashMap, VecDeque};
use std::hash::Hasher;
use std::sync::Arc;
use wgpu::Texture;

use crate::{context::work_texture_bytes, FloatImage};

const TEXTURE_CACHE_BUDGET_BYTES: u64 = 512 * 1024 * 1024;

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub struct TextureCacheKey {
    pub texture_id: u64,
    pub width: u32,
    pub height: u32,
    pub pixels_hash: u64,
    pub pixels_len: usize,
}

impl TextureCacheKey {
    pub fn from_image(texture_id: u64, image: &FloatImage) -> Self {
        Self {
            texture_id,
            width: image.width,
            height: image.height,
            pixels_hash: hash_f32_pixels(image.pixels.as_ref()),
            pixels_len: image.pixels.len(),
        }
    }
}

pub struct TextureCacheEntry {
    pub texture: Arc<Texture>,
    pub bytes: u64,
}

pub struct TextureCacheState {
    pub map: HashMap<TextureCacheKey, TextureCacheEntry>,
    pub lru: VecDeque<TextureCacheKey>,
    pub bytes: u64,
}

/// Caches GPU textures keyed by image identity and pixel contents.
pub struct TextureCache {
    pub state: RefCell<TextureCacheState>,
}

impl TextureCache {
    pub fn new() -> Self {
        Self {
            state: RefCell::new(TextureCacheState {
                map: HashMap::new(),
                lru: VecDeque::new(),
                bytes: 0,
            }),
        }
    }

    /// Returns a cached texture for `key`, or creates and caches it.
    pub fn get_or_insert_with(
        &self,
        key: TextureCacheKey,
        create: impl FnOnce() -> Texture,
    ) -> Arc<Texture> {
        let mut state = self.state.borrow_mut();
        if let Some(entry) = state.map.get(&key) {
            let texture = entry.texture.clone();
            if let Some(position) =
                state.lru.iter().position(|candidate| candidate == &key)
            {
                state.lru.remove(position);
            }
            state.lru.push_back(key);
            return texture;
        }
        let texture = Arc::new(create());
        let bytes = work_texture_bytes(key.width, key.height);
        if bytes > TEXTURE_CACHE_BUDGET_BYTES {
            return texture;
        }
        state.bytes += bytes;
        state.lru.push_back(key);
        state.map.insert(
            key,
            TextureCacheEntry {
                texture: texture.clone(),
                bytes,
            },
        );
        trim_texture_cache(&mut state);
        texture
    }

    /// Evict a cached entry (call when image source is replaced).
    pub fn evict(&self, key: TextureCacheKey) {
        let mut state = self.state.borrow_mut();
        if let Some(entry) = state.map.remove(&key) {
            state.bytes -= entry.bytes;
        }
        if let Some(position) = state.lru.iter().position(|candidate| candidate == &key) {
            state.lru.remove(position);
        }
    }

    /// Clear all cached textures.
    pub fn clear(&self) {
        let mut state = self.state.borrow_mut();
        state.map.clear();
        state.lru.clear();
        state.bytes = 0;
    }
}

impl Default for TextureCache {
    fn default() -> Self {
        Self::new()
    }
}

pub fn hash_f32_pixels(pixels: &[f32]) -> u64 {
    let mut hasher = DefaultHasher::new();
    hasher.write(bytemuck::cast_slice(pixels));
    hasher.finish()
}

pub fn trim_texture_cache(state: &mut TextureCacheState) {
    while state.bytes > TEXTURE_CACHE_BUDGET_BYTES {
        let key = state
            .lru
            .pop_front()
            .expect("texture cache lru must contain evictable texture");
        let entry = state
            .map
            .remove(&key)
            .expect("texture cache lru entry must exist in map");
        state.bytes -= entry.bytes;
    }
}
