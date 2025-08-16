mod cli;
mod protocol;
mod server;
mod shade;
mod utils;
mod config;
mod file_loaders;

#[cfg(target_arch = "wasm32")]
use crate::utils::output_image_wasm;
#[cfg(not(target_arch = "wasm32"))]
use utils::output_image_native;
use cli::CliConfig;
use server::ImageProcessingServer;
use crate::config::config_from_ini;
use crate::file_loaders::load_image;

const TEXTURE_DIMS: (usize, usize) = (512, 512);

struct LoadedImage {
  texture_data: Vec<u8>,
  actual_dims: (usize, usize),
}

#[derive(Default)]
struct Performance {
  image_load_ms: f64,
  image_decode_ms: f64,
  gpu_setup_ms: f64,
  processing_ms: f64,
  output_ms: f64,
  total_ms: f64,
}

impl Performance {
  fn print_all(&self) {
    log::debug!("[Perf] image_load_ms: {:.2}", self.image_load_ms);
    log::debug!("[Perf] image_decode_ms: {:.2}", self.image_decode_ms);
    log::debug!("[Perf] gpu_setup_ms: {:.2}", self.gpu_setup_ms);
    log::debug!("[Perf] processing_ms: {:.2}", self.processing_ms);
    log::debug!("[Perf] output_ms: {:.2}", self.output_ms);
    log::debug!("[Perf] total_ms: {:.2}", self.total_ms);
  }
}

pub fn main() {
  let run_start = std::time::Instant::now();


  #[cfg(not(target_arch = "wasm32"))]
  {
    env_logger::builder().format_timestamp_millis().init();

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

    // Check for --list-formats before full CLI parsing
    if args.iter().any(|arg| arg == "--list-formats") {
      cli::print_supported_formats();
      return;
    }

    let ini_conf = config_from_ini();

    if ini_conf.is_ok() {
      let config = ini_conf.unwrap();
      log::info!("Ini {:?}", config);

      log::info!("Main time with config: {:?}", run_start.elapsed());

      pollster::block_on(run(&config));
    } else {
      match CliConfig::from_args() {
        Ok(config) => {
          if let Err(e) = cli::validate_config(&config) {
            eprintln!("Error: {}", e);
            std::process::exit(1);
          }

          if config.verbose {
            config.print_pipeline_info();
          }

          log::info!("Main time: {:?}", run_start.elapsed());

          pollster::block_on(run(&config));
        }
        Err(e) => {
          eprintln!("Error parsing arguments: {}", e);
          cli::print_examples();
          std::process::exit(1);
        }
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

async fn run(config: &CliConfig) {
  let run_start = std::time::Instant::now();
  let mut timing = Performance::default();

  // load image
  log::info!("Loading image: {:?}", config.input_path);

  // Load input image if provided
  let (texture_data, actual_dims) = if let Some(input_path) = &config.input_path {
    #[cfg(not(target_arch = "wasm32"))]
    {
      let input_path_str = input_path.to_string_lossy();

      let load_time = run_start.elapsed();
      timing.image_load_ms = load_time.as_secs_f64() * 1000.0;

      match load_image(&input_path_str) {
        Ok((image_data, (width, height))) => {
          log::info!("Successfully loaded image: {}x{}", width, height);
          (image_data, (width, height))
        }
        Err(e) => {
          log::error!("Failed to load image: {}", e);
          // Fallback to default texture
          let default_data = (0..(TEXTURE_DIMS.0 * TEXTURE_DIMS.1))
            .flat_map(|_| [0u8, 0u8, 0u8, 255u8])
            .collect::<Vec<u8>>();
          let float_data = crate::utils::convert_to_float(&default_data);
          (float_data, TEXTURE_DIMS)
        }
      }
    }
    #[cfg(target_arch = "wasm32")]
    {
      // For WASM, we'll use default texture for now
      let default_data = (0..(TEXTURE_DIMS.0 * TEXTURE_DIMS.1))
        .flat_map(|_| [0u8, 0u8, 0u8, 255u8])
        .collect::<Vec<u8>>();
      let float_data = crate::utils::convert_to_float(&default_data);
      (float_data, TEXTURE_DIMS)
    }
  } else {
    // No input image provided, use default texture
    let default_data = (0..(TEXTURE_DIMS.0 * TEXTURE_DIMS.1))
      .flat_map(|_| [0u8, 0u8, 0u8, 255u8])
      .collect::<Vec<u8>>();
    let float_data = crate::utils::convert_to_float(&default_data);
    (float_data, TEXTURE_DIMS)
  };

  let loaded_image = LoadedImage {
    actual_dims: actual_dims,
    texture_data: texture_data,
  };

  // decode image

  let decode_time = run_start.elapsed();
  timing.image_decode_ms = decode_time.as_secs_f64() * 1000.0;

  let gpu_setup_start = std::time::Instant::now();

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

  let gpu_setup_time = gpu_setup_start.elapsed();
  timing.gpu_setup_ms = gpu_setup_time.as_secs_f64() * 1000.0;
  let processing_start = std::time::Instant::now();

  // Process the image through the pipeline using actual dimensions
  // The pipeline now handles resizing as part of the processing chain
  match image_pipeline
    .process(
      texture_data.clone(),
      (actual_dims.0 as u32, actual_dims.1 as u32),
    )
    .await
  {
    Ok((processed_data, final_dimensions)) => {
      texture_data = processed_data;
      actual_dims = (final_dimensions.0 as usize, final_dimensions.1 as usize);
      log::info!(
        "Image processed through pipeline with final dimensions: {}x{}",
        actual_dims.0,
        actual_dims.1
      );
    }
    Err(e) => {
      log::error!("Pipeline processing failed: {}", e);
    }
  }

  let processing_time = processing_start.elapsed();
  timing.processing_ms = processing_time.as_secs_f64() * 1000.0;
  let output_start = std::time::Instant::now();

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

  let output_time = output_start.elapsed();
  let total_time = run_start.elapsed();

  timing.output_ms = output_time.as_secs_f64() * 1000.0;
  timing.total_ms = total_time.as_secs_f64() * 1000.0;

  timing.print_all();

  log::info!("Done.");
}
