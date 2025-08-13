//! Command-line interface for the image processing pipeline
//!
//! This module provides a user-friendly CLI for creating and executing
//! image processing pipelines with various color grading and filter operations.

use crate::shade::{ImagePipeline, NodeParams, NodeType};

use clap::{Arg, ArgMatches, Command, value_parser};
use std::path::PathBuf;

/// Represents a pipeline operation with its order and parameters
#[derive(Debug, Clone)]
pub struct PipelineOperation {
  pub op_type: OperationType,
  pub index: usize,
}

/// Types of operations that can be performed in the pipeline
#[derive(Debug, Clone)]
pub enum OperationType {
  Brightness(f32),
  Contrast(f32),
  Saturation(f32),
  Hue(f32),
  Gamma(f32),
  WhiteBalance {
    auto_adjust: bool,
    temperature: Option<f32>,
    tint: Option<f32>,
  },
  Blur(f32),
  Sharpen(f32),
  Noise(f32),
  Scale(f32),
  Rotate(f32),
}

/// CLI configuration structure
pub struct CliConfig {
  pub example: Option<PathBuf>,
  pub input_path: Option<PathBuf>,
  pub output_path: Option<PathBuf>,
  pub pipeline_config: PipelineConfig,
  pub verbose: bool,
}

/// Pipeline configuration from CLI arguments
#[derive(Debug)]
pub struct PipelineConfig {
  pub operations: Vec<PipelineOperation>,
  // Keep these for backwards compatibility and validation
  pub brightness: Option<f32>,
  pub contrast: Option<f32>,
  pub saturation: Option<f32>,
  pub hue: Option<f32>,
  pub gamma: Option<f32>,
  pub auto_white_balance: bool,
  pub white_balance_temperature: Option<f32>,
  pub white_balance_tint: Option<f32>,
  pub blur_radius: Option<f32>,
  pub sharpen_amount: Option<f32>,
  pub noise_amount: Option<f32>,
  pub scale_factor: Option<f32>,
  pub rotate_angle: Option<f32>,
}

impl Default for PipelineConfig {
  fn default() -> Self {
    Self {
      operations: Vec::new(),
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
    }
  }
}

impl CliConfig {
  /// Parse command line arguments and create CLI configuration
  pub fn from_args() -> Result<Self, String> {
    let cli = build_cli();
    Self::from_matches(cli.get_matches())
  }

