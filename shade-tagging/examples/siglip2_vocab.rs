use anyhow::{anyhow, Result};
use shade_tagging::{Siglip2Tagger, Siglip2TaggerConfig, TagImage, TagVocabularyEntry};

fn main() -> Result<()> {
    let mut args = std::env::args().skip(1).collect::<Vec<_>>();
    if args.len() < 3 {
        return Err(anyhow!(
            "usage: cargo run -p shade-tagging --example siglip2_vocab -- <model_dir> <image_path> <label[=variant|variant...]> [<label[=variant|variant...]> ...]"
        ));
    }
    let entries = args
        .split_off(2)
        .into_iter()
        .map(parse_vocabulary_entry)
        .collect::<Result<Vec<_>>>()?;
    let image = image::open(&args[1])?;
    let mut tagger = Siglip2Tagger::new(Siglip2TaggerConfig::base_patch16_224(&args[0]))?;
    let result = tagger
        .tag_image_with_vocabulary(&TagImage::from_dynamic_image(image), &entries)?;
    for tag in result.tags {
        println!("{:.4}\t{}", tag.score, tag.label);
    }
    Ok(())
}

fn parse_vocabulary_entry(raw: String) -> Result<TagVocabularyEntry> {
    let Some((label, variants)) = raw.split_once('=') else {
        return TagVocabularyEntry::new(raw);
    };
    TagVocabularyEntry::with_variants(label, variants.split('|'))
}
