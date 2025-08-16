use std::error::Error;
use std::fmt;

/// Error type for file loading operations
#[derive(Debug)]
pub enum FileLoaderError {
    IoError(std::io::Error),
    DecodeError(String),
    UnsupportedFormat(String),
}

impl fmt::Display for FileLoaderError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            FileLoaderError::IoError(e) => write!(f, "IO error: {}", e),
            FileLoaderError::DecodeError(msg) => write!(f, "Decode error: {}", msg),
            FileLoaderError::UnsupportedFormat(msg) => write!(f, "Unsupported format: {}", msg),
        }
    }
}

impl Error for FileLoaderError {}

impl From<std::io::Error> for FileLoaderError {
    fn from(error: std::io::Error) -> Self {
        FileLoaderError::IoError(error)
    }
}

/// Trait for loading different image file types
pub trait ImageLoader {
    /// Check if this loader can handle the given file path
    fn can_load(path: &str) -> bool;

    /// Load image data from file, returning f32 RGBA data and dimensions
    fn load(path: &str) -> Result<(Vec<u8>, (usize, usize)), FileLoaderError>;

    /// Get the name of this loader for debugging
    fn loader_name() -> &'static str;
}

/// OpenEXR image loader
pub struct ExrLoader;

impl ImageLoader for ExrLoader {
    fn can_load(path: &str) -> bool {
        #[cfg(not(target_arch = "wasm32"))]
        {
            // Check file extension first
            if !path.to_lowercase().ends_with(".exr") {
                return false;
            }

            // Verify with magic number
            use std::fs::File;
            use std::io::Read;

            let expected_header = [0x76, 0x2f, 0x31, 0x01];

            let mut file = match File::open(path) {
                Ok(file) => file,
                Err(_) => return false,
            };

            let mut header = [0u8; 4];
            match file.read_exact(&mut header) {
                Ok(_) => header == expected_header,
                Err(_) => false,
            }
        }
        #[cfg(target_arch = "wasm32")]
        {
            path.to_lowercase().ends_with(".exr")
        }
    }

    fn load(path: &str) -> Result<(Vec<u8>, (usize, usize)), FileLoaderError> {
        #[cfg(not(target_arch = "wasm32"))]
        {
            use exr::prelude::*;

            log::info!("Loading OpenEXR file: {}", path);

            let image = read_first_rgba_layer_from_file(
                path,
                |resolution, _| {
                    vec![vec![(0.0, 0.0, 0.0, 1.0); resolution.width()]; resolution.height()]
                },
                |pixel_vector, position, (r, g, b, a): (f32, f32, f32, f32)| {
                    pixel_vector[position.y()][position.x()] = (r, g, b, a);
                },
            ).map_err(|e| FileLoaderError::DecodeError(format!("OpenEXR decode error: {}", e)))?;

            let width = image.layer_data.size.width();
            let height = image.layer_data.size.height();
            let pixel_data = image.layer_data.channel_data.pixels;

            log::info!("Successfully loaded OpenEXR: {}x{}", width, height);

            // Convert to flat byte array in f32 format
            let mut image_data = Vec::with_capacity(width * height * 16);

            for row in pixel_data {
                for (r, g, b, a) in row {
                    image_data.extend_from_slice(&r.to_le_bytes());
                    image_data.extend_from_slice(&g.to_le_bytes());
                    image_data.extend_from_slice(&b.to_le_bytes());
                    image_data.extend_from_slice(&a.to_le_bytes());
                }
            }

            Ok((image_data, (width, height)))
        }
        #[cfg(target_arch = "wasm32")]
        {
            Err(FileLoaderError::UnsupportedFormat("OpenEXR not supported in WASM".to_string()))
        }
    }

    fn loader_name() -> &'static str {
        "OpenEXR"
    }
}

/// Camera raw file loader (CR3, CR2, NEF, ARW, etc.)
pub struct RawLoader;

impl ImageLoader for RawLoader {
    fn can_load(path: &str) -> bool {
        let path_lower = path.to_lowercase();
        path_lower.ends_with(".cr3") ||
        path_lower.ends_with(".cr2") ||
        path_lower.ends_with(".nef") ||
        path_lower.ends_with(".arw") ||
        path_lower.ends_with(".dng") ||
        path_lower.ends_with(".raf") ||
        path_lower.ends_with(".orf") ||
        path_lower.ends_with(".rw2") ||
        path_lower.ends_with(".pef") ||
        path_lower.ends_with(".srw")
    }