  /// Create CLI configuration from parsed matches
  fn from_matches(matches: ArgMatches) -> Result<Self, String> {
    let example = matches.get_one::<PathBuf>("example").cloned();
    let input_path = matches.get_one::<PathBuf>("input").cloned();
    let output_path = matches
      .get_one::<PathBuf>("output")
      .or(matches.get_one::<PathBuf>("input"))
      .cloned();

    let mut operations = Vec::new();

    // Collect operations with their indices
    if let Some(value) = matches.get_one::<f32>("brightness") {
      if let Some(indices) = matches.indices_of("brightness") {
        for index in indices {
          operations.push(PipelineOperation {
            op_type: OperationType::Brightness(*value),
            index,
          });
        }
      }
    }

    if let Some(value) = matches.get_one::<f32>("contrast") {
      if let Some(indices) = matches.indices_of("contrast") {
        for index in indices {
          operations.push(PipelineOperation {
            op_type: OperationType::Contrast(*value),
            index,
          });
        }
      }
    }

    if let Some(value) = matches.get_one::<f32>("saturation") {
      if let Some(indices) = matches.indices_of("saturation") {
        for index in indices {
          operations.push(PipelineOperation {
            op_type: OperationType::Saturation(*value),
            index,
          });
        }
      }
    }

    if let Some(value) = matches.get_one::<f32>("hue") {
      if let Some(indices) = matches.indices_of("hue") {
        for index in indices {
          operations.push(PipelineOperation {
            op_type: OperationType::Hue(*value),
            index,
          });
        }
      }
    }

    if let Some(value) = matches.get_one::<f32>("gamma") {
      if let Some(indices) = matches.indices_of("gamma") {
        for index in indices {
          operations.push(PipelineOperation {
            op_type: OperationType::Gamma(*value),
            index,
          });
        }
      }
    }

    // Handle white balance - check for any white balance related arguments
    let auto_wb = matches.get_flag("auto-white-balance");
    let wb_temp = matches.get_one::<f32>("wb-temperature").copied();
    let wb_tint = matches.get_one::<f32>("wb-tint").copied();

    if auto_wb || wb_temp.is_some() || wb_tint.is_some() {
      // Find the earliest index among white balance arguments
      let mut wb_index = usize::MAX;

      if auto_wb {
        if let Some(indices) = matches.indices_of("auto-white-balance") {
          wb_index = wb_index.min(indices.min().unwrap_or(usize::MAX));
        }
      }
      if wb_temp.is_some() {
        if let Some(indices) = matches.indices_of("wb-temperature") {
          wb_index = wb_index.min(indices.min().unwrap_or(usize::MAX));
        }
      }
      if wb_tint.is_some() {
        if let Some(indices) = matches.indices_of("wb-tint") {
          wb_index = wb_index.min(indices.min().unwrap_or(usize::MAX));
        }
      }

      if wb_index != usize::MAX {
        operations.push(PipelineOperation {
          op_type: OperationType::WhiteBalance {
            auto_adjust: auto_wb,
            temperature: wb_temp,
            tint: wb_tint,
          },
          index: wb_index,
        });
      }
    }

    if let Some(value) = matches.get_one::<f32>("blur") {
      if let Some(indices) = matches.indices_of("blur") {
        for index in indices {
          operations.push(PipelineOperation {
            op_type: OperationType::Blur(*value),
            index,
          });
        }
      }
    }

    if let Some(value) = matches.get_one::<f32>("sharpen") {
      if let Some(indices) = matches.indices_of("sharpen") {
        for index in indices {
          operations.push(PipelineOperation {
            op_type: OperationType::Sharpen(*value),
            index,
          });
        }
      }
    }

    if let Some(value) = matches.get_one::<f32>("noise") {
      if let Some(indices) = matches.indices_of("noise") {
        for index in indices {
          operations.push(PipelineOperation {
            op_type: OperationType::Noise(*value),
            index,
          });
        }
      }
    }

    if let Some(value) = matches.get_one::<f32>("scale") {
      if let Some(indices) = matches.indices_of("scale") {
        for index in indices {
          operations.push(PipelineOperation {
            op_type: OperationType::Scale(*value),
            index,
          });
        }
      }
    }

    if let Some(value) = matches.get_one::<f32>("rotate") {
      if let Some(indices) = matches.indices_of("rotate") {
        for index in indices {
          operations.push(PipelineOperation {
            op_type: OperationType::Rotate(*value),
            index,
          });
        }
      }
    }

    // Sort operations by their original index
    operations.sort_by_key(|op| op.index);

    let pipeline_config = PipelineConfig {
      operations,
      brightness: matches.get_one::<f32>("brightness").copied(),
      contrast: matches.get_one::<f32>("contrast").copied(),
      saturation: matches.get_one::<f32>("saturation").copied(),
      hue: matches.get_one::<f32>("hue").copied(),
      gamma: matches.get_one::<f32>("gamma").copied(),
      auto_white_balance: matches.get_flag("auto-white-balance"),
      white_balance_temperature: matches.get_one::<f32>("wb-temperature").copied(),
      white_balance_tint: matches.get_one::<f32>("wb-tint").copied(),
      blur_radius: matches.get_one::<f32>("blur").copied(),
      sharpen_amount: matches.get_one::<f32>("sharpen").copied(),
      noise_amount: matches.get_one::<f32>("noise").copied(),
      scale_factor: matches.get_one::<f32>("scale").copied(),
      rotate_angle: matches.get_one::<f32>("rotate").copied(),
    };

    let verbose = matches.get_flag("verbose");

    Ok(CliConfig {
      example,
      input_path,
      output_path,
      pipeline_config,
      verbose,
    })
  }

