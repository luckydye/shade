mod cli;
mod shade;
mod utils;

#[cfg(target_arch = "wasm32")]
use crate::utils::output_image_wasm;
#[cfg(not(target_arch = "wasm32"))]
use utils::{is_openexr_file, load_openexr_image, output_image_native};

use cli::CliConfig;
use shade::{BYTES_PER_PIXEL, TEXTURE_FORMAT};

const TEXTURE_DIMS: (usize, usize) = (512, 512);

struct LoadedImage {
  texture_data: Vec<u8>,
  actual_dims: (usize, usize),
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
  // Load input image if provided
  let (texture_data, actual_dims) = if let Some(input_path) = &config.input_path {
    #[cfg(not(target_arch = "wasm32"))]
    {
      let input_path_str = input_path.to_string_lossy();

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
  let loaded_image = load_image(config).await;
  let mut image_pipeline = config.build_pipeline();

  let mut texture_data = loaded_image.texture_data;
  let actual_dims = loaded_image.actual_dims;

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
      required_limits: wgpu::Limits::downlevel_defaults(),
      memory_hints: wgpu::MemoryHints::MemoryUsage,
      trace: wgpu::Trace::Off,
    })
    .await
    .unwrap();

  image_pipeline.init_gpu(device, queue);

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

  // Output using actual dimensions
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
  log::info!("Done.")
}

