use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::io::{stdin, stdout};
use std::sync::atomic::{AtomicU64, Ordering};

use crate::Performance;
use crate::cli::{PipelineConfig, PipelineOperation, ProcessingConfig};
use crate::protocol::{
  BinaryAttachment, ImageInput, InitializeParams,
  InitializeResult, Message, MessageTransport, ProcessImageParams,
  ProcessImageResult, ResponseError, ServerCapabilities, ServerInfo,
};
use anyhow::Result;
use anyhow::anyhow;
use base64::Engine;
use image::{ImageBuffer, ImageFormat, Rgba};
use wgpu::{Device, Queue};

use crate::file_loaders::load_image;
use std::collections::HashMap;

/// Cached image data
#[derive(Clone)]
struct CachedImage {
  hash: u64,
  texture_data: Vec<u8>,
  dimensions: (usize, usize),
}

/// Image processing server that handles socket communication
pub struct ImageProcessingServer {
  initialized: bool,
  cached_image: Option<CachedImage>,
  queue: Option<Queue>,
  device: Option<Device>,
}

impl ImageProcessingServer {
  pub fn new() -> Self {
    Self {
      initialized: false,
      cached_image: None,
      queue: None,
      device: None,
    }
  }

  /// Run the server in synchronous socket mode using stdin/stdout
  pub fn run_socket_mode_sync(&mut self) -> Result<(), Box<dyn std::error::Error>> {
    let stdin = stdin();
    let stdout = stdout();
    let mut transport = MessageTransport::new(stdin, stdout);

    log::info!("Image processing server started in socket mode");

    loop {
      match transport.read_message() {
        Ok(msg_with_binary) => {
          let should_shutdown =
            msg_with_binary.message.method.as_deref() == Some("shutdown");

          if let Some((response, binary_data)) =
            pollster::block_on(self.handle_message(msg_with_binary.message))
          {
            if let Err(e) = transport.write_message(&response, &binary_data) {
              log::error!("Failed to send response: {}", e);
              break;
            }
          }

          if should_shutdown {
            log::info!("Shutting down gracefully");
            break;
          }
        }
        Err(e) => {
          log::error!("Failed to read message: {}", e);
          break;
        }
      }
    }

    Ok(())
  }

  /// Handle incoming message and return response if needed
  async fn handle_message(
    &mut self,
    message: Message,
  ) -> Option<(Message, HashMap<String, Vec<u8>>)> {
    match message.method.as_deref() {
      // Just sends capabilities to client
      Some("initialize") => {
        let (response, binary_data) = self.handle_initialize(message).await;
        Some((response, binary_data))
      }
      // processes the image
      Some("process_image") => {
        let (response, binary_data) = self.handle_process_image(message).await;
        Some((response, binary_data))
      }
      // shotdown the process
      Some("shutdown") => {
        log::info!("Shutdown requested");
        Some((
          Message::new_response(message.id.unwrap_or(0), serde_json::Value::Null),
          HashMap::new(),
        ))
      }
      Some(method) => Some((
        Message::new_error_response(message.id, ResponseError::method_not_found(method)),
        HashMap::new(),
      )),
      None => {
        // Response or notification - ignore for now
        None
      }
    }
  }

  /// Handle initialize request
  async fn handle_initialize(
    &mut self,
    message: Message,
  ) -> (Message, HashMap<String, Vec<u8>>) {
    let id = message.id.unwrap_or(0);

    // Initialize the pipeline with GPU resources (moved device and queue so we need to recreate them)
    let instance = wgpu::Instance::default();
    let adapter = instance
      .request_adapter(&wgpu::RequestAdapterOptions::default())
      .await
      .unwrap();

    let (device, queue) = adapter
      .request_device(&wgpu::DeviceDescriptor {
        label: None,
        required_features: wgpu::Features::empty(),
        required_limits: wgpu::Limits::defaults(),
        memory_hints: wgpu::MemoryHints::MemoryUsage,
        trace: wgpu::Trace::Off,
      })
      .await
      .unwrap();

    self.device = Some(device);
    self.queue = Some(queue);

    match message.params {
      Some(params) => match serde_json::from_value::<InitializeParams>(params) {
        Ok(_init_params) => {
          self.initialized = true;

          let capabilities = ServerCapabilities {
            supported_operations: vec![
              "brightness".to_string(),
              "contrast".to_string(),
              "saturation".to_string(),
              "hue".to_string(),
              "gamma".to_string(),
              "white_balance".to_string(),
              "blur".to_string(),
              "sharpen".to_string(),
              "noise".to_string(),
              "scale".to_string(),
              "rotate".to_string(),
            ],
            supported_input_formats: vec![
              "png".to_string(),
              "jpg".to_string(),
              "jpeg".to_string(),
              "bmp".to_string(),
              "tiff".to_string(),
              "exr".to_string(),
              "base64".to_string(),
            ],
            supported_output_formats: vec![
              "png".to_string(),
              "jpg".to_string(),
              "jpeg".to_string(),
              "bmp".to_string(),
              "tiff".to_string(),
            ],
          };

          let result = InitializeResult {
            capabilities,
            server_info: Some(ServerInfo {
              name: "shade-image-processor".to_string(),
              version: Some(env!("CARGO_PKG_VERSION").to_string()),
            }),
          };

          (
            Message::new_response(id, serde_json::to_value(result).unwrap()),
            HashMap::new(),
          )
        }
        Err(e) => (
          Message::new_error_response(
            Some(id),
            ResponseError::invalid_params(format!("Invalid initialize params: {}", e)),
          ),
          HashMap::new(),
        ),
      },
      None => (
        Message::new_error_response(
          Some(id),
          ResponseError::invalid_params("Missing initialize parameters".to_string()),
        ),
        HashMap::new(),
      ),
    }
  }

