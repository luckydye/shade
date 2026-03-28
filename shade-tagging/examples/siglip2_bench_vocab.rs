use anyhow::{anyhow, Result};
use shade_tagging::{Siglip2Tagger, Siglip2TaggerConfig, TagImage, TagVocabularyEntry};
use std::time::Instant;

fn main() -> Result<()> {
    let mut args = std::env::args().skip(1).collect::<Vec<_>>();
    if args.len() < 4 {
        return Err(anyhow!(
            "usage: cargo run -p shade-tagging --example siglip2_bench_vocab -- <model_dir> <image_path> <iterations> <label[=variant|variant...]> [<label[=variant|variant...]> ...]"
        ));
    }
    let raw_entries = args.split_off(3);
    let iterations = args[2].parse::<usize>()?;
    let image = TagImage::from_dynamic_image(image::open(&args[1])?);
    let vocabulary = raw_entries
        .into_iter()
        .map(parse_vocabulary_entry)
        .collect::<Result<Vec<_>>>()?;

    let t0 = Instant::now();
    let mut tagger = Siglip2Tagger::new(Siglip2TaggerConfig::base_patch16_224(&args[0]))?;
    let init_secs = t0.elapsed().as_secs_f64();
    println!("init_secs={init_secs:.4}");

    for idx in 0..iterations {
        let t0 = Instant::now();
        let result = tagger.tag_image_with_vocabulary(&image, &vocabulary)?;
        let infer_secs = t0.elapsed().as_secs_f64();
        let first = result
            .tags
            .first()
            .map(|tag| format!("{}:{:.4}", tag.label, tag.score));
        println!(
            "run={idx} infer_secs={infer_secs:.4} first={}",
            first.unwrap_or_default()
        );
    }
    Ok(())
}

fn parse_vocabulary_entry(raw: String) -> Result<TagVocabularyEntry> {
    let Some((label, variants)) = raw.split_once('=') else {
        return TagVocabularyEntry::new(raw);
    };
    TagVocabularyEntry::with_variants(label, variants.split('|'))
}