pub fn main() {
  #[cfg(not(target_arch = "wasm32"))]
  {
    env_logger::builder()
      .filter_level(log::LevelFilter::Info)
      .format_timestamp_nanos()
      .init();

    match CliConfig::from_args() {
      Ok(config) => {
        if config.example.is_some() {
          // Generate an example image
          let p = config.example.clone().unwrap();
          let path = Some(p.as_os_str().to_string_lossy().to_string());
          pollster::block_on(example_image(path));
        }

        if let Err(e) = cli::validate_config(&config) {
          eprintln!("Error: {}", e);
          std::process::exit(1);
        }

        if config.verbose {
          config.print_pipeline_info();
        }

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

async fn example_image(path: Option<String>) {
  // Use 32-bit float precision for the example
  let mut texture_data =
    vec![0u8; TEXTURE_DIMS.0 * TEXTURE_DIMS.1 * BYTES_PER_PIXEL as usize];

  let instance = wgpu::Instance::default();
  let adapter = instance
    .request_adapter(&wgpu::RequestAdapterOptions::default())
    .await
    .unwrap();
  let (device, queue) = adapter
    .request_device(&wgpu::DeviceDescriptor {
      label: None,
      required_features: wgpu::Features::empty(),
      required_limits: wgpu::Limits::downlevel_defaults(),
      memory_hints: wgpu::MemoryHints::MemoryUsage,
      trace: wgpu::Trace::Off,
    })
    .await
    .unwrap();

  let shader = device.create_shader_module(wgpu::include_wgsl!("shaders/example.wgsl"));

  let storage_texture = device.create_texture(&wgpu::TextureDescriptor {
    label: None,
    size: wgpu::Extent3d {
      width: TEXTURE_DIMS.0 as u32,
      height: TEXTURE_DIMS.1 as u32,
      depth_or_array_layers: 1,
    },
    mip_level_count: 1,
    sample_count: 1,
    dimension: wgpu::TextureDimension::D2,
    format: TEXTURE_FORMAT,
    usage: wgpu::TextureUsages::STORAGE_BINDING | wgpu::TextureUsages::COPY_SRC,
    view_formats: &[],
  });
  let storage_texture_view =
    storage_texture.create_view(&wgpu::TextureViewDescriptor::default());
  // Calculate padded buffer size for proper alignment
  let unpadded_bytes_per_row = TEXTURE_DIMS.0 * BYTES_PER_PIXEL as usize;
  let align = wgpu::MAP_ALIGNMENT as usize;
  let padded_bytes_per_row = (unpadded_bytes_per_row + align - 1) / align * align;
  let buffer_size = padded_bytes_per_row * TEXTURE_DIMS.1;

  let output_staging_buffer = device.create_buffer(&wgpu::BufferDescriptor {
    label: None,
    size: buffer_size as u64,
    usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
    mapped_at_creation: false,
  });

  let bind_group_layout =
    device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
      label: None,
      entries: &[wgpu::BindGroupLayoutEntry {
        binding: 0,
        visibility: wgpu::ShaderStages::COMPUTE,
        ty: wgpu::BindingType::StorageTexture {
          access: wgpu::StorageTextureAccess::WriteOnly,
          format: TEXTURE_FORMAT,
          view_dimension: wgpu::TextureViewDimension::D2,
        },
        count: None,
      }],
    });
  let bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
    label: None,
    layout: &bind_group_layout,
    entries: &[wgpu::BindGroupEntry {
      binding: 0,
      resource: wgpu::BindingResource::TextureView(&storage_texture_view),
    }],
  });

  let pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
    label: None,
    bind_group_layouts: &[&bind_group_layout],
    push_constant_ranges: &[],
  });
  let pipeline = device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
    label: None,
    layout: Some(&pipeline_layout),
    module: &shader,
    entry_point: Some("main"),
    compilation_options: Default::default(),
    cache: None,
  });

  log::info!("Wgpu context set up.");
  //----------------------------------------

  let mut command_encoder =
    device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: None });
  {
    let mut compute_pass =
      command_encoder.begin_compute_pass(&wgpu::ComputePassDescriptor {
        label: None,
        timestamp_writes: None,
      });
    compute_pass.set_bind_group(0, &bind_group, &[]);
    compute_pass.set_pipeline(&pipeline);
    compute_pass.dispatch_workgroups(TEXTURE_DIMS.0 as u32, TEXTURE_DIMS.1 as u32, 1);
  }
  command_encoder.copy_texture_to_buffer(
    wgpu::TexelCopyTextureInfo {
      texture: &storage_texture,
      mip_level: 0,
      origin: wgpu::Origin3d::ZERO,
      aspect: wgpu::TextureAspect::All,
    },
    wgpu::TexelCopyBufferInfo {
      buffer: &output_staging_buffer,
      layout: wgpu::TexelCopyBufferLayout {
        offset: 0,
        // This needs to be padded to 256. Using bytes per pixel based on precision
        bytes_per_row: Some(padded_bytes_per_row as u32),
        rows_per_image: Some(TEXTURE_DIMS.1 as u32),
      },
    },
    wgpu::Extent3d {
      width: TEXTURE_DIMS.0 as u32,
      height: TEXTURE_DIMS.1 as u32,
      depth_or_array_layers: 1,
    },
  );
  queue.submit(Some(command_encoder.finish()));

  let buffer_slice = output_staging_buffer.slice(..);
  let (sender, receiver) = flume::bounded(1);
  buffer_slice.map_async(wgpu::MapMode::Read, move |r| sender.send(r).unwrap());
  device.poll(wgpu::PollType::wait()).unwrap();
  receiver.recv_async().await.unwrap().unwrap();
  log::info!("Output buffer mapped");
  {
    let view = buffer_slice.get_mapped_range();
    // Copy data accounting for row padding
    let unpadded_bytes_per_row = TEXTURE_DIMS.0 * BYTES_PER_PIXEL as usize;
    let align = wgpu::MAP_ALIGNMENT as usize;
    let padded_bytes_per_row = (unpadded_bytes_per_row + align - 1) / align * align;

    for row in 0..TEXTURE_DIMS.1 {
      let src_start = row * padded_bytes_per_row;
      let src_end = src_start + unpadded_bytes_per_row;
      let dst_start = row * unpadded_bytes_per_row;
      let dst_end = dst_start + unpadded_bytes_per_row;

      texture_data[dst_start..dst_end].copy_from_slice(&view[src_start..src_end]);
    }
  }
  log::info!("GPU data copied to local.");
  output_staging_buffer.unmap();

  #[cfg(not(target_arch = "wasm32"))]
  {
    let output_path = path.unwrap();

    // Use standard image output for other formats
    output_image_native(texture_data.to_vec(), TEXTURE_DIMS, output_path);
  }
  #[cfg(target_arch = "wasm32")]
  output_image_wasm(texture_data.to_vec(), TEXTURE_DIMS);
  log::info!("Done.")
}
