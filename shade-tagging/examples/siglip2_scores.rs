use anyhow::{anyhow, Result};
use shade_tagging::{
    prepare_vocabulary_entries, Siglip2Tagger, Siglip2TaggerConfig, TagImage,
};

fn main() -> Result<()> {
    let mut args = std::env::args().skip(1).collect::<Vec<_>>();
    if args.len() < 3 {
        return Err(anyhow!(
            "usage: cargo run -p shade-tagging --example siglip2_scores -- <model_dir> <image_path> <label> [<label> ...]"
        ));
    }
    let labels = args.split_off(2);
    let image = image::open(&args[1])?;
    let vocabulary = prepare_vocabulary_entries(&labels)?;
    let mut tagger = Siglip2Tagger::new(Siglip2TaggerConfig::base_patch16_224(&args[0]))?;
    for (label, score) in tagger.score_image_with_vocabulary(
        &TagImage::from_dynamic_image(image),
        &vocabulary,
    )? {
        println!("{:.4}\t{}", score, label);
    }
    Ok(())
}
