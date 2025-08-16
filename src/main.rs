mod cli;
mod protocol;
mod server;
mod shade;
mod utils;

use std::path::PathBuf;

#[cfg(target_arch = "wasm32")]
use crate::utils::output_image_wasm;
use rawler;
#[cfg(not(target_arch = "wasm32"))]
use utils::{is_openexr_file, load_openexr_image, output_image_native};

use cli::CliConfig;
use server::ImageProcessingServer;

use ini::Ini;

use crate::{cli::{PipelineConfig, PipelineOperation}, utils::convert_to_float};

const TEXTURE_DIMS: (usize, usize) = (512, 512);

struct LoadedImage {
  texture_data: Vec<u8>,
  actual_dims: (usize, usize),
}

pub fn main() {
  let perf = std::time::Instant::now();

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

    let ini_conf = config_from_ini();

    if ini_conf.is_ok() {
      let config = ini_conf.unwrap();
      log::info!("Ini {:?}", config);
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
  }
  #[cfg(target_arch = "wasm32")]
  {
    std::panic::set_hook(Box::new(console_error_panic_hook::hook));
    console_log::init_with_level(log::Level::Info).expect("could not initialize logger");
    wasm_bindgen_futures::spawn_local(run(None));
  }
}

async fn load_image(config: &CliConfig) -> LoadedImage {
  let perf = std::time::Instant::now();
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
        log::debug!(
          "[Load] Time spent reaching raw decode: {:?}",
          perf.elapsed()
        );
        let perf = std::time::Instant::now();

        // Use rawler for camera raw files
        match rawler::decode_file(&input_path_str.as_ref()) {
          Ok(rawimage) => {
            use rawler::imgop::develop::RawDevelop;

            let pixels = rawimage.pixels_u16();

            log::info!("Pixels {:?} CPP {:?}", pixels.len(), rawimage.cpp);

            let (width, height) = (rawimage.width as usize, rawimage.height as usize);
            log::info!("Loaded raw input image: {}x{}", width, height);

            log::debug!("[Load] Time spent reaching develop: {:?}", perf.elapsed());

            let dev = RawDevelop::default();
            let image = dev.develop_intermediate(&rawimage);

            log::debug!("[Load] Time spent to develop: {:?}", perf.elapsed());

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

  log::debug!("Time spent on processing: {:?}", perf.elapsed());
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

pub fn config_from_ini() -> anyhow::Result<CliConfig> {
  let conf = Ini::load_from_file("params.ini")?;

  let section = conf.section(Some("params")).unwrap();

  // Create pipeline config from ini values
  let mut pipeline_config = PipelineConfig::default();

  // Parse pipeline-related parameters from ini
  if let Some(brightness) = section.get("brightness") {
    if let Ok(exp_val) = brightness.parse::<f32>() {
      pipeline_config.operations.push(PipelineOperation {
        index: 0,
        op_type: cli::OperationType::Brightness(exp_val)
      });

    }
  }

  Ok(CliConfig {
    input_path: section.get("input_path").and_then(|f| Some(PathBuf::from(f.to_string()))),
    output_path: section.get("output_path").and_then(|f| Some(PathBuf::from(f.to_string()))),
    pipeline_config,
    verbose: section.get("verbose").map(|v| v == "true").unwrap_or(false),
    resize_width: section.get("resize_width").and_then(|w| w.parse().ok()),
    resize_height: section.get("resize_height").and_then(|h| h.parse().ok()),
  })
}
