use anyhow::{anyhow, Result};
use shade_tagging::{
    photo_auto_tag_vocabulary, Siglip2Tagger, Siglip2TaggerConfig, TagImage,
};

fn main() -> Result<()> {
    let args = std::env::args().skip(1).collect::<Vec<_>>();
    if args.len() != 2 {
        return Err(anyhow!(
            "usage: cargo run -p shade-tagging --example siglip2_auto_tags -- <model_dir> <image_path>"
        ));
    }
    let image = image::open(&args[1])?;
    let vocabulary = photo_auto_tag_vocabulary()?;
    let mut config = Siglip2TaggerConfig::base_patch16_224(&args[0]);
    config.acceptance_threshold = 0.05;
    let mut tagger = Siglip2Tagger::new(config)?;
    let result = tagger
        .tag_image_with_vocabulary(&TagImage::from_dynamic_image(image), &vocabulary)?;
    if result.tags.is_empty() {
        println!("no-tags");
        return Ok(());
    }
    for tag in result.tags {
        println!("{:.4}\t{}", tag.score, tag.label);
    }
    Ok(())
}
