use anyhow::{anyhow, Result};
use shade_tagging::{photo_search_vocabulary, Siglip2Tagger, Siglip2TaggerConfig, TagImage};

fn main() -> Result<()> {
    let args = std::env::args().skip(1).collect::<Vec<_>>();
    if args.len() != 2 {
        return Err(anyhow!(
            "usage: cargo run -p shade-tagging --example siglip2_photo_search -- <model_dir> <image_path>"
        ));
    }
    let image = image::open(&args[1])?;
    let vocabulary = photo_search_vocabulary()?;
    let mut tagger = Siglip2Tagger::new(Siglip2TaggerConfig::base_patch16_224(&args[0]))?;
    let result = tagger.tag_image_with_vocabulary(&TagImage::from_dynamic_image(image), &vocabulary)?;
    for tag in result.tags {
        println!("{:.4}\t{}", tag.score, tag.label);
    }
    Ok(())
}
