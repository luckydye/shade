//! Command-line interface for the image processing pipeline
//!
//! This module provides a user-friendly CLI for creating and executing
//! image processing pipelines with various color grading and filter operations.

use crate::shade::{ImagePipeline, NodeParams, NodeType};
use crate::utils::OutputPrecision;
use clap::{Arg, ArgMatches, Command, value_parser};
use std::path::PathBuf;

/// CLI configuration structure
pub struct CliConfig {
    pub example: Option<PathBuf>,
    pub input_path: Option<PathBuf>,
    pub output_path: Option<PathBuf>,
    pub output_precision: OutputPrecision,
    pub pipeline_config: PipelineConfig,
    pub verbose: bool,
}

/// Pipeline configuration from CLI arguments
#[derive(Debug, Default)]
pub struct PipelineConfig {
    pub brightness: Option<f32>,
    pub contrast: Option<f32>,
    pub saturation: Option<f32>,
    pub hue: Option<f32>,
    pub gamma: Option<f32>,
    pub blur_radius: Option<f32>,
    pub sharpen_amount: Option<f32>,
    pub noise_amount: Option<f32>,
    pub scale_factor: Option<f32>,
    pub rotate_angle: Option<f32>,
}

impl CliConfig {
    /// Parse command line arguments and create CLI configuration
    pub fn from_args() -> Result<Self, String> {
        Self::from_matches(build_cli().get_matches())
    }

