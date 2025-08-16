use ini::Ini;
use std::path::PathBuf;

use crate::cli::{self, CliConfig, PipelineConfig, PipelineOperation};

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