  /// Handle process_image request
  async fn handle_process_image(
    &mut self,
    message: Message,
  ) -> (Message, HashMap<String, Vec<u8>>) {
    let id = message.id.unwrap_or(0);

    if !self.initialized {
      return (
        Message::new_error_response(
          Some(id),
          ResponseError::new(-32002, "Server not initialized".to_string()),
        ),
        HashMap::new(),
      );
    }

    log::info!("{:?}", message.params);

    match message.params {
      Some(params) => match serde_json::from_value::<ProcessImageParams>(params) {
        Ok(process_params) => match self.process_image_internal(process_params).await {
          Ok((result, binary_data)) => {
            let attachment_id = "processed_image".to_string();
            let attachment = BinaryAttachment {
              id: attachment_id.clone(),
              content_type: "image/png".to_string(),
              size: binary_data.len(),
            };

            let mut binary_map = HashMap::new();
            binary_map.insert(attachment_id, binary_data);

            (
              Message::new_response_with_binary(
                id,
                serde_json::to_value(result).unwrap(),
                vec![attachment],
              ),
              binary_map,
            )
          }
          Err(e) => (
            Message::new_error_response(
              Some(id),
              ResponseError::internal_error(e.to_string()),
            ),
            HashMap::new(),
          ),
        },
        Err(e) => (
          Message::new_error_response(
            Some(id),
            ResponseError::invalid_params(format!("Invalid process_image params: {}", e)),
          ),
          HashMap::new(),
        ),
      },
      None => (
        Message::new_error_response(
          Some(id),
          ResponseError::invalid_params("Missing process_image parameters".to_string()),
        ),
        HashMap::new(),
      ),
    }
  }

  /// Internal image processing logic
  async fn process_image_internal(
    &mut self,
    params: ProcessImageParams,
  ) -> Result<(ProcessImageResult, Vec<u8>)> {
    let time = std::time::Instant::now();
    let mut timing = Performance::default();

    // Build pipeline from operations
    let pipeline_operations: Result<Vec<PipelineOperation>, String> = params
      .operations
      .iter()
      .enumerate()
      .map(|(index, op_spec)| {
        let op_type = op_spec
          .try_into()
          .map_err(|e: String| format!("Operation {}: {}", index, e))?;
        Ok(PipelineOperation { op_type, index })
      })
      .collect();

    // Create a temporary config for pipeline building
    let config = ProcessingConfig {
      input_path: None,
      output_path: None,
      pipeline_config: PipelineConfig {
        operations: pipeline_operations.map_err(|e: String| anyhow!("Error {}", e))?,
      },
      verbose: false,
      config_path: None,
      clear_cache: false,
      show_cache_info: false,
    };

    // load image
    log::info!("Loading image: {:?}", config.input_path);

    let image_file = self
      .load_image_from_input(params.image)
      .await
      .map_err(|e| anyhow!("Error {}", e))?;

    timing.image_load_ms = time.elapsed().as_secs_f64() * 1000.0;

    // let cached_image = self.load_image(image_file).await?;

    // Check if we have this image cached
    let cached_image = self
      .load_and_cache_image(image_file, &mut timing, time)
      .await?;

    // decode image

    timing.image_decode_ms = time.elapsed().as_secs_f64() * 1000.0;
    let time = std::time::Instant::now();

    let mut image_pipeline = config.build_pipeline();

    image_pipeline.init_gpu(
      self.device.clone().unwrap().clone(),
      self.queue.clone().unwrap().clone(),
    );

    timing.gpu_setup_ms = time.elapsed().as_secs_f64() * 1000.0;
    let time = std::time::Instant::now();

    let mut actual_dims = cached_image.dimensions;

    let (processed_data, final_dimensions) = image_pipeline
      .process(
        cached_image.texture_data.clone(),
        (actual_dims.0 as u32, actual_dims.1 as u32),
      )
      .await
      .map_err(|e: String| anyhow!("Operation {}", e))?;

    actual_dims = (final_dimensions.0 as usize, final_dimensions.1 as usize);
    log::info!(
      "Image processed through pipeline with final dimensions: {}x{}",
      actual_dims.0,
      actual_dims.1
    );

    // Convert processed data to output format
    let output_format = params.output_format.unwrap_or_else(|| "png".to_string());
    let binary_data = self.convert_to_binary(&processed_data, final_dimensions)?;

    timing.processing_ms = time.elapsed().as_secs_f64() * 1000.0;
    timing.print_all();

    let result = ProcessImageResult {
      image_attachment_id: "processed_image".to_string(),
      width: actual_dims.0 as u32,
      height: actual_dims.1 as u32,
      format: output_format,
    };

    Ok((result, binary_data))
  }