  /// Build an image processing pipeline from the CLI configuration
  pub fn build_pipeline(&self) -> ImagePipeline {
    let mut pipeline = ImagePipeline::new();

    // Add input node
    let input_id = pipeline.add_node("Input".to_string(), NodeType::ImageInput);
    let mut last_node_id = input_id;

    // Add processing nodes in the order they were specified on command line
    for operation in &self.pipeline_config.operations {
      match &operation.op_type {
        OperationType::Brightness(value) => {
          let node_id = pipeline.add_node("Brightness".to_string(), NodeType::Brightness);
          if let Some(node) = pipeline.get_node_mut(node_id) {
            node.set_params(NodeParams::Brightness { value: *value });
          }
          pipeline
            .connect_nodes(
              last_node_id,
              "image".to_string(),
              node_id,
              "image".to_string(),
            )
            .expect("Failed to connect brightness node");
          last_node_id = node_id;
        }

        OperationType::Contrast(value) => {
          let node_id = pipeline.add_node("Contrast".to_string(), NodeType::Contrast);
          if let Some(node) = pipeline.get_node_mut(node_id) {
            node.set_params(NodeParams::Contrast { value: *value });
          }
          pipeline
            .connect_nodes(
              last_node_id,
              "image".to_string(),
              node_id,
              "image".to_string(),
            )
            .expect("Failed to connect contrast node");
          last_node_id = node_id;
        }

        OperationType::Saturation(value) => {
          let node_id = pipeline.add_node("Saturation".to_string(), NodeType::Saturation);
          if let Some(node) = pipeline.get_node_mut(node_id) {
            node.set_params(NodeParams::Saturation { value: *value });
          }
          pipeline
            .connect_nodes(
              last_node_id,
              "image".to_string(),
              node_id,
              "image".to_string(),
            )
            .expect("Failed to connect saturation node");
          last_node_id = node_id;
        }

        OperationType::Hue(value) => {
          let node_id = pipeline.add_node("Hue".to_string(), NodeType::Hue);
          if let Some(node) = pipeline.get_node_mut(node_id) {
            node.set_params(NodeParams::Hue { value: *value });
          }
          pipeline
            .connect_nodes(
              last_node_id,
              "image".to_string(),
              node_id,
              "image".to_string(),
            )
            .expect("Failed to connect hue node");
          last_node_id = node_id;
        }

        OperationType::Gamma(value) => {
          let node_id = pipeline.add_node("Gamma".to_string(), NodeType::Gamma);
          if let Some(node) = pipeline.get_node_mut(node_id) {
            node.set_params(NodeParams::Gamma { value: *value });
          }
          pipeline
            .connect_nodes(
              last_node_id,
              "image".to_string(),
              node_id,
              "image".to_string(),
            )
            .expect("Failed to connect gamma node");
          last_node_id = node_id;
        }

        OperationType::WhiteBalance {
          auto_adjust,
          temperature,
          tint,
        } => {
          let node_id =
            pipeline.add_node("WhiteBalance".to_string(), NodeType::WhiteBalance);
          if let Some(node) = pipeline.get_node_mut(node_id) {
            let temp = temperature.unwrap_or(0.0);
            let tint_val = tint.unwrap_or(0.0);
            node.set_params(NodeParams::WhiteBalance {
              auto_adjust: *auto_adjust,
              temperature: temp,
              tint: tint_val,
            });
          }
          pipeline
            .connect_nodes(
              last_node_id,
              "image".to_string(),
              node_id,
              "image".to_string(),
            )
            .expect("Failed to connect white balance node");
          last_node_id = node_id;
        }

        OperationType::Blur(radius) => {
          let node_id = pipeline.add_node("Blur".to_string(), NodeType::Blur);
          if let Some(node) = pipeline.get_node_mut(node_id) {
            node.set_params(NodeParams::Blur { radius: *radius });
          }
          pipeline
            .connect_nodes(
              last_node_id,
              "image".to_string(),
              node_id,
              "image".to_string(),
            )
            .expect("Failed to connect blur node");
          last_node_id = node_id;
        }

        OperationType::Sharpen(amount) => {
          let node_id = pipeline.add_node("Sharpen".to_string(), NodeType::Sharpen);
          if let Some(node) = pipeline.get_node_mut(node_id) {
            node.set_params(NodeParams::Sharpen { amount: *amount });
          }
          pipeline
            .connect_nodes(
              last_node_id,
              "image".to_string(),
              node_id,
              "image".to_string(),
            )
            .expect("Failed to connect sharpen node");
          last_node_id = node_id;
        }

        OperationType::Noise(amount) => {
          let node_id = pipeline.add_node("Noise".to_string(), NodeType::Noise);
          if let Some(node) = pipeline.get_node_mut(node_id) {
            node.set_params(NodeParams::Noise {
              amount: *amount,
              seed: 42,
            });
          }
          pipeline
            .connect_nodes(
              last_node_id,
              "image".to_string(),
              node_id,
              "image".to_string(),
            )
            .expect("Failed to connect noise node");
          last_node_id = node_id;
        }

        OperationType::Scale(factor) => {
          let node_id = pipeline.add_node("Scale".to_string(), NodeType::Scale);
          if let Some(node) = pipeline.get_node_mut(node_id) {
            node.set_params(NodeParams::Scale { factor: *factor });
          }
          pipeline
            .connect_nodes(
              last_node_id,
              "image".to_string(),
              node_id,
              "image".to_string(),
            )
            .expect("Failed to connect scale node");
          last_node_id = node_id;
        }

        OperationType::Rotate(angle) => {
          let node_id = pipeline.add_node("Rotate".to_string(), NodeType::Rotate);
          if let Some(node) = pipeline.get_node_mut(node_id) {
            node.set_params(NodeParams::Rotate { angle: *angle });
          }
          pipeline
            .connect_nodes(
              last_node_id,
              "image".to_string(),
              node_id,
              "image".to_string(),
            )
            .expect("Failed to connect rotate node");
          last_node_id = node_id;
        }
      }
    }

    // Add output node
    let output_id = pipeline.add_node("Output".to_string(), NodeType::ImageOutput);
    pipeline
      .connect_nodes(
        last_node_id,
        "image".to_string(),
        output_id,
        "image".to_string(),
      )
      .expect("Failed to connect output node");

    pipeline
  }