    /// Create CLI configuration from parsed matches
    fn from_matches(matches: ArgMatches) -> Result<Self, String> {
        let example = matches.get_one::<PathBuf>("example").cloned();
        let input_path = matches.get_one::<PathBuf>("input").cloned();
        let output_path = matches.get_one::<PathBuf>("output").or(matches.get_one::<PathBuf>("input")).cloned();

        let output_precision = match matches.get_one::<String>("precision").map(|s| s.as_str()) {
            Some("8") => OutputPrecision::Bit8,
            Some("16") => OutputPrecision::Bit16,
            Some("32") | Some("float32") => OutputPrecision::Float32,
            _ => OutputPrecision::Float32, // Default to highest precision
        };

        let pipeline_config = PipelineConfig {
            brightness: matches.get_one::<f32>("brightness").copied(),
            contrast: matches.get_one::<f32>("contrast").copied(),
            saturation: matches.get_one::<f32>("saturation").copied(),
            hue: matches.get_one::<f32>("hue").copied(),
            gamma: matches.get_one::<f32>("gamma").copied(),
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
            output_precision,
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

        // Add processing nodes based on configuration
        if let Some(brightness) = self.pipeline_config.brightness {
            let node_id = pipeline.add_node("Brightness".to_string(), NodeType::Brightness);
            if let Some(node) = pipeline.get_node_mut(node_id) {
                node.set_params(NodeParams::Brightness { value: brightness });
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

        if let Some(contrast) = self.pipeline_config.contrast {
            let node_id = pipeline.add_node("Contrast".to_string(), NodeType::Contrast);
            if let Some(node) = pipeline.get_node_mut(node_id) {
                node.set_params(NodeParams::Contrast { value: contrast });
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

        if let Some(saturation) = self.pipeline_config.saturation {
            let node_id = pipeline.add_node("Saturation".to_string(), NodeType::Saturation);
            if let Some(node) = pipeline.get_node_mut(node_id) {
                node.set_params(NodeParams::Saturation { value: saturation });
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

        if let Some(hue) = self.pipeline_config.hue {
            let node_id = pipeline.add_node("Hue".to_string(), NodeType::Hue);
            if let Some(node) = pipeline.get_node_mut(node_id) {
                node.set_params(NodeParams::Hue { value: hue });
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

        if let Some(gamma) = self.pipeline_config.gamma {
            let node_id = pipeline.add_node("Gamma".to_string(), NodeType::Gamma);
            if let Some(node) = pipeline.get_node_mut(node_id) {
                node.set_params(NodeParams::Gamma { value: gamma });
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

        if let Some(blur_radius) = self.pipeline_config.blur_radius {
            let node_id = pipeline.add_node("Blur".to_string(), NodeType::Blur);
            if let Some(node) = pipeline.get_node_mut(node_id) {
                node.set_params(NodeParams::Blur {
                    radius: blur_radius,
                });
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

        if let Some(sharpen_amount) = self.pipeline_config.sharpen_amount {
            let node_id = pipeline.add_node("Sharpen".to_string(), NodeType::Sharpen);
            if let Some(node) = pipeline.get_node_mut(node_id) {
                node.set_params(NodeParams::Sharpen {
                    amount: sharpen_amount,
                });
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

        if let Some(noise_amount) = self.pipeline_config.noise_amount {
            let node_id = pipeline.add_node("Noise".to_string(), NodeType::Noise);
            if let Some(node) = pipeline.get_node_mut(node_id) {
                node.set_params(NodeParams::Noise {
                    amount: noise_amount,
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

        if let Some(scale_factor) = self.pipeline_config.scale_factor {
            let node_id = pipeline.add_node("Scale".to_string(), NodeType::Scale);
            if let Some(node) = pipeline.get_node_mut(node_id) {
                node.set_params(NodeParams::Scale {
                    factor: scale_factor,
                });
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

        if let Some(rotate_angle) = self.pipeline_config.rotate_angle {
            let node_id = pipeline.add_node("Rotate".to_string(), NodeType::Rotate);
            if let Some(node) = pipeline.get_node_mut(node_id) {
                node.set_params(NodeParams::Rotate {
                    angle: rotate_angle,
                });
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
        println!("Input:  {}", self.input_path.clone().unwrap().display());
        println!("Output: {}", self.output_path.clone().unwrap().display());
        println!();

        let mut operations = Vec::new();

        if let Some(brightness) = self.pipeline_config.brightness {
            operations.push(format!("Brightness: {:.2}", brightness));
        }
        if let Some(contrast) = self.pipeline_config.contrast {
            operations.push(format!("Contrast: {:.2}", contrast));
        }
        if let Some(saturation) = self.pipeline_config.saturation {
            operations.push(format!("Saturation: {:.2}", saturation));
        }
        if let Some(hue) = self.pipeline_config.hue {
            operations.push(format!("Hue: {:.2}°", hue));
        }
        if let Some(gamma) = self.pipeline_config.gamma {
            operations.push(format!("Gamma: {:.2}", gamma));
        }
        if let Some(blur_radius) = self.pipeline_config.blur_radius {
            operations.push(format!("Blur: {:.2}px", blur_radius));
        }
        if let Some(sharpen_amount) = self.pipeline_config.sharpen_amount {
            operations.push(format!("Sharpen: {:.2}", sharpen_amount));
        }
        if let Some(noise_amount) = self.pipeline_config.noise_amount {
            operations.push(format!("Noise: {:.2}", noise_amount));
        }
        if let Some(scale_factor) = self.pipeline_config.scale_factor {
            operations.push(format!("Scale: {:.2}x", scale_factor));
        }
        if let Some(rotate_angle) = self.pipeline_config.rotate_angle {
            operations.push(format!("Rotate: {:.2}°", rotate_angle));
        }

        if operations.is_empty() {
            println!("No operations specified - image will be passed through unchanged.");
        } else {
            println!("Operations to apply:");
            for (i, op) in operations.iter().enumerate() {
                println!("  {}. {}", i + 1, op);
            }
        }
        println!();
    }
}

/// Build the CLI command structure
fn build_cli() -> Command {
    Command::new("shade")
        .version("0.1.0")
        .author("Your Name <your.email@example.com>")
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
            Arg::new("precision")
                .short('p')
                .long("precision")
                .value_name("BITS")
                .help("Output precision: 8, 16, 32/float32 (default: 32)")
                .value_parser(value_parser!(String)),
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
            shade -i input.jpg -o output.jpg --brightness 0.2 --contrast 1.1\n    \
            shade -i photo.png -o enhanced.png --saturation 1.3 --sharpen 0.8\n    \
            shade -i image.jpg -o blurred.jpg --blur 2.5\n    \
            shade -i original.png -o processed.png -b 0.1 -c 1.2 -s 1.1 --gamma 0.9\n    \
            shade --example mandelbrot.raw --precision 32  # Output 32-bit float data\n    \
            shade -i input.jpg -o output.png --precision 16  # Output 16-bit PNG",
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
    println!("Complex processing chain:");
    println!("  shade -i original.png -o processed.png \\");
    println!("        --brightness 0.1 --contrast 1.2 --saturation 1.1 \\");
    println!("        --gamma 0.9 --sharpen 0.5");
    println!();
    println!("Geometric transformations:");
    println!("  shade -i input.jpg -o output.jpg --scale 1.5 --rotate 15");
    println!();
}

/// Validate CLI configuration
pub fn validate_config(config: &CliConfig) -> Result<(), String> {
    // Check input file exists
    if !config.input_path.clone().unwrap().exists() {
        return Err(format!(
            "Input file does not exist: {}",
            config.input_path.clone().unwrap().display()
        ));
    }

    // Check input file extension
    if let Some(ext) = config.input_path.clone().unwrap().extension() {
        let ext_str = ext.to_string_lossy().to_lowercase();
        if !["jpg", "jpeg", "png", "bmp", "tiff", "webp"].contains(&ext_str.as_str()) {
            return Err(format!("Unsupported input format: {}", ext_str));
        }
    } else {
        return Err("Input file has no extension".to_string());
    }

    // Validate parameter ranges
    if let Some(brightness) = config.pipeline_config.brightness {
        if brightness < -1.0 || brightness > 1.0 {
            return Err("Brightness must be between -1.0 and 1.0".to_string());
        }
    }

    if let Some(contrast) = config.pipeline_config.contrast {
        if contrast < 0.0 || contrast > 2.0 {
            return Err("Contrast must be between 0.0 and 2.0".to_string());
        }
    }

    if let Some(saturation) = config.pipeline_config.saturation {
        if saturation < 0.0 || saturation > 2.0 {
            return Err("Saturation must be between 0.0 and 2.0".to_string());
        }
    }

    if let Some(hue) = config.pipeline_config.hue {
        if hue < -180.0 || hue > 180.0 {
            return Err("Hue must be between -180.0 and 180.0 degrees".to_string());
        }
    }

    if let Some(gamma) = config.pipeline_config.gamma {
        if gamma < 0.1 || gamma > 3.0 {
            return Err("Gamma must be between 0.1 and 3.0".to_string());
        }
    }

    if let Some(blur_radius) = config.pipeline_config.blur_radius {
        if blur_radius < 0.0 || blur_radius > 100.0 {
            return Err("Blur radius must be between 0.0 and 100.0".to_string());
        }
    }

    if let Some(sharpen_amount) = config.pipeline_config.sharpen_amount {
        if sharpen_amount < 0.0 || sharpen_amount > 2.0 {
            return Err("Sharpen amount must be between 0.0 and 2.0".to_string());
        }
    }

    if let Some(noise_amount) = config.pipeline_config.noise_amount {
        if noise_amount < 0.0 || noise_amount > 1.0 {
            return Err("Noise amount must be between 0.0 and 1.0".to_string());
        }
    }

    if let Some(scale_factor) = config.pipeline_config.scale_factor {
        if scale_factor < 0.1 || scale_factor > 5.0 {
            return Err("Scale factor must be between 0.1 and 5.0".to_string());
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

        assert_eq!(config.input_path.clone().unwrap(), PathBuf::from("input.jpg"));
        assert_eq!(config.output_path.clone().unwrap(), PathBuf::from("output.jpg"));
        assert_eq!(config.pipeline_config.brightness, Some(0.2));
        assert_eq!(config.pipeline_config.contrast, Some(1.1));
    }

    #[test]
    fn test_pipeline_building() {
        let config = CliConfig {
            example: None,
            input_path: Some(PathBuf::from("input.jpg")),
            output_path: Some(PathBuf::from("output.jpg")),
            pipeline_config: PipelineConfig {
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
}
