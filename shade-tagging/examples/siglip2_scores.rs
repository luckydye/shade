use anyhow::{anyhow, Result};
use shade_tagging::{Siglip2Tagger, Siglip2TaggerConfig, TagImage};

fn main() -> Result<()> {
    let mut args = std::env::args().skip(1).collect::<Vec<_>>();
    if args.len() < 3 {
        return Err(anyhow!(
            "usage: cargo run -p shade-tagging --example siglip2_scores -- <model_dir> <image_path> <label> [<label> ...]"
        ));
    }
    let labels = args.split_off(2);
    let image = image::open(&args[1])?;
    let mut config = Siglip2TaggerConfig::base_patch16_224(&args[0]);
    config.score_threshold = 0.0;
    config.max_tags = labels.len();
    let mut tagger = Siglip2Tagger::new(config)?;
    let result = tagger.tag_image(&TagImage::from_dynamic_image(image), &labels)?;
    for tag in result.tags {
        println!("{:.4}\t{}", tag.score, tag.label);
    }
    Ok(())
}