  /// Load image data from various input formats
  async fn load_image_from_input(&self, input: ImageInput) -> Result<Vec<u8>> {
    match input {
      ImageInput::File { path } => {
        #[cfg(not(target_arch = "wasm32"))]
        {
          let image_file = std::fs::read(&path)?;
          Ok(image_file)
        }
        #[cfg(target_arch = "wasm32")]
        {
          Err("File loading not supported in WASM".into())
        }
      }
      ImageInput::Base64 { data } => {
        let decoded = base64::engine::general_purpose::STANDARD.decode(&data)?;
        Ok(decoded)
      }
      ImageInput::Blob { data } => Ok(data),
    }
  }

  async fn load_image(&mut self, image_file: Vec<u8>) -> Result<CachedImage> {
    let mut hasher = DefaultHasher::new();
    image_file.hash(&mut hasher);
    let image_hash = hasher.finish();

    if let Some(cached_image) = self.cached_image.clone()
      && image_hash == cached_image.hash
    {
      return Ok(cached_image);
    }

    let (image_data, (width, height)) = load_image(&image_file, None)?;

    log::info!("Successfully loaded image: {}x{}", width, height);

    Ok(CachedImage {
      dimensions: (width, height),
      texture_data: image_data,
      hash: image_hash,
    })
  }

  /// Load image and cache it for future requests
  async fn load_and_cache_image(
    &mut self,
    image_file: Vec<u8>,
    timing: &mut Performance,
    time: std::time::Instant,
  ) -> Result<CachedImage> {
    // Load input image if provided
    timing.image_load_ms = time.elapsed().as_secs_f64() * 1000.0;

    let mut hasher = DefaultHasher::new();
    image_file.hash(&mut hasher);
    let image_hash = hasher.finish();

    if let Some(cached_image) = self.cached_image.clone()
      && image_hash == cached_image.hash
    {
      log::info!("Using cached loaded image");
      return Ok(cached_image);
    }

    let (image_data, (width, height)) = load_image(&image_file, None)?;

    log::info!("Successfully loaded image: {}x{}", width, height);

    let loaded_image = CachedImage {
      dimensions: (width, height),
      texture_data: image_data,
      hash: image_hash,
    };

    // Cache the loaded image
    self.cached_image = Some(loaded_image.clone());

    log::info!("Image cached for future requests");

    Ok(loaded_image)
  }

  /// Convert processed float data back to binary image data
  fn convert_to_binary(&self, data: &[u8], dims: (u32, u32)) -> Result<Vec<u8>> {
    // Convert float data back to 8-bit RGBA
    let mut rgba_data = Vec::with_capacity(data.len() / 4);
    for chunk in data.chunks(16) {
      // 16 bytes = 4 f32 values
      let r = f32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]);
      let g = f32::from_le_bytes([chunk[4], chunk[5], chunk[6], chunk[7]]);
      let b = f32::from_le_bytes([chunk[8], chunk[9], chunk[10], chunk[11]]);
      let a = f32::from_le_bytes([chunk[12], chunk[13], chunk[14], chunk[15]]);

      rgba_data.push((r * 255.0).clamp(0.0, 255.0) as u8);
      rgba_data.push((g * 255.0).clamp(0.0, 255.0) as u8);
      rgba_data.push((b * 255.0).clamp(0.0, 255.0) as u8);
      rgba_data.push((a * 255.0).clamp(0.0, 255.0) as u8);
    }

    // Create image buffer and handle format-specific conversions

    let mut cursor = std::io::Cursor::new(Vec::new());
    let image_format = ImageFormat::Png;

    // Use RGBA for formats that support transparency
    let rgba_buffer = ImageBuffer::<Rgba<u8>, _>::from_raw(dims.0, dims.1, rgba_data)
      .ok_or(anyhow!("Failed to create RGBA image buffer"))?;

    rgba_buffer.write_to(&mut cursor, image_format)?;

    Ok(cursor.into_inner())
  }
}

impl Default for ImageProcessingServer {
  fn default() -> Self {
    Self::new()
  }
}
