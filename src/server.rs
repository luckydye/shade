use std::io::{stdin, stdout};
use std::sync::atomic::{AtomicU64, Ordering};

use crate::cli::{CliConfig, PipelineConfig, PipelineOperation};
use crate::protocol::{
  AsyncMessageTransport, ImageInput, InitializeParams, InitializeResult, Message,
  MessageId, MessageTransport, ProcessImageParams, ProcessImageResult, ResponseError,
  ServerCapabilities, ServerInfo,
};
use crate::utils::{is_openexr_file, load_openexr_image};
use base64::Engine;

/// Image processing server that handles socket communication
pub struct ImageProcessingServer {
  next_id: AtomicU64,
  initialized: bool,
}

impl ImageProcessingServer {
  pub fn new() -> Self {
    Self {
      next_id: AtomicU64::new(0),
      initialized: false,
    }
  }

  fn next_message_id(&self) -> MessageId {
    self.next_id.fetch_add(1, Ordering::SeqCst)
  }

  /// Run the server in socket mode using stdin/stdout
  pub async fn run_socket_mode(&mut self) -> Result<(), Box<dyn std::error::Error>> {
    let stdin = tokio::io::stdin();
    let stdout = tokio::io::stdout();
    let mut transport = AsyncMessageTransport::new(stdin, stdout);

    log::info!("Image processing server started in socket mode");

    loop {
      match transport.read_message().await {
        Ok(message) => {
          if let Some(response) = self.handle_message(message).await {
            if let Err(e) = transport.write_message(&response).await {
              log::error!("Failed to send response: {}", e);
              break;
            }
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

  /// Run the server in synchronous socket mode using stdin/stdout
  pub fn run_socket_mode_sync(&mut self) -> Result<(), Box<dyn std::error::Error>> {
    let stdin = stdin();
    let stdout = stdout();
    let mut transport = MessageTransport::new(stdin, stdout);

    log::info!("Image processing server started in socket mode (sync)");

    loop {
      match transport.read_message() {
        Ok(message) => {
          let should_shutdown = message.method.as_deref() == Some("shutdown");

          if let Some(response) = pollster::block_on(self.handle_message(message)) {
            if let Err(e) = transport.write_message(&response) {
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
  async fn handle_message(&mut self, message: Message) -> Option<Message> {
    match message.method.as_deref() {
      // Just sends capabilities to client
      Some("initialize") => Some(self.handle_initialize(message).await),
      // processes the image
      Some("process_image") => Some(self.handle_process_image(message).await),
      // shotdown the process
      Some("shutdown") => {
        log::info!("Shutdown requested");
        Some(Message::new_response(
          message.id.unwrap_or(0),
          serde_json::Value::Null,
        ))
      }
      Some(method) => Some(Message::new_error_response(
        message.id,
        ResponseError::method_not_found(method),
      )),
      None => {
        // Response or notification - ignore for now
        None
      }
    }
  }

  /// Handle initialize request
  async fn handle_initialize(&mut self, message: Message) -> Message {
    let id = message.id.unwrap_or(0);

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

          Message::new_response(id, serde_json::to_value(result).unwrap())
        }
        Err(e) => Message::new_error_response(
          Some(id),
          ResponseError::invalid_params(format!("Invalid initialize params: {}", e)),
        ),
      },
      None => Message::new_error_response(
        Some(id),
        ResponseError::invalid_params("Missing initialize parameters".to_string()),
      ),
    }
  }

  /// Handle process_image request
  async fn handle_process_image(&mut self, message: Message) -> Message {
    let id = message.id.unwrap_or(0);

    if !self.initialized {
      return Message::new_error_response(
        Some(id),
        ResponseError::new(-32002, "Server not initialized".to_string()),
      );
    }

    match message.params {
      Some(params) => match serde_json::from_value::<ProcessImageParams>(params) {
        Ok(process_params) => match self.process_image_internal(process_params).await {
          Ok(result) => Message::new_response(id, serde_json::to_value(result).unwrap()),
          Err(e) => Message::new_error_response(
            Some(id),
            ResponseError::internal_error(e.to_string()),
          ),
        },
        Err(e) => Message::new_error_response(
          Some(id),
          ResponseError::invalid_params(format!("Invalid process_image params: {}", e)),
        ),
      },
      None => Message::new_error_response(
        Some(id),
        ResponseError::invalid_params("Missing process_image parameters".to_string()),
      ),
    }
  }

  /// Internal image processing logic
  async fn process_image_internal(
    &self,
    params: ProcessImageParams,
  ) -> Result<ProcessImageResult, Box<dyn std::error::Error>> {
    // Load image data
    let (texture_data, actual_dims) = self.load_image_from_input(params.image).await?;

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

    let operations = pipeline_operations?;

    let pipeline_config = PipelineConfig {
      operations,
      brightness: None,
      contrast: None,
      saturation: None,
      hue: None,
      gamma: None,
      auto_white_balance: false,
      white_balance_temperature: None,
      white_balance_tint: None,
      blur_radius: None,
      sharpen_amount: None,
      noise_amount: None,
      scale_factor: None,
      rotate_angle: None,
    };

    // Create a temporary config for pipeline building
    let config = CliConfig {
      example: None,
      input_path: None,
      output_path: None,
      pipeline_config,
      verbose: false,
    };

    // Build and initialize pipeline
    let mut image_pipeline = config.build_pipeline();

    // Initialize GPU resources
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
      .await?;

    image_pipeline.init_gpu(device, queue);

    // Process the image
    let processed_data = image_pipeline
      .process(texture_data, (actual_dims.0 as u32, actual_dims.1 as u32))
      .await?;

    // Convert processed data to output format
    let output_format = params.output_format.unwrap_or_else(|| "png".to_string());
    let image_data =
      self.convert_to_base64(&processed_data, actual_dims, &output_format)?;

    Ok(ProcessImageResult {
      image_data,
      width: actual_dims.0 as u32,
      height: actual_dims.1 as u32,
      format: output_format,
    })
  }

  /// Load image data from various input formats
  async fn load_image_from_input(
    &self,
    input: ImageInput,
  ) -> Result<(Vec<u8>, (usize, usize)), Box<dyn std::error::Error>> {
    match input {
      ImageInput::File { path } => {
        #[cfg(not(target_arch = "wasm32"))]
        {
          if is_openexr_file(&path) {
            let (data, dims) = load_openexr_image(&path)?;
            Ok((data, dims))
          } else {
            use image::ImageReader;
            let img_reader = ImageReader::open(&path)?;
            let img = img_reader.decode()?;
            let rgba_img = img.to_rgba8();
            let (width, height) = rgba_img.dimensions();
            let data = rgba_img.into_raw();
            let float_data = self.convert_to_float(&data);
            Ok((float_data, (width as usize, height as usize)))
          }
        }
        #[cfg(target_arch = "wasm32")]
        {
          Err("File loading not supported in WASM".into())
        }
      }
      ImageInput::Base64 { data } => {
        let decoded = base64::engine::general_purpose::STANDARD.decode(&data)?;
        self.load_from_bytes(decoded).await
      }
      ImageInput::Blob { data } => self.load_from_bytes(data).await,
    }
  }

  /// Load image from byte data
  async fn load_from_bytes(
    &self,
    data: Vec<u8>,
  ) -> Result<(Vec<u8>, (usize, usize)), Box<dyn std::error::Error>> {
    let cursor = std::io::Cursor::new(data);
    let img_reader = image::ImageReader::new(cursor).with_guessed_format()?;
    let img = img_reader.decode()?;
    let rgba_img = img.to_rgba8();
    let (width, height) = rgba_img.dimensions();
    let pixel_data = rgba_img.into_raw();
    let float_data = self.convert_to_float(&pixel_data);
    Ok((float_data, (width as usize, height as usize)))
  }

  /// Convert 8-bit RGBA to 32-bit float format (same as in main.rs)
  fn convert_to_float(&self, data: &[u8]) -> Vec<u8> {
    let mut float_data = Vec::with_capacity(data.len() * 4);
    for chunk in data.chunks(4) {
      let r = chunk[0] as f32 / 255.0;
      let g = chunk[1] as f32 / 255.0;
      let b = chunk[2] as f32 / 255.0;
      let a = chunk[3] as f32 / 255.0;

      float_data.extend_from_slice(&r.to_le_bytes());
      float_data.extend_from_slice(&g.to_le_bytes());
      float_data.extend_from_slice(&b.to_le_bytes());
      float_data.extend_from_slice(&a.to_le_bytes());
    }
    float_data
  }

  /// Convert processed float data back to base64 encoded image
  fn convert_to_base64(
    &self,
    data: &[u8],
    dims: (usize, usize),
    format: &str,
  ) -> Result<String, Box<dyn std::error::Error>> {
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
    use image::{ImageBuffer, ImageFormat, Rgb, Rgba};
    let mut cursor = std::io::Cursor::new(Vec::new());
    let image_format = match format.to_lowercase().as_str() {
      "png" => ImageFormat::Png,
      "jpg" | "jpeg" => ImageFormat::Jpeg,
      "bmp" => ImageFormat::Bmp,
      "tiff" => ImageFormat::Tiff,
      _ => ImageFormat::Png, // Default to PNG
    };

    // Handle JPEG separately since it doesn't support alpha channel
    if matches!(image_format, ImageFormat::Jpeg) {
      // Convert RGBA to RGB by dropping alpha channel
      let rgb_data: Vec<u8> = rgba_data
        .chunks(4)
        .flat_map(|chunk| [chunk[0], chunk[1], chunk[2]])
        .collect();

      let rgb_buffer =
        ImageBuffer::<Rgb<u8>, _>::from_raw(dims.0 as u32, dims.1 as u32, rgb_data)
          .ok_or("Failed to create RGB image buffer")?;

      rgb_buffer.write_to(&mut cursor, image_format)?;
    } else {
      // Use RGBA for formats that support transparency
      let rgba_buffer =
        ImageBuffer::<Rgba<u8>, _>::from_raw(dims.0 as u32, dims.1 as u32, rgba_data)
          .ok_or("Failed to create RGBA image buffer")?;

      rgba_buffer.write_to(&mut cursor, image_format)?;
    }
    let encoded_data =
      base64::engine::general_purpose::STANDARD.encode(cursor.into_inner());
    Ok(encoded_data)
  }
}

impl Default for ImageProcessingServer {
  fn default() -> Self {
    Self::new()
  }
}
