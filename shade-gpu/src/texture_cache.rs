use std::cell::RefCell;
use std::collections::HashMap;
use std::sync::Arc;
use wgpu::Texture;

/// Caches GPU textures keyed by a u64 content hash.
/// Avoids re-uploading unchanged source images every render call.
pub struct TextureCache {
    map: RefCell<HashMap<u64, Arc<Texture>>>,
}

impl TextureCache {
    pub fn new() -> Self {
        Self {
            map: RefCell::new(HashMap::new()),
        }
    }

    /// Returns a cached texture for `key`, or creates and caches it.
    pub fn get_or_insert_with(&self, key: u64, create: impl FnOnce() -> Texture) -> Arc<Texture> {
        if let Some(texture) = self.map.borrow().get(&key) {
            return texture.clone();
        }
        let texture = Arc::new(create());
        self.map.borrow_mut().insert(key, texture.clone());
        texture
    }

    /// Evict a cached entry (call when image source is replaced).
    pub fn evict(&mut self, key: u64) {
        self.map.get_mut().remove(&key);
    }

    /// Clear all cached textures.
    pub fn clear(&mut self) {
        self.map.get_mut().clear();
    }
}

impl Default for TextureCache {
    fn default() -> Self {
        Self::new()
    }
}