  /// Print pipeline information
  pub fn print_pipeline_info(&self) {
    println!("Image Processing Pipeline Configuration:");
    if let Some(input) = &self.input_path {
      println!("Input:  {}", input.display());
    }
    if let Some(output) = &self.output_path {
      println!("Output: {}", output.display());
    }
    if let Some(example) = &self.example {
      println!("Example: {}", example.display());
    }
    println!();

    if self.pipeline_config.operations.is_empty() {
      println!("No operations specified - image will be passed through unchanged.");
    } else {
      println!("Operations to apply (in command-line order):");
      for (i, operation) in self.pipeline_config.operations.iter().enumerate() {
        let description = match &operation.op_type {
          OperationType::Brightness(value) => format!("Brightness: {:.2}", value),
          OperationType::Contrast(value) => format!("Contrast: {:.2}", value),
          OperationType::Saturation(value) => format!("Saturation: {:.2}", value),
          OperationType::Hue(value) => format!("Hue: {:.2}°", value),
          OperationType::Gamma(value) => format!("Gamma: {:.2}", value),
          OperationType::WhiteBalance {
            auto_adjust,
            temperature,
            tint,
          } => {
            let mut parts = Vec::new();
            if *auto_adjust {
              parts.push("Auto".to_string());
            }
            if let Some(temp) = temperature {
              parts.push(format!("Temperature: {:.2}", temp));
            }
            if let Some(tint_val) = tint {
              parts.push(format!("Tint: {:.2}", tint_val));
            }
            format!("White Balance ({})", parts.join(", "))
          }
          OperationType::Blur(radius) => format!("Blur: {:.2}px", radius),
          OperationType::Sharpen(amount) => format!("Sharpen: {:.2}", amount),
          OperationType::Noise(amount) => format!("Noise: {:.2}", amount),
          OperationType::Scale(factor) => format!("Scale: {:.2}x", factor),
          OperationType::Rotate(angle) => format!("Rotate: {:.2}°", angle),
        };
        println!("  {}. {}", i + 1, description);
      }
    }
    println!();
  }
}

