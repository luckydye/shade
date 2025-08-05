//! This example demonstrates the basic usage of storage textures for the purpose of
//! creating a digital image of the Mandelbrot set
//! (<https://en.wikipedia.org/wiki/Mandelbrot_set>).
//!
//! Storage textures work like normal textures but they operate similar to storage buffers
//! in that they can be written to. The issue is that as it stands, write-only is the
//! only valid access mode for storage textures in WGSL and although there is a WGPU feature
//! to allow for read-write access, this is unfortunately a native-only feature and thus
//! we won't be using it here. If we needed a reference texture, we would need to add a
//! second texture to act as a reference and attach that as well. Luckily, we don't need
//! to read anything in our shader except the dimensions of our texture, which we can
//! easily get via `textureDimensions`.
//!
//! A lot of things aren't explained here via comments. See hello-compute and
//! repeated-compute for code that is more thoroughly commented.

mod cli;
mod shade;
mod utils;

#[cfg(target_arch = "wasm32")]
use crate::utils::output_image_wasm;
#[cfg(not(target_arch = "wasm32"))]
use utils::output_image_native;

use cli::CliConfig;
use shade::PipelineBuilder;

const TEXTURE_DIMS: (usize, usize) = (512, 512);

async fn example_image(path: Option<String>) {
  let mut texture_data = vec![0u8; TEXTURE_DIMS.0 * TEXTURE_DIMS.1 * 4];

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

  let shader = device.create_shader_module(wgpu::include_wgsl!("shader.wgsl"));

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
      format: wgpu::TextureFormat::Rgba8Unorm,
      usage: wgpu::TextureUsages::STORAGE_BINDING | wgpu::TextureUsages::COPY_SRC,
      view_formats: &[],
  });
  let storage_texture_view = storage_texture.create_view(&wgpu::TextureViewDescriptor::default());
  let output_staging_buffer = device.create_buffer(&wgpu::BufferDescriptor {
      label: None,
      size: size_of_val(&texture_data[..]) as u64,
      usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
      mapped_at_creation: false,
  });

  let bind_group_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
      label: None,
      entries: &[wgpu::BindGroupLayoutEntry {
          binding: 0,
          visibility: wgpu::ShaderStages::COMPUTE,
          ty: wgpu::BindingType::StorageTexture {
              access: wgpu::StorageTextureAccess::WriteOnly,
              format: wgpu::TextureFormat::Rgba8Unorm,
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
      let mut compute_pass = command_encoder.begin_compute_pass(&wgpu::ComputePassDescriptor {
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
              // This needs to be padded to 256.
              bytes_per_row: Some((TEXTURE_DIMS.0 * 4) as u32),
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
      texture_data.copy_from_slice(&view[..]);
  }
  log::info!("GPU data copied to local.");
  output_staging_buffer.unmap();

  #[cfg(not(target_arch = "wasm32"))]
  output_image_native(texture_data.to_vec(), TEXTURE_DIMS, path.unwrap());
  #[cfg(target_arch = "wasm32")]
  output_image_wasm(texture_data.to_vec(), TEXTURE_DIMS);
  log::info!("Done.")
}

async fn run(config: &CliConfig) {
    // Load input image if provided
    let (mut texture_data, actual_dims) = if let Some(input_path) = &config.input_path {
        #[cfg(not(target_arch = "wasm32"))]
        {
            use image::io::Reader as ImageReader;

            match ImageReader::open(input_path) {
                Ok(img_reader) => {
                    match img_reader.decode() {
                        Ok(img) => {
                            let rgba_img = img.to_rgba8();
                            let (width, height) = rgba_img.dimensions();
                            let data = rgba_img.into_raw();
                            log::info!("Loaded input image: {}x{}", width, height);
                            (data, (width as usize, height as usize))
                        }
                        Err(e) => {
                            log::error!("Failed to decode image: {}", e);
                            (vec![0u8; TEXTURE_DIMS.0 * TEXTURE_DIMS.1 * 4], TEXTURE_DIMS)
                        }
                    }
                }
                Err(e) => {
                    log::error!("Failed to open image file: {}", e);
                    (vec![0u8; TEXTURE_DIMS.0 * TEXTURE_DIMS.1 * 4], TEXTURE_DIMS)
                }
            }
        }
        #[cfg(target_arch = "wasm32")]
        {
            // For WASM, we'll use default texture for now
            (vec![0u8; TEXTURE_DIMS.0 * TEXTURE_DIMS.1 * 4], TEXTURE_DIMS)
        }
    } else {
        // No input image provided, use default texture
        (vec![0u8; TEXTURE_DIMS.0 * TEXTURE_DIMS.1 * 4], TEXTURE_DIMS)
    };

    // Create example image processing pipeline with more visible effects
    let mut image_pipeline = PipelineBuilder::new().basic_color_grading().build();

    // Test with more dramatic effects to verify processing is working
    if let Some(brightness_node) = image_pipeline
        .nodes
        .values_mut()
        .find(|n| matches!(n.node_type, shade::NodeType::Brightness))
    {
        brightness_node.params = shade::NodeParams::Brightness { value: 0.3 }; // Increase brightness significantly
    }
    if let Some(contrast_node) = image_pipeline
        .nodes
        .values_mut()
        .find(|n| matches!(n.node_type, shade::NodeType::Contrast))
    {
        contrast_node.params = shade::NodeParams::Contrast { value: 2.0 }; // Double the contrast
    }
    if let Some(saturation_node) = image_pipeline
        .nodes
        .values_mut()
        .find(|n| matches!(n.node_type, shade::NodeType::Saturation))
    {
        saturation_node.params = shade::NodeParams::Saturation { value: 1.5 }; // Boost saturation
    }

    // Initialize the pipeline with GPU resources (moved device and queue so we need to recreate them)
    let instance2 = wgpu::Instance::default();
    let adapter2 = instance2
        .request_adapter(&wgpu::RequestAdapterOptions::default())
        .await
        .unwrap();
    let (device2, queue2) = adapter2
        .request_device(&wgpu::DeviceDescriptor {
            label: None,
            required_features: wgpu::Features::empty(),
            required_limits: wgpu::Limits::downlevel_defaults(),
            memory_hints: wgpu::MemoryHints::MemoryUsage,
            trace: wgpu::Trace::Off,
        })
        .await
        .unwrap();

    image_pipeline.init_gpu(device2, queue2);

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
        output_image_native(texture_data.to_vec(), actual_dims, output_path.to_string_lossy().to_string());
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
                } else {
                    if let Err(e) = cli::validate_config(&config) {
                        eprintln!("Error: {}", e);
                        std::process::exit(1);
                    }

                    if config.verbose {
                        config.print_pipeline_info();
                    }

                    pollster::block_on(run(&config));
                }
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
