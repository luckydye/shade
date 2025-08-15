mod cli;
mod protocol;
mod server;
mod shade;
mod utils;

#[cfg(target_arch = "wasm32")]
use crate::utils::output_image_wasm;
use rawler;
#[cfg(not(target_arch = "wasm32"))]
use utils::{is_openexr_file, load_openexr_image, output_image_native};

use cli::CliConfig;
use server::ImageProcessingServer;
use shade::{BYTES_PER_PIXEL, TEXTURE_FORMAT};
use wgpu::util::DeviceExt;

const TEXTURE_DIMS: (usize, usize) = (512, 512);

struct LoadedImage {
  texture_data: Vec<u8>,
  actual_dims: (usize, usize),
}

pub fn main() {
  let perf = std::time::Instant::now();

  #[cfg(not(target_arch = "wasm32"))]
  {
    env_logger::builder()
      .format_timestamp_millis()
      .init();

    // Check if we should run in socket mode
    let args: Vec<String> = std::env::args().collect();
    if args.len() > 1 && args[1] == "--socket" {
      let mut server = ImageProcessingServer::new();
      if let Err(e) = server.run_socket_mode_sync() {
        eprintln!("Socket server error: {}", e);
        std::process::exit(1);
      }
      return;
    }

    match CliConfig::from_args() {
      Ok(config) => {
        if let Err(e) = cli::validate_config(&config) {
          eprintln!("Error: {}", e);
          std::process::exit(1);
        }

        if config.verbose {
          config.print_pipeline_info();
        }

        log::debug!("Time spent parsing args: {:?}", perf.elapsed());

        pollster::block_on(run(&config));
      }
      Err(e) => {
        eprintln!("Error parsing arguments: {}", e);
        cli::print_examples();
        std::process::exit(1);
      }
    }
  }
  #[cfg(target_arch = "wasm32")]
  {
    std::panic::set_hook(Box::new(console_error_panic_hook::hook));
    console_log::init_with_level(log::Level::Info).expect("could not initialize logger");
    wasm_bindgen_futures::spawn_local(run(None));
  }
}