/// Build the CLI command structure
fn build_cli() -> Command {
  Command::new("shade")
        .version("0.1.0")
        .about("GPU-accelerated image processing and color grading tool")
        .arg(
            Arg::new("example")
                .short('e')
                .long("example")
                .value_name("FILE")
                .help("Output image file")
                .required(false)
                .value_parser(value_parser!(PathBuf)),
        )
        .arg(
            Arg::new("input")
                .short('i')
                .long("input")
                .value_name("FILE")
                .help("Input image file")
                .required(false)
                .value_parser(value_parser!(PathBuf)),
        )
        .arg(
            Arg::new("output")
                .short('o')
                .long("output")
                .value_name("FILE")
                .help("Output image file")
                .required(false)
                .value_parser(value_parser!(PathBuf)),
        )
        .arg(
            Arg::new("brightness")
                .short('b')
                .long("brightness")
                .value_name("VALUE")
                .help("Adjust brightness (-1.0 to 1.0, 0.0 = no change)")
                .value_parser(value_parser!(f32)),
        )
        .arg(
            Arg::new("contrast")
                .short('c')
                .long("contrast")
                .value_name("VALUE")
                .help("Adjust contrast (0.0 to 2.0, 1.0 = no change)")
                .value_parser(value_parser!(f32)),
        )
        .arg(
            Arg::new("saturation")
                .short('s')
                .long("saturation")
                .value_name("VALUE")
                .help("Adjust saturation (0.0 to 2.0, 1.0 = no change)")
                .value_parser(value_parser!(f32)),
        )
        .arg(
            Arg::new("hue")
                .short('u')
                .long("hue")
                .value_name("DEGREES")
                .help("Adjust hue (-180.0 to 180.0 degrees, 0.0 = no change)")
                .value_parser(value_parser!(f32)),
        )
        .arg(
            Arg::new("gamma")
                .short('g')
                .long("gamma")
                .value_name("VALUE")
                .help("Adjust gamma (0.1 to 3.0, 1.0 = no change)")
                .value_parser(value_parser!(f32)),
        )
        .arg(
            Arg::new("blur")
                .long("blur")
                .value_name("RADIUS")
                .help("Apply blur filter (radius in pixels)")
                .value_parser(value_parser!(f32)),
        )
        .arg(
            Arg::new("sharpen")
                .long("sharpen")
                .value_name("AMOUNT")
                .help("Apply sharpen filter (0.0 to 2.0)")
                .value_parser(value_parser!(f32)),
        )
        .arg(
            Arg::new("noise")
                .long("noise")
                .value_name("AMOUNT")
                .help("Add noise (0.0 to 1.0)")
                .value_parser(value_parser!(f32)),
        )
        .arg(
            Arg::new("scale")
                .long("scale")
                .value_name("FACTOR")
                .help("Scale image (0.1 to 5.0)")
                .value_parser(value_parser!(f32)),
        )
        .arg(
            Arg::new("rotate")
                .long("rotate")
                .value_name("DEGREES")
                .help("Rotate image (degrees)")
                .value_parser(value_parser!(f32)),
        )
        .arg(
            Arg::new("auto-white-balance")
                .long("auto-white-balance")
                .help("Automatically adjust white balance")
                .action(clap::ArgAction::SetTrue),
        )
        .arg(
            Arg::new("wb-temperature")
                .long("wb-temperature")
                .value_name("VALUE")
                .help("Manual white balance temperature (-1.0 to 1.0, 0.0 = no change)")
                .value_parser(value_parser!(f32)),
        )
        .arg(
            Arg::new("wb-tint")
                .long("wb-tint")
                .value_name("VALUE")
                .help("Manual white balance tint (-1.0 to 1.0, 0.0 = no change)")
                .value_parser(value_parser!(f32)),
        )

        .arg(
            Arg::new("verbose")
                .short('v')
                .long("verbose")
                .help("Enable verbose output")
                .action(clap::ArgAction::SetTrue),
        )
        .after_help(
            "EXAMPLES:\n    \
            Basic image processing:\n      \
            shade -i input.jpg -o output.jpg --brightness 0.2 --contrast 1.1\n      \
            shade -i photo.png -o enhanced.png --saturation 1.3 --sharpen 0.8\n      \
            shade -i image.jpg -o blurred.jpg --blur 2.5\n      \
            shade -i portrait.jpg -o corrected.jpg --auto-white-balance\n      \
            shade -i sunset.jpg -o warmer.jpg --wb-temperature 0.3 --wb-tint -0.1\n    \
            \n    \
            Complex processing:\n      \
            shade -i original.png -o processed.png -b 0.1 -c 1.2 -s 1.1 --gamma 0.9\n    \
            \n    \
            OpenEXR HDR processing:\n      \
            shade -i input.exr -o output.exr --brightness 0.5  # Process HDR files\n      \
            shade -i hdr.exr -o display.png --gamma 2.2\n    \
            \n    \
            High quality processing:\n      \
            shade --example mandelbrot.raw  # 32-bit float data\n      \
            shade -i input.jpg -o output.png  # Automatic format detection",
        )
}