    fn load(path: &str) -> Result<(Vec<u8>, (usize, usize)), FileLoaderError> {
        #[cfg(not(target_arch = "wasm32"))]
        {
            use rawler::imgop::develop::RawDevelop;
            use crate::utils::convert_to_float;

            log::info!("Loading camera raw file: {}", path);

            let rawimage = rawler::decode_file(path)
                .map_err(|e| FileLoaderError::DecodeError(format!("Raw decode error: {}", e)))?;

            let pixels = rawimage.pixels_u16();
            log::info!("Raw pixels: {} CPP: {:?}", pixels.len(), rawimage.cpp);

            let (width, height) = (rawimage.width as usize, rawimage.height as usize);
            log::info!("Raw image dimensions: {}x{}", width, height);

            let dev = RawDevelop::default();
            let image = dev.develop_intermediate(&rawimage)
                .map_err(|e| FileLoaderError::DecodeError(format!("Raw development error: {}", e)))?;

            let img = image.to_dynamic_image()
                .ok_or_else(|| FileLoaderError::DecodeError("Failed to convert to dynamic image".to_string()))?;

            let rgba_img = img.to_rgba8();
            let (width, height) = rgba_img.dimensions();
            let data = rgba_img.into_raw();

            log::info!("Successfully loaded raw image: {}x{}", width, height);

            // Convert 8-bit RGBA to 32-bit float
            let float_data = convert_to_float(&data);
            Ok((float_data, (width as usize, height as usize)))
        }
        #[cfg(target_arch = "wasm32")]
        {
            Err(FileLoaderError::UnsupportedFormat("Camera raw files not supported in WASM".to_string()))
        }
    }

    fn loader_name() -> &'static str {
        "Camera Raw"
    }
}

/// Standard image format loader (JPEG, PNG, TIFF, etc.)
pub struct StandardLoader;

impl ImageLoader for StandardLoader {
    fn can_load(path: &str) -> bool {
        let path_lower = path.to_lowercase();
        path_lower.ends_with(".jpg") ||
        path_lower.ends_with(".jpeg") ||
        path_lower.ends_with(".png") ||
        path_lower.ends_with(".tiff") ||
        path_lower.ends_with(".tif") ||
        path_lower.ends_with(".bmp") ||
        path_lower.ends_with(".webp") ||
        path_lower.ends_with(".gif") ||
        path_lower.ends_with(".ico")
    }

    fn load(path: &str) -> Result<(Vec<u8>, (usize, usize)), FileLoaderError> {
        #[cfg(not(target_arch = "wasm32"))]
        {
            use image::ImageReader;
            use crate::utils::convert_to_float;

            log::info!("Loading standard image file: {}", path);

            let img_reader = ImageReader::open(path)?;
            let img = img_reader.decode()
                .map_err(|e| FileLoaderError::DecodeError(format!("Image decode error: {}", e)))?;

            let rgba_img = img.to_rgba8();
            let (width, height) = rgba_img.dimensions();
            let data = rgba_img.into_raw();

            log::info!("Successfully loaded standard image: {}x{}", width, height);

            // Convert 8-bit RGBA to 32-bit float
            let float_data = convert_to_float(&data);
            Ok((float_data, (width as usize, height as usize)))
        }
        #[cfg(target_arch = "wasm32")]
        {
            Err(FileLoaderError::UnsupportedFormat("Standard image loading not implemented for WASM".to_string()))
        }
    }

    fn loader_name() -> &'static str {
        "Standard Image"
    }
}

/// Factory function to load an image using the appropriate loader
pub fn load_image(path: &str) -> Result<(Vec<u8>, (usize, usize)), FileLoaderError> {
    // Provide more detailed error information
    let extension = get_file_extension(path).unwrap_or_else(|| "none".to_string());

    if ExrLoader::can_load(path) {
        log::info!("Using {} loader for: {} ({})", ExrLoader::loader_name(), path, extension);
        ExrLoader::load(path)
    } else if RawLoader::can_load(path) {
        log::info!("Using {} loader for: {} ({})", RawLoader::loader_name(), path, extension);
        RawLoader::load(path)
    } else if StandardLoader::can_load(path) {
        log::info!("Using {} loader for: {} ({})", StandardLoader::loader_name(), path, extension);
        StandardLoader::load(path)
    } else {
        let supported_formats: Vec<String> = get_supported_extensions()
            .into_iter()
            .flat_map(|(_, exts)| exts.into_iter().map(|e| e.to_string()))
            .collect();

        Err(FileLoaderError::UnsupportedFormat(
            format!("No suitable loader found for file: {} (extension: {}). Supported formats: {}",
                    path, extension, supported_formats.join(", "))
        ))
    }
}

