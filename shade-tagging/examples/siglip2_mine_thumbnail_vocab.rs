use anyhow::{anyhow, Context, Result};
use shade_tagging::{
    photo_search_vocabulary, Siglip2Tagger, Siglip2TaggerConfig, TagImage,
};
use std::collections::BTreeMap;

#[derive(Default)]
struct LabelStats {
    count: usize,
    total_score: f32,
    max_score: f32,
    media_ids: Vec<String>,
}

#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<()> {
    let args = std::env::args().skip(1).collect::<Vec<_>>();
    if args.len() < 3 || args.len() > 5 {
        return Err(anyhow!(
            "usage: cargo run -p shade-tagging --example siglip2_mine_thumbnail_vocab -- <model_dir> <thumbnails_db_path> <limit> [min_score] [max_labels_per_image]"
        ));
    }
    let model_dir = &args[0];
    let db_path = &args[1];
    let limit = args[2].parse::<usize>()?;
    let min_score = args
        .get(3)
        .map(|value| value.parse::<f32>())
        .transpose()?
        .unwrap_or(0.08);
    let max_labels_per_image = args
        .get(4)
        .map(|value| value.parse::<usize>())
        .transpose()?
        .unwrap_or(3);
    let db = libsql::Builder::new_local(db_path)
        .build()
        .await
        .context("failed to open thumbnails db")?;
    let conn = db.connect().context("failed to connect to thumbnails db")?;
    let vocabulary = photo_search_vocabulary()?;
    let mut config = Siglip2TaggerConfig::base_patch16_224(model_dir);
    config.acceptance_threshold = min_score;
    let mut tagger = Siglip2Tagger::new(config)?;
    let samples = load_samples(&conn, limit).await?;
    let mut labels = BTreeMap::<String, LabelStats>::new();
    for sample in samples {
        let image = image::load_from_memory(&sample.data).with_context(|| {
            format!("failed to decode thumbnail for {}", sample.media_id)
        })?;
        let scores = tagger.score_image_with_vocabulary(
            &TagImage::from_dynamic_image(image),
            &vocabulary,
        )?;
        for (label, score) in scores
            .into_iter()
            .filter(|(_, score)| *score >= min_score)
            .take(max_labels_per_image)
        {
            let stats = labels.entry(label).or_default();
            stats.count += 1;
            stats.total_score += score;
            stats.max_score = stats.max_score.max(score);
            if stats.media_ids.len() < 3 {
                stats.media_ids.push(sample.media_id.clone());
            }
        }
    }
    let mut rows = labels.into_iter().collect::<Vec<_>>();
    rows.sort_by(|left, right| {
        right
            .1
            .count
            .cmp(&left.1.count)
            .then_with(|| right.1.max_score.total_cmp(&left.1.max_score))
            .then_with(|| left.0.cmp(&right.0))
    });
    for (label, stats) in rows {
        let avg = stats.total_score / stats.count as f32;
        println!(
            "{}|count={}|avg={:.4}|max={:.4}|examples={}",
            label,
            stats.count,
            avg,
            stats.max_score,
            stats.media_ids.join(" ; ")
        );
    }
    Ok(())
}

struct ThumbnailSample {
    media_id: String,
    data: Vec<u8>,
}

async fn load_samples(
    conn: &libsql::Connection,
    limit: usize,
) -> Result<Vec<ThumbnailSample>> {
    let mut rows = conn
        .query(
            "SELECT media_id, data FROM thumbnails ORDER BY picture_id ASC LIMIT ?1",
            [limit.to_string()],
        )
        .await
        .map_err(|error| anyhow!(error.to_string()))?;
    let mut samples = Vec::new();
    while let Some(row) = rows
        .next()
        .await
        .map_err(|error| anyhow!(error.to_string()))?
    {
        samples.push(ThumbnailSample {
            media_id: row
                .get::<String>(0)
                .map_err(|error| anyhow!(error.to_string()))?,
            data: row
                .get::<Vec<u8>>(1)
                .map_err(|error| anyhow!(error.to_string()))?,
        });
    }
    Ok(samples)
}