/// Print usage examples
pub fn print_examples() {
  println!("Usage Examples:");
  println!();
  println!("Basic color grading:");
  println!("  shade -i input.jpg -o output.jpg --brightness 0.2 --contrast 1.1");
  println!();
  println!("Enhance photo saturation and add sharpening:");
  println!("  shade -i photo.png -o enhanced.png --saturation 1.3 --sharpen 0.8");
  println!();
  println!("Apply blur effect:");
  println!("  shade -i image.jpg -o blurred.jpg --blur 2.5");
  println!();
  println!("White balance correction:");
  println!("  shade -i portrait.jpg -o corrected.jpg --auto-white-balance");
  println!();
  println!("Manual white balance adjustment:");
  println!("  shade -i sunset.jpg -o warmer.jpg --wb-temperature 0.3 --wb-tint -0.1");
  println!();
  println!("Complex processing chain:");
  println!("  shade -i original.png -o processed.png \\");
  println!("        --brightness 0.1 --contrast 1.2 --saturation 1.1 \\");
  println!("        --gamma 0.9 --sharpen 0.5");
  println!();
  println!("Geometric transformations:");
  println!("  shade -i input.jpg -o output.jpg --scale 1.5 --rotate 15");
  println!();
  println!("OpenEXR HDR processing:");
  println!("  shade -i input.exr -o output.exr --brightness 0.5  # Process HDR files");
  println!("  shade -i hdr.exr -o display.png --gamma 2.2");
  println!();
  println!("High quality processing:");
  println!("  shade --example mandelbrot.raw  # 32-bit float data");
  println!("  shade -i input.jpg -o output.png  # Automatic format detection");
  println!();
}

/// Validate CLI configuration
pub fn validate_config(config: &CliConfig) -> Result<(), String> {
  // Check input file exists if one is specified (skip for examples)
  if config.example.is_none() {
    if let Some(input_path) = &config.input_path {
      if !input_path.exists() {
        return Err(format!(
          "Input file does not exist: {}",
          input_path.display()
        ));
      }
    }

    // Check input file extension if input path exists
    if let Some(input_path) = &config.input_path {
      if let Some(ext) = input_path.extension() {
        let ext_str = ext.to_string_lossy().to_lowercase();
        if !["jpg", "jpeg", "png", "bmp", "tiff", "webp", "exr", "cr3"]
          .contains(&ext_str.as_str())
        {
          return Err(format!("Unsupported input format: {}", ext_str));
        }
      } else {
        return Err("Input file has no extension".to_string());
      }
    }
  }

  Ok(())
}

#[cfg(test)]
mod tests {
  use super::*;
  use std::ffi::OsString;