// Helper function to convert 8-bit RGBA to 32-bit float format
fn convert_to_float(data: &[u8]) -> Vec<u8> {
  let mut float_data = Vec::with_capacity(data.len() * 4); // 4x expansion for f32
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

async fn load_image(config: &CliConfig) -> LoadedImage {
  log::info!("Loading image: {:?}", config.input_path);

  // Load input image if provided
  let (texture_data, actual_dims) = if let Some(input_path) = &config.input_path {
    #[cfg(not(target_arch = "wasm32"))]
    {
      let input_path_str = input_path.to_string_lossy();

      // TODO: read file before decoding, dont decode file by path

      // Check if it's an OpenEXR file first
      if is_openexr_file(&input_path_str) {
        match load_openexr_image(&input_path_str) {
          Ok((exr_data, (width, height))) => {
            log::info!("Loaded OpenEXR input image: {}x{}", width, height);
            // OpenEXR data is already in f32 format, which is what we want
            (exr_data, (width, height))
          }
          Err(e) => {
            log::error!("Failed to load OpenEXR file: {}", e);
            let default_data = (0..(TEXTURE_DIMS.0 * TEXTURE_DIMS.1))
              .flat_map(|_| [0u8, 0u8, 0u8, 255u8])
              .collect::<Vec<u8>>();
            let float_data = convert_to_float(&default_data);
            (float_data, TEXTURE_DIMS)
          }
        }
      } else if input_path_str.ends_with(".CR3") {
        // Use rawler for camera raw files
        match rawler::decode_file(&input_path_str.as_ref()) {
          Ok(rawimage) => {
            use rawler::imgop::develop::RawDevelop;

            let pixels = rawimage.pixels_u16();

            log::info!("Pixels {:?} CPP {:?}", pixels.len(), rawimage.cpp);

            let (width, height) = (rawimage.width as usize, rawimage.height as usize);
            log::info!("Loaded raw input image: {}x{}", width, height);

            let dev = RawDevelop::default();
            let image = dev.develop_intermediate(&rawimage);

            if image.is_ok() {
              let image = image.unwrap();
              let img = image.to_dynamic_image().unwrap();

              let rgba_img = img.to_rgba8();
              let (width, height) = rgba_img.dimensions();
              let data = rgba_img.into_raw();
              log::info!("Loaded input image: {}x{}", width, height);

              // Convert 8-bit RGBA to 32-bit float
              let float_data = convert_to_float(&data);
              (float_data, (width as usize, height as usize))
            } else {
              log::error!("Failed to load raw file");
              let default_data = (0..(TEXTURE_DIMS.0 * TEXTURE_DIMS.1))
                .flat_map(|_| [0u8, 0u8, 0u8, 255u8])
                .collect::<Vec<u8>>();
              let float_data = convert_to_float(&default_data);
              (float_data, TEXTURE_DIMS)
            }
          }
          Err(e) => {
            log::error!("Failed to load raw file: {}", e);
            let default_data = (0..(TEXTURE_DIMS.0 * TEXTURE_DIMS.1))
              .flat_map(|_| [0u8, 0u8, 0u8, 255u8])
              .collect::<Vec<u8>>();
            let float_data = convert_to_float(&default_data);
            (float_data, TEXTURE_DIMS)
          }
        }
      } else {
        // Use standard image loading for other formats
        use image::ImageReader;

        match ImageReader::open(input_path) {
          Ok(img_reader) => {
            match img_reader.decode() {
              Ok(img) => {
                let rgba_img = img.to_rgba8();
                let (width, height) = rgba_img.dimensions();
                let data = rgba_img.into_raw();
                log::info!("Loaded input image: {}x{}", width, height);
                // Convert 8-bit RGBA to 32-bit float
                let float_data = convert_to_float(&data);
                (float_data, (width as usize, height as usize))
              }
              Err(e) => {
                log::error!("Failed to decode image: {}", e);
                let default_data = (0..(TEXTURE_DIMS.0 * TEXTURE_DIMS.1))
                  .flat_map(|_| [0u8, 0u8, 0u8, 255u8])
                  .collect::<Vec<u8>>();
                let float_data = convert_to_float(&default_data);
                (float_data, TEXTURE_DIMS)
              }
            }
          }
          Err(e) => {
            log::error!("Failed to open image file: {}", e);
            let default_data = (0..(TEXTURE_DIMS.0 * TEXTURE_DIMS.1))
              .flat_map(|_| [0u8, 0u8, 0u8, 255u8])
              .collect::<Vec<u8>>();
            let float_data = convert_to_float(&default_data);
            (float_data, TEXTURE_DIMS)
          }
        }
      }
    }
    #[cfg(target_arch = "wasm32")]
    {
      // For WASM, we'll use default texture for now
      let default_data = (0..(TEXTURE_DIMS.0 * TEXTURE_DIMS.1))
        .flat_map(|_| [0u8, 0u8, 0u8, 255u8])
        .collect::<Vec<u8>>();
      let float_data = convert_to_float(&default_data);
      (float_data, TEXTURE_DIMS)
    }
  } else {
    // No input image provided, use default texture
    let default_data = (0..(TEXTURE_DIMS.0 * TEXTURE_DIMS.1))
      .flat_map(|_| [0u8, 0u8, 0u8, 255u8])
      .collect::<Vec<u8>>();
    let float_data = convert_to_float(&default_data);
    (float_data, TEXTURE_DIMS)
  };

  LoadedImage {
    actual_dims: actual_dims,
    texture_data: texture_data,
  }
}

async fn run(config: &CliConfig) {
  let perf = std::time::Instant::now();

  let loaded_image = load_image(config).await;

  log::debug!("Time spent loading image: {:?}", perf.elapsed());
  let perf = std::time::Instant::now();

  let mut image_pipeline = config.build_pipeline();

  let mut texture_data = loaded_image.texture_data;
  let mut actual_dims = loaded_image.actual_dims;

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

  image_pipeline.init_gpu(device.clone(), queue.clone());

  log::debug!("Time spent seting up gpu: {:?}", perf.elapsed());
  let perf = std::time::Instant::now();

  // Process the image through the pipeline using actual dimensions
  match image_pipeline
    .process(
      texture_data.clone(),
      (actual_dims.0 as u32, actual_dims.1 as u32),
    )
    .await
  {
    Ok(processed_data) => {
      texture_data = processed_data;
      log::info!("Image processed through pipeline");
    }
    Err(e) => {
      log::error!("Pipeline processing failed: {}", e);
    }
  }

  log::debug!("Time spent on porcessing: {:?}", perf.elapsed());
  let perf = std::time::Instant::now();

  // Apply resize if specified
  if config.resize_width.is_some() || config.resize_height.is_some() {
    match resize_image(
      texture_data.clone(),
      actual_dims,
      config.resize_width,
      config.resize_height,
      &device,
      &queue,
    )
    .await
    {
      Ok((resized_data, new_dims)) => {
        texture_data = resized_data;
        actual_dims = new_dims;
        log::info!("Image resized to {}x{}", new_dims.0, new_dims.1);
      }
      Err(e) => {
        log::error!("Image resize failed: {}", e);
      }
    }
  }

  log::debug!("Time spent on resize: {:?}", perf.elapsed());
  let perf = std::time::Instant::now();

  // Output using final dimensions
  if let Some(output_path) = &config.output_path {
    #[cfg(not(target_arch = "wasm32"))]
    {
      let output_path_str = output_path.to_string_lossy().to_string();

      // Use standard image output for other formats
      output_image_native(texture_data.to_vec(), actual_dims, output_path_str);
    }
  }
  #[cfg(target_arch = "wasm32")]
  output_image_wasm(texture_data.to_vec(), actual_dims);
  log::info!("Done.");

  log::debug!("Time spent on output: {:?}", perf.elapsed())
}

async fn resize_image(
  texture_data: Vec<u8>,
  current_dims: (usize, usize),
  resize_width: Option<u32>,
  resize_height: Option<u32>,
  device: &wgpu::Device,
  queue: &wgpu::Queue,
) -> Result<(Vec<u8>, (usize, usize)), Box<dyn std::error::Error>> {
  let (current_width, current_height) = current_dims;

  // Calculate target dimensions
  let (target_width, target_height) = match (resize_width, resize_height) {
    (Some(w), Some(h)) => (w as usize, h as usize),
    (Some(w), None) => {
      // Maintain aspect ratio, set width
      let aspect_ratio = current_height as f32 / current_width as f32;
      let h = (w as f32 * aspect_ratio) as usize;
      (w as usize, h)
    }
    (None, Some(h)) => {
      // Maintain aspect ratio, set height
      let aspect_ratio = current_width as f32 / current_height as f32;
      let w = (h as f32 * aspect_ratio) as usize;
      (w, h as usize)
    }
    (None, None) => return Ok((texture_data, current_dims)), // No resize needed
  };

  log::info!(
    "Resizing image from {}x{} to {}x{}",
    current_width,
    current_height,
    target_width,
    target_height
  );

  // Create input texture from current data
  let input_texture = device.create_texture(&wgpu::TextureDescriptor {
    label: Some("Resize Input Texture"),
    size: wgpu::Extent3d {
      width: current_width as u32,
      height: current_height as u32,
      depth_or_array_layers: 1,
    },
    mip_level_count: 1,
    sample_count: 1,
    dimension: wgpu::TextureDimension::D2,
    format: TEXTURE_FORMAT,
    usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
    view_formats: &[],
  });

  // Upload current texture data
  queue.write_texture(
    wgpu::TexelCopyTextureInfo {
      texture: &input_texture,
      mip_level: 0,
      origin: wgpu::Origin3d::ZERO,
      aspect: wgpu::TextureAspect::All,
    },
    &texture_data,
    wgpu::TexelCopyBufferLayout {
      offset: 0,
      bytes_per_row: Some((current_width * BYTES_PER_PIXEL as usize) as u32),
      rows_per_image: Some(current_height as u32),
    },
    wgpu::Extent3d {
      width: current_width as u32,
      height: current_height as u32,
      depth_or_array_layers: 1,
    },
  );

  // Create output texture
  let output_texture = device.create_texture(&wgpu::TextureDescriptor {
    label: Some("Resize Output Texture"),
    size: wgpu::Extent3d {
      width: target_width as u32,
      height: target_height as u32,
      depth_or_array_layers: 1,
    },
    mip_level_count: 1,
    sample_count: 1,
    dimension: wgpu::TextureDimension::D2,
    format: TEXTURE_FORMAT,
    usage: wgpu::TextureUsages::STORAGE_BINDING | wgpu::TextureUsages::COPY_SRC,
    view_formats: &[],
  });

  // Create shader and pipeline for resizing (reuse scale shader)
  let shader = device.create_shader_module(wgpu::include_wgsl!("shaders/scale.wgsl"));

  let bind_group_layout =
    device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
      label: Some("Resize Bind Group Layout"),
      entries: &[
        wgpu::BindGroupLayoutEntry {
          binding: 0,
          visibility: wgpu::ShaderStages::COMPUTE,
          ty: wgpu::BindingType::Texture {
            multisampled: false,
            view_dimension: wgpu::TextureViewDimension::D2,
            sample_type: wgpu::TextureSampleType::Float { filterable: false },
          },
          count: None,
        },
        wgpu::BindGroupLayoutEntry {
          binding: 1,
          visibility: wgpu::ShaderStages::COMPUTE,
          ty: wgpu::BindingType::StorageTexture {
            access: wgpu::StorageTextureAccess::WriteOnly,
            format: TEXTURE_FORMAT,
            view_dimension: wgpu::TextureViewDimension::D2,
          },
          count: None,
        },
        wgpu::BindGroupLayoutEntry {
          binding: 2,
          visibility: wgpu::ShaderStages::COMPUTE,
          ty: wgpu::BindingType::Buffer {
            ty: wgpu::BufferBindingType::Uniform,
            has_dynamic_offset: false,
            min_binding_size: None,
          },
          count: None,
        },
      ],
    });

  // Create uniform buffer with scale factor (set to 1.0 for resize)
  let scale_factor = 1.0f32;
  let uniform_buffer = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
    label: Some("Resize Uniform Buffer"),
    contents: &scale_factor.to_le_bytes(),
    usage: wgpu::BufferUsages::UNIFORM,
  });

  let bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
    label: Some("Resize Bind Group"),
    layout: &bind_group_layout,
    entries: &[
      wgpu::BindGroupEntry {
        binding: 0,
        resource: wgpu::BindingResource::TextureView(
          &input_texture.create_view(&wgpu::TextureViewDescriptor::default()),
        ),
      },
      wgpu::BindGroupEntry {
        binding: 1,
        resource: wgpu::BindingResource::TextureView(
          &output_texture.create_view(&wgpu::TextureViewDescriptor::default()),
        ),
      },
      wgpu::BindGroupEntry {
        binding: 2,
        resource: uniform_buffer.as_entire_binding(),
      },
    ],
  });

  let pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
    label: Some("Resize Pipeline Layout"),
    bind_group_layouts: &[&bind_group_layout],
    push_constant_ranges: &[],
  });

  let pipeline = device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
    label: Some("Resize Pipeline"),
    layout: Some(&pipeline_layout),
    module: &shader,
    entry_point: Some("main"),
    compilation_options: Default::default(),
    cache: None,
  });

  // Execute resize
  let mut command_encoder =
    device.create_command_encoder(&wgpu::CommandEncoderDescriptor {
      label: Some("Resize Command Encoder"),
    });

  {
    let mut compute_pass =
      command_encoder.begin_compute_pass(&wgpu::ComputePassDescriptor {
        label: Some("Resize Compute Pass"),
        timestamp_writes: None,
      });
    compute_pass.set_bind_group(0, &bind_group, &[]);
    compute_pass.set_pipeline(&pipeline);
    compute_pass.dispatch_workgroups(
      (target_width as u32 + 7) / 8,
      (target_height as u32 + 7) / 8,
      1,
    );
  }

  // Read back the result
  let unpadded_bytes_per_row = target_width * BYTES_PER_PIXEL as usize;
  let align = wgpu::COPY_BYTES_PER_ROW_ALIGNMENT as usize;
  let padded_bytes_per_row = (unpadded_bytes_per_row + align - 1) / align * align;
  let buffer_size = padded_bytes_per_row * target_height;

  let output_buffer = device.create_buffer(&wgpu::BufferDescriptor {
    label: Some("Resize Output Buffer"),
    size: buffer_size as u64,
    usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
    mapped_at_creation: false,
  });

  command_encoder.copy_texture_to_buffer(
    wgpu::TexelCopyTextureInfo {
      texture: &output_texture,
      mip_level: 0,
      origin: wgpu::Origin3d::ZERO,
      aspect: wgpu::TextureAspect::All,
    },
    wgpu::TexelCopyBufferInfo {
      buffer: &output_buffer,
      layout: wgpu::TexelCopyBufferLayout {
        offset: 0,
        bytes_per_row: Some(padded_bytes_per_row as u32),
        rows_per_image: Some(target_height as u32),
      },
    },
    wgpu::Extent3d {
      width: target_width as u32,
      height: target_height as u32,
      depth_or_array_layers: 1,
    },
  );

  queue.submit(Some(command_encoder.finish()));

  // Map and read the buffer
  let buffer_slice = output_buffer.slice(..);
  let (sender, receiver) = flume::bounded(1);
  buffer_slice.map_async(wgpu::MapMode::Read, move |r| sender.send(r).unwrap());
  device.poll(wgpu::PollType::Wait).unwrap();
  receiver.recv_async().await??;

  // Copy data accounting for row padding
  let mut result_data =
    vec![0u8; target_width * target_height * BYTES_PER_PIXEL as usize];
  {
    let view = buffer_slice.get_mapped_range();
    for row in 0..target_height {
      let src_start = row * padded_bytes_per_row;
      let src_end = src_start + unpadded_bytes_per_row;
      let dst_start = row * unpadded_bytes_per_row;
      let dst_end = dst_start + unpadded_bytes_per_row;
      result_data[dst_start..dst_end].copy_from_slice(&view[src_start..src_end]);
    }
  }
  output_buffer.unmap();

  Ok((result_data, (target_width, target_height)))
}
