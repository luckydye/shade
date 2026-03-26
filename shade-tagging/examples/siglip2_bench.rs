use anyhow::{anyhow, Result};
use shade_tagging::{
    photo_search_vocabulary, Siglip2Tagger, Siglip2TaggerConfig, TagImage,
};
use std::time::Instant;

fn main() -> Result<()> {
    let args = std::env::args().skip(1).collect::<Vec<_>>();
    if args.len() != 3 {
        return Err(anyhow!(
            "usage: cargo run -p shade-tagging --example siglip2_bench -- <model_dir> <image_path> <iterations>"
        ));
    }
    let iterations = args[2].parse::<usize>()?;
    let image = TagImage::from_dynamic_image(image::open(&args[1])?);
    let vocabulary = photo_search_vocabulary()?;

    let t0 = Instant::now();
    let mut tagger = Siglip2Tagger::new(Siglip2TaggerConfig::base_patch16_224(&args[0]))?;
    let init_secs = t0.elapsed().as_secs_f64();
    println!("init_secs={init_secs:.4}");

    for idx in 0..iterations {
        let t0 = Instant::now();
        let result = tagger.tag_image_with_vocabulary(&image, &vocabulary)?;
        let infer_secs = t0.elapsed().as_secs_f64();
        let first = result.tags.first().map(|tag| format!("{}:{:.4}", tag.label, tag.score));
        println!("run={idx} infer_secs={infer_secs:.4} first={}", first.unwrap_or_default());
    }

    Ok(())
}