  #[test]
  fn test_cli_parsing() {
    let args = vec![
      OsString::from("shade"),
      OsString::from("-i"),
      OsString::from("input.jpg"),
      OsString::from("-o"),
      OsString::from("output.jpg"),
      OsString::from("--brightness"),
      OsString::from("0.2"),
      OsString::from("--contrast"),
      OsString::from("1.1"),
    ];

    let matches = build_cli().try_get_matches_from(args).unwrap();
    let config = CliConfig::from_matches(matches).unwrap();

    assert_eq!(
      config.input_path.clone().unwrap(),
      PathBuf::from("input.jpg")
    );
    assert_eq!(
      config.output_path.clone().unwrap(),
      PathBuf::from("output.jpg")
    );
    assert_eq!(config.pipeline_config.brightness, Some(0.2));
    assert_eq!(config.pipeline_config.contrast, Some(1.1));
    // Check that operations are in the correct order
    assert_eq!(config.pipeline_config.operations.len(), 2);
    if let OperationType::Brightness(val) = config.pipeline_config.operations[0].op_type {
      assert_eq!(val, 0.2);
    } else {
      panic!("Expected brightness operation first");
    }
    if let OperationType::Contrast(val) = config.pipeline_config.operations[1].op_type {
      assert_eq!(val, 1.1);
    } else {
      panic!("Expected contrast operation second");
    }
  }

  #[test]
  fn test_pipeline_building() {
    let config = CliConfig {
      example: None,
      input_path: Some(PathBuf::from("input.jpg")),
      output_path: Some(PathBuf::from("output.jpg")),
      pipeline_config: PipelineConfig {
        operations: vec![
          PipelineOperation {
            op_type: OperationType::Brightness(0.2),
            index: 0,
          },
          PipelineOperation {
            op_type: OperationType::Contrast(1.1),
            index: 1,
          },
          PipelineOperation {
            op_type: OperationType::Saturation(1.3),
            index: 2,
          },
        ],
        brightness: Some(0.2),
        contrast: Some(1.1),
        saturation: Some(1.3),
        ..Default::default()
      },
      verbose: false,
    };

    let pipeline = config.build_pipeline();
    assert_eq!(pipeline.nodes.len(), 5); // input + 3 operations + output
  }

  #[test]
  fn test_white_balance_cli_parsing() {
    // Test auto white balance
    let args = vec![
      OsString::from("shade"),
      OsString::from("--input"),
      OsString::from("input.jpg"),
      OsString::from("--output"),
      OsString::from("output.jpg"),
      OsString::from("--auto-white-balance"),
    ];

    let matches = build_cli().try_get_matches_from(args).unwrap();
    let config = CliConfig::from_matches(matches).unwrap();

    assert_eq!(config.pipeline_config.auto_white_balance, true);
    assert_eq!(config.pipeline_config.white_balance_temperature, None);
    assert_eq!(config.pipeline_config.white_balance_tint, None);
    // Check that white balance operation was added
    assert_eq!(config.pipeline_config.operations.len(), 1);
    if let OperationType::WhiteBalance {
      auto_adjust,
      temperature,
      tint,
    } = &config.pipeline_config.operations[0].op_type
    {
      assert_eq!(*auto_adjust, true);
      assert_eq!(*temperature, None);
      assert_eq!(*tint, None);
    } else {
      panic!("Expected white balance operation");
    }

    // Test manual white balance
    let args = vec![
      OsString::from("shade"),
      OsString::from("--input"),
      OsString::from("input.jpg"),
      OsString::from("--output"),
      OsString::from("output.jpg"),
      OsString::from("--wb-temperature=0.3"),
      OsString::from("--wb-tint=-0.1"),
    ];

    let matches = build_cli().try_get_matches_from(args).unwrap();
    let config = CliConfig::from_matches(matches).unwrap();

    assert_eq!(config.pipeline_config.auto_white_balance, false);
    assert_eq!(config.pipeline_config.white_balance_temperature, Some(0.3));
    assert_eq!(config.pipeline_config.white_balance_tint, Some(-0.1));
    // Check that white balance operation was added
    assert_eq!(config.pipeline_config.operations.len(), 1);
    if let OperationType::WhiteBalance {
      auto_adjust,
      temperature,
      tint,
    } = &config.pipeline_config.operations[0].op_type
    {
      assert_eq!(*auto_adjust, false);
      assert_eq!(*temperature, Some(0.3));
      assert_eq!(*tint, Some(-0.1));
    } else {
      panic!("Expected white balance operation");
    }
  }

