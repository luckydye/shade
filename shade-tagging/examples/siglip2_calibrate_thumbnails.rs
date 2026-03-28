use anyhow::{anyhow, Context, Result};
use shade_tagging::{
    photo_auto_tag_vocabulary, Siglip2Tagger, Siglip2TaggerConfig, TagImage,
};

struct CalibrationSample {
    media_id: String,
    expected_label: Option<String>,
}

#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<()> {
    let mut args = std::env::args().skip(1).collect::<Vec<_>>();
    if args.len() < 3 {
        return Err(anyhow!(
            "usage: cargo run -p shade-tagging --example siglip2_calibrate_thumbnails -- <model_dir> <thumbnails_db_path> <media_id[=expected_label]> [<media_id[=expected_label]> ...]"
        ));
    }
    let model_dir = args.remove(0);
    let db_path = args.remove(0);
    let samples = args
        .into_iter()
        .map(parse_sample)
        .collect::<Result<Vec<_>>>()?;
    let db = libsql::Builder::new_local(db_path)
        .build()
        .await
        .context("failed to open thumbnails db")?;
    let conn = db.connect().context("failed to connect to thumbnails db")?;
    let vocabulary = photo_auto_tag_vocabulary()?;
    let mut config = Siglip2TaggerConfig::base_patch16_224(&model_dir);
    config.acceptance_threshold = 0.03;
    let mut tagger = Siglip2Tagger::new(config)?;
    for sample in samples {
        let Some(bytes) = load_thumbnail_bytes(&conn, &sample.media_id).await? else {
            println!("missing|{}", sample.media_id);
            continue;
        };
        let image = image::load_from_memory(&bytes).with_context(|| {
            format!("failed to decode thumbnail for {}", sample.media_id)
        })?;
        let scores = tagger.score_image_with_vocabulary(
            &TagImage::from_dynamic_image(image),
            &vocabulary,
        )?;
        let accepted = scores
            .iter()
            .filter(|(_, score)| *score >= tagger.config.acceptance_threshold)
            .map(|(label, score)| format!("{label}:{score:.4}"))
            .collect::<Vec<_>>();
        let expected_score = sample.expected_label.as_ref().and_then(|expected| {
            scores
                .iter()
                .find(|(label, _)| label == expected)
                .map(|(_, score)| *score)
        });
        let expected = sample.expected_label.unwrap_or_default();
        println!(
            "{}|expected={}|score={}|accepted={}",
            sample.media_id,
            expected,
            expected_score
                .map(|score| format!("{score:.4}"))
                .unwrap_or_else(|| "-".to_string()),
            accepted.join(",")
        );
    }
    Ok(())
}

fn parse_sample(raw: String) -> Result<CalibrationSample> {
    let Some((media_id, expected_label)) = raw.split_once('=') else {
        return Ok(CalibrationSample {
            media_id: raw,
            expected_label: None,
        });
    };
    Ok(CalibrationSample {
        media_id: media_id.to_string(),
        expected_label: Some(expected_label.to_string()),
    })
}

async fn load_thumbnail_bytes(
    conn: &libsql::Connection,
    media_id: &str,
) -> Result<Option<Vec<u8>>> {
    let mut rows = conn
        .query(
            "SELECT data FROM thumbnails WHERE media_id = ?1 LIMIT 1",
            [media_id],
        )
        .await
        .map_err(|error| anyhow!(error.to_string()))?;
    let Some(row) = rows
        .next()
        .await
        .map_err(|error| anyhow!(error.to_string()))?
    else {
        return Ok(None);
    };
    Ok(Some(
        row.get::<Vec<u8>>(0)
            .map_err(|error| anyhow!(error.to_string()))?,
    ))
}