/// Detect the appropriate loader type for a file path
pub fn detect_file_type(path: &str) -> Option<&'static str> {
    if ExrLoader::can_load(path) {
        Some(ExrLoader::loader_name())
    } else if RawLoader::can_load(path) {
        Some(RawLoader::loader_name())
    } else if StandardLoader::can_load(path) {
        Some(StandardLoader::loader_name())
    } else {
        None
    }
}

/// Get file extension from path
pub fn get_file_extension(path: &str) -> Option<String> {
    std::path::Path::new(path)
        .extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| format!(".{}", ext.to_lowercase()))
}

/// Get all available loaders for debugging/info purposes
pub fn get_supported_extensions() -> Vec<(&'static str, Vec<&'static str>)> {
    vec![
        (ExrLoader::loader_name(), vec![".exr"]),
        (RawLoader::loader_name(), vec![".cr3", ".cr2", ".nef", ".arw", ".dng", ".raf", ".orf", ".rw2", ".pef", ".srw"]),
        (StandardLoader::loader_name(), vec![".jpg", ".jpeg", ".png", ".tiff", ".tif", ".bmp", ".webp", ".gif", ".ico"]),
    ]
}

/// Check if a file extension is supported by any loader
pub fn is_supported_format(path: &str) -> bool {
    detect_file_type(path).is_some()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_exr_can_load() {
        // Test extension checking only (without file existence check)
        #[cfg(target_arch = "wasm32")]
        {
            assert!(ExrLoader::can_load("test.exr"));
            assert!(ExrLoader::can_load("test.EXR"));
            assert!(!ExrLoader::can_load("test.jpg"));
        }

        #[cfg(not(target_arch = "wasm32"))]
        {
            // For non-WASM, just test that it doesn't crash on non-existent files
            assert!(!ExrLoader::can_load("test.exr")); // Will fail due to file not existing
            assert!(!ExrLoader::can_load("test.jpg")); // Will fail due to wrong extension
        }
    }

    #[test]
    fn test_raw_can_load() {
        assert!(RawLoader::can_load("test.cr3"));
        assert!(RawLoader::can_load("test.CR3"));
        assert!(RawLoader::can_load("test.nef"));
        assert!(RawLoader::can_load("test.arw"));
        assert!(!RawLoader::can_load("test.jpg"));
    }

    #[test]
    fn test_standard_can_load() {
        assert!(StandardLoader::can_load("test.jpg"));
        assert!(StandardLoader::can_load("test.JPG"));
        assert!(StandardLoader::can_load("test.png"));
        assert!(StandardLoader::can_load("test.tiff"));
        assert!(!StandardLoader::can_load("test.cr3"));
    }

    #[test]
    fn test_detect_file_type() {
        #[cfg(target_arch = "wasm32")]
        {
            assert_eq!(detect_file_type("test.exr"), Some("OpenEXR"));
        }
        #[cfg(not(target_arch = "wasm32"))]
        {
            // EXR detection requires file to exist for magic number check
            assert_eq!(detect_file_type("test.exr"), None);
        }

        assert_eq!(detect_file_type("test.cr3"), Some("Camera Raw"));
        assert_eq!(detect_file_type("test.jpg"), Some("Standard Image"));
        assert_eq!(detect_file_type("test.unknown"), None);
    }

    #[test]
    fn test_get_file_extension() {
        assert_eq!(get_file_extension("test.jpg"), Some(".jpg".to_string()));
        assert_eq!(get_file_extension("test.JPG"), Some(".jpg".to_string()));
        assert_eq!(get_file_extension("path/to/image.cr3"), Some(".cr3".to_string()));
        assert_eq!(get_file_extension("no_extension"), None);
    }

    #[test]
    fn test_is_supported_format() {
        assert!(is_supported_format("test.jpg"));
        assert!(is_supported_format("test.cr3"));
        assert!(!is_supported_format("test.unknown"));

        #[cfg(target_arch = "wasm32")]
        {
            assert!(is_supported_format("test.exr"));
        }
        #[cfg(not(target_arch = "wasm32"))]
        {
            // EXR requires file to exist for magic number check
            assert!(!is_supported_format("test.exr"));
        }
    }
}