  #[test]
  fn test_white_balance_pipeline_building() {
    // Test auto white balance pipeline
    let config = CliConfig {
      example: None,
      input_path: Some(PathBuf::from("input.jpg")),
      output_path: Some(PathBuf::from("output.jpg")),
      pipeline_config: PipelineConfig {
        operations: vec![PipelineOperation {
          op_type: OperationType::WhiteBalance {
            auto_adjust: true,
            temperature: None,
            tint: None,
          },
          index: 0,
        }],
        auto_white_balance: true,
        ..Default::default()
      },
      verbose: false,
    };

    let pipeline = config.build_pipeline();
    assert_eq!(pipeline.nodes.len(), 3); // input + white balance + output

    // Test manual white balance pipeline
    let config = CliConfig {
      example: None,
      input_path: Some(PathBuf::from("input.jpg")),
      output_path: Some(PathBuf::from("output.jpg")),
      pipeline_config: PipelineConfig {
        operations: vec![PipelineOperation {
          op_type: OperationType::WhiteBalance {
            auto_adjust: false,
            temperature: Some(0.2),
            tint: Some(-0.1),
          },
          index: 0,
        }],
        white_balance_temperature: Some(0.2),
        white_balance_tint: Some(-0.1),
        ..Default::default()
      },
      verbose: false,
    };

    let pipeline = config.build_pipeline();
    assert_eq!(pipeline.nodes.len(), 3); // input + white balance + output
  }

  #[test]
  fn test_argument_order_respected() {
    // Test that operations are applied in command-line order
    let args = vec![
      OsString::from("shade"),
      OsString::from("--input"),
      OsString::from("input.jpg"),
      OsString::from("--output"),
      OsString::from("output.jpg"),
      OsString::from("--contrast"),
      OsString::from("1.1"),
      OsString::from("--brightness"),
      OsString::from("0.2"),
      OsString::from("--saturation"),
      OsString::from("1.3"),
    ];

    let matches = build_cli().try_get_matches_from(args).unwrap();
    let config = CliConfig::from_matches(matches).unwrap();

    // Verify operations are in command-line order (contrast, brightness, saturation)
    assert_eq!(config.pipeline_config.operations.len(), 3);

    if let OperationType::Contrast(val) = config.pipeline_config.operations[0].op_type {
      assert_eq!(val, 1.1);
    } else {
      panic!(
        "Expected contrast operation first (index 0), got: {:?}",
        config.pipeline_config.operations[0].op_type
      );
    }

    if let OperationType::Brightness(val) = config.pipeline_config.operations[1].op_type {
      assert_eq!(val, 0.2);
    } else {
      panic!(
        "Expected brightness operation second (index 1), got: {:?}",
        config.pipeline_config.operations[1].op_type
      );
    }

    if let OperationType::Saturation(val) = config.pipeline_config.operations[2].op_type {
      assert_eq!(val, 1.3);
    } else {
      panic!(
        "Expected saturation operation third (index 2), got: {:?}",
        config.pipeline_config.operations[2].op_type
      );
    }

    // Verify indices are in ascending order
    assert!(
      config.pipeline_config.operations[0].index
        < config.pipeline_config.operations[1].index
    );
    assert!(
      config.pipeline_config.operations[1].index
        < config.pipeline_config.operations[2].index
    );
  }

  #[test]
  fn test_white_balance_validation() {
    // Test valid values with example (skips file validation)
    let config = CliConfig {
      example: Some(PathBuf::from("test.png")),
      input_path: None,
      output_path: None,
      pipeline_config: PipelineConfig {
        white_balance_temperature: Some(0.5),
        white_balance_tint: Some(-0.5),
        ..Default::default()
      },
      verbose: false,
    };

    assert!(validate_config(&config).is_ok());

    // Test invalid temperature with example
    let config = CliConfig {
      example: Some(PathBuf::from("test.png")),
      input_path: None,
      output_path: None,
      pipeline_config: PipelineConfig {
        white_balance_temperature: Some(2.0),
        ..Default::default()
      },
      verbose: false,
    };

    assert!(validate_config(&config).is_err());

    // Test invalid tint with example
    let config = CliConfig {
      example: Some(PathBuf::from("test.png")),
      input_path: None,
      output_path: None,
      pipeline_config: PipelineConfig {
        white_balance_tint: Some(-2.0),
        ..Default::default()
      },
      verbose: false,
    };

    assert!(validate_config(&config).is_err());
  }
}
