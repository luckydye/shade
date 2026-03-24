#[cfg(not(any(target_os = "ios", target_os = "android")))]
use crate::thumbnail_cache::ThumbnailCacheEntry;
#[cfg(not(any(target_os = "ios", target_os = "android")))]
use tauri::Manager;

#[cfg(not(any(target_os = "ios", target_os = "android")))]
pub struct ThumbnailTaggingService(pub crossbeam_channel::Sender<ThumbnailCacheEntry>);

#[cfg(not(any(target_os = "ios", target_os = "android")))]
pub fn spawn_thumbnail_tagging_worker(
    thumbnail_cache: std::sync::Arc<crate::thumbnail_cache::ThumbnailCacheDb>,
) -> Result<ThumbnailTaggingService, String> {
    let model_dir = thumbnail_tagging_model_dir()?;
    let vocabulary = shade_tagging::photo_search_vocabulary().map_err(|e| e.to_string())?;
    let startup_entries =
        tauri::async_runtime::block_on(thumbnail_cache.list_entries()).map_err(|e| e.to_string())?;
    let (sender, receiver) = crossbeam_channel::unbounded::<ThumbnailCacheEntry>();
    std::thread::Builder::new()
        .name("shade-thumbnail-tagging".into())
        .spawn(move || {
            let runtime = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .expect("failed to create thumbnail tagging runtime");
            let mut tagger = shade_tagging::Siglip2Tagger::new(
                shade_tagging::Siglip2TaggerConfig::base_patch16_224(&model_dir),
            )
            .expect("failed to initialize SigLIP2 thumbnail tagging model");
            for entry in startup_entries {
                process_thumbnail_tagging_entry(&runtime, &mut tagger, &vocabulary, entry)
                    .expect("failed to process startup thumbnail tagging entry");
            }
            while let Ok(entry) = receiver.recv() {
                process_thumbnail_tagging_entry(&runtime, &mut tagger, &vocabulary, entry)
                    .expect("failed to process thumbnail tagging entry");
            }
        })
        .map_err(|e| e.to_string())?;
    Ok(ThumbnailTaggingService(sender))
}

#[cfg(not(any(target_os = "ios", target_os = "android")))]
pub fn process_thumbnail_tagging_entry(
    runtime: &tokio::runtime::Runtime,
    tagger: &mut shade_tagging::Siglip2Tagger,
    vocabulary: &[shade_tagging::TagVocabularyEntry],
    entry: ThumbnailCacheEntry,
) -> Result<(), String> {
    if runtime.block_on(crate::commands::media_tags_exist(&entry.media_id))? {
        return Ok(());
    }
    let image = image::load_from_memory(&entry.data).map_err(|e| e.to_string())?;
    let result = tagger
        .tag_image_with_vocabulary(
            &shade_tagging::TagImage::from_dynamic_image(image),
            vocabulary,
        )
        .map_err(|e| e.to_string())?;
    if result.tags.is_empty() {
        return Ok(());
    }
    runtime.block_on(crate::commands::persist_media_tags(
        &entry.media_id,
        &result
            .tags
            .into_iter()
            .map(|tag| tag.label)
            .collect::<Vec<_>>(),
    ))?;
    Ok(())
}

#[cfg(not(any(target_os = "ios", target_os = "android")))]
pub fn enqueue_thumbnail_for_tagging<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    entry: ThumbnailCacheEntry,
) -> Result<(), String> {
    app.state::<ThumbnailTaggingService>()
        .0
        .send(entry)
        .map_err(|error: crossbeam_channel::SendError<ThumbnailCacheEntry>| {
            error.to_string()
        })
}

#[cfg(not(any(target_os = "ios", target_os = "android")))]
pub fn thumbnail_tagging_model_dir() -> Result<std::path::PathBuf, String> {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .ok_or("failed to resolve workspace root")?;
    let model_dir = root.join("models/siglip2-base-patch16-224-onnx");
    if !model_dir.is_dir() {
        return Err(format!(
            "thumbnail tagging model directory does not exist: {}",
            model_dir.display()
        ));
    }
    Ok(model_dir)
}
