use anyhow::{anyhow, Context, Result};
use image::{imageops::FilterType, DynamicImage, ImageBuffer, Rgba};
use ort::{
    ep::CUDA,
    session::{Session, SessionInputValue},
    value::Tensor,
};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use tokenizers::{
    PaddingDirection, PaddingParams, PaddingStrategy, Tokenizer, TruncationParams,
};

pub mod photo_search;

pub use photo_search::{
    build_tag_vocabulary_entries, photo_auto_tag_vocabulary,
    photo_search_animal_vocabulary, photo_search_architecture_vocabulary,
    photo_search_food_vocabulary, photo_search_light_vocabulary,
    photo_search_nature_vocabulary, photo_search_object_vocabulary,
    photo_search_people_vocabulary, photo_search_place_vocabulary,
    photo_search_style_vocabulary, photo_search_travel_vocabulary,
    photo_search_vocabulary, photo_search_vocabulary_categories, TagVocabularyCategory,
    TagVocabularySeed,
};

const DEFAULT_PROMPT_PREFIX: &str = "This is a photo of ";
const DEFAULT_PROMPT_SUFFIX: &str = ".";
const DEFAULT_TEXT_LENGTH: usize = 64;
const DEFAULT_ACCEPTANCE_THRESHOLD: f32 = 0.1;
const DEFAULT_MAX_TAGS: usize = 12;
const DEFAULT_IMAGE_MEAN: [f32; 3] = [0.5, 0.5, 0.5];
const DEFAULT_IMAGE_STD: [f32; 3] = [0.5, 0.5, 0.5];

// Extracted from the combined ONNX model's graph initializers.
const LOGIT_SCALE: f32 = 112.6689;
const LOGIT_BIAS: f32 = -16.771725;

/// Usage:
/// `let mut tagger = Siglip2Tagger::new(Siglip2TaggerConfig::base_patch16_224("/models/siglip2"))?;`
/// `let result = tagger.tag_image(&TagImage::from_dynamic_image(image), &["portrait".into(), "dog".into()])?;`
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct TagImage {
    pub rgba8: Vec<u8>,
    pub width: u32,
    pub height: u32,
}

impl TagImage {
    pub fn from_dynamic_image(image: DynamicImage) -> Self {
        let rgba8 = image.to_rgba8();
        Self {
            width: rgba8.width(),
            height: rgba8.height(),
            rgba8: rgba8.into_raw(),
        }
    }

    pub fn into_dynamic_image(&self) -> Result<DynamicImage> {
        let Some(image) = ImageBuffer::<Rgba<u8>, Vec<u8>>::from_raw(
            self.width,
            self.height,
            self.rgba8.clone(),
        ) else {
            return Err(anyhow!(
                "invalid RGBA buffer for image dimensions {}x{}",
                self.width,
                self.height
            ));
        };
        Ok(DynamicImage::ImageRgba8(image))
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct TagSuggestion {
    pub label: String,
    pub score: f32,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct TagResult {
    pub model_id: String,
    pub tags: Vec<TagSuggestion>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct TagVocabularyEntry {
    pub label: String,
    pub variants: Vec<String>,
}

impl TagVocabularyEntry {
    pub fn new(label: impl AsRef<str>) -> Result<Self> {
        let label = normalize_candidate_label(label.as_ref());
        if label.is_empty() {
            return Err(anyhow!("tag vocabulary label cannot be empty"));
        }
        Ok(Self {
            variants: build_default_candidate_variants(&label),
            label,
        })
    }

    pub fn with_variants(
        label: impl AsRef<str>,
        variants: impl IntoIterator<Item = impl AsRef<str>>,
    ) -> Result<Self> {
        let label = normalize_candidate_label(label.as_ref());
        if label.is_empty() {
            return Err(anyhow!("tag vocabulary label cannot be empty"));
        }
        let mut normalized_variants = build_default_candidate_variants(&label)
            .into_iter()
            .collect::<BTreeSet<_>>();
        normalized_variants.extend(
            variants
                .into_iter()
                .map(|variant| normalize_candidate_label(variant.as_ref()))
                .filter(|variant| !variant.is_empty()),
        );
        Ok(Self {
            label,
            variants: normalized_variants.into_iter().collect(),
        })
    }
}

#[derive(Clone, Debug)]
pub struct Siglip2TaggerConfig {
    pub model_dir: PathBuf,
    pub vision_model_file: PathBuf,
    pub text_model_file: PathBuf,
    pub tokenizer_file: PathBuf,
    pub config_file: PathBuf,
    pub preprocessor_config_file: PathBuf,
    pub max_text_length: usize,
    pub acceptance_threshold: f32,
    pub max_tags: usize,
    pub prompt_prefix: String,
    pub prompt_suffix: String,
}

impl Siglip2TaggerConfig {
    pub fn base_patch16_224(model_dir: impl Into<PathBuf>) -> Self {
        let model_dir = model_dir.into();
        Self {
            vision_model_file: model_dir.join("onnx/vision_model.onnx"),
            text_model_file: model_dir.join("onnx/text_model.onnx"),
            tokenizer_file: model_dir.join("tokenizer.json"),
            config_file: model_dir.join("config.json"),
            preprocessor_config_file: model_dir.join("preprocessor_config.json"),
            model_dir,
            max_text_length: DEFAULT_TEXT_LENGTH,
            acceptance_threshold: DEFAULT_ACCEPTANCE_THRESHOLD,
            max_tags: DEFAULT_MAX_TAGS,
            prompt_prefix: DEFAULT_PROMPT_PREFIX.to_string(),
            prompt_suffix: DEFAULT_PROMPT_SUFFIX.to_string(),
        }
    }

    pub fn validate(&self) -> Result<()> {
        if !self.model_dir.is_dir() {
            return Err(anyhow!(
                "SigLIP2 model directory does not exist: {}",
                self.model_dir.display()
            ));
        }
        if !self.vision_model_file.is_file() {
            return Err(anyhow!(
                "SigLIP2 vision ONNX file does not exist: {}",
                self.vision_model_file.display()
            ));
        }
        if !self.text_model_file.is_file() {
            return Err(anyhow!(
                "SigLIP2 text ONNX file does not exist: {}",
                self.text_model_file.display()
            ));
        }
        if !self.tokenizer_file.is_file() {
            return Err(anyhow!(
                "SigLIP2 tokenizer does not exist: {}",
                self.tokenizer_file.display()
            ));
        }
        if !self.config_file.is_file() {
            return Err(anyhow!(
                "SigLIP2 config does not exist: {}",
                self.config_file.display()
            ));
        }
        if !self.preprocessor_config_file.is_file() {
            return Err(anyhow!(
                "SigLIP2 preprocessor config does not exist: {}",
                self.preprocessor_config_file.display()
            ));
        }
        if self.max_text_length == 0 {
            return Err(anyhow!("SigLIP2 max_text_length must be greater than zero"));
        }
        if !(0.0..=1.0).contains(&self.acceptance_threshold) {
            return Err(anyhow!(
                "SigLIP2 acceptance_threshold must be in [0.0, 1.0], got {}",
                self.acceptance_threshold
            ));
        }
        if self.max_tags == 0 {
            return Err(anyhow!("SigLIP2 max_tags must be greater than zero"));
        }
        if self.prompt_prefix.trim().is_empty() {
            return Err(anyhow!("SigLIP2 prompt_prefix cannot be empty"));
        }
        if self.prompt_suffix.trim().is_empty() {
            return Err(anyhow!("SigLIP2 prompt_suffix cannot be empty"));
        }
        Ok(())
    }
}

pub struct Siglip2Tagger {
    pub config: Siglip2TaggerConfig,
    pub tokenizer: Tokenizer,
    pub vision_session: Session,
    pub text_session: Session,
    pub model_id: String,
    pub image_size: usize,
    /// Cached L2-normalized text embeddings keyed by prompt string.
    /// Populated on first use; reused for all subsequent images.
    text_embedding_cache: BTreeMap<String, Vec<f32>>,
}

impl Siglip2Tagger {
    pub fn new(config: Siglip2TaggerConfig) -> Result<Self> {
        config.validate()?;
        let model_info = Siglip2ModelInfo::from_files(
            &config.config_file,
            &config.preprocessor_config_file,
        )?;
        let mut tokenizer = Tokenizer::from_file(&config.tokenizer_file)
            .map_err(|error| anyhow!("failed to load SigLIP2 tokenizer: {error}"))?;
        tokenizer.with_padding(Some(PaddingParams {
            strategy: PaddingStrategy::Fixed(config.max_text_length),
            direction: PaddingDirection::Right,
            ..Default::default()
        }));
        tokenizer
            .with_truncation(Some(TruncationParams {
                max_length: config.max_text_length,
                ..Default::default()
            }))
            .map_err(|error| anyhow!("failed to configure SigLIP2 tokenizer: {error}"))?;
        let execution_providers = [CUDA::default().build()];
        let vision_session = Session::builder()
            .context("failed to create ONNX Runtime session builder")?
            .with_execution_providers(execution_providers.clone())
            .map_err(|error| anyhow!("failed to configure execution providers: {error}"))?
            .commit_from_file(&config.vision_model_file)
            .with_context(|| {
                format!(
                    "failed to open SigLIP2 vision ONNX model: {}",
                    config.vision_model_file.display()
                )
            })?;
        let text_session = Session::builder()
            .context("failed to create ONNX Runtime session builder")?
            .with_execution_providers(execution_providers)
            .map_err(|error| anyhow!("failed to configure execution providers: {error}"))?
            .commit_from_file(&config.text_model_file)
            .with_context(|| {
                format!(
                    "failed to open SigLIP2 text ONNX model: {}",
                    config.text_model_file.display()
                )
            })?;
        Ok(Self {
            config,
            tokenizer,
            vision_session,
            text_session,
            model_id: model_info.model_id,
            image_size: model_info.image_size,
            text_embedding_cache: BTreeMap::new(),
        })
    }

    pub fn tag_image(
        &mut self,
        image: &TagImage,
        candidate_labels: &[String],
    ) -> Result<TagResult> {
        let vocabulary = prepare_vocabulary_entries(candidate_labels)?;
        self.tag_image_with_vocabulary(image, &vocabulary)
    }

    pub fn tag_image_with_vocabulary(
        &mut self,
        image: &TagImage,
        vocabulary: &[TagVocabularyEntry],
    ) -> Result<TagResult> {
        let mut tags = self
            .score_image_with_vocabulary(image, vocabulary)?
            .into_iter()
            .filter(|(_, score)| *score >= self.config.acceptance_threshold)
            .map(|(label, score)| TagSuggestion { label, score })
            .collect::<Vec<_>>();
        tags.sort_by(|left, right| {
            right
                .score
                .total_cmp(&left.score)
                .then_with(|| left.label.cmp(&right.label))
        });
        tags.truncate(self.config.max_tags);
        Ok(TagResult {
            model_id: self.model_id.clone(),
            tags,
        })
    }

    pub fn score_image_with_vocabulary(
        &mut self,
        image: &TagImage,
        vocabulary: &[TagVocabularyEntry],
    ) -> Result<Vec<(String, f32)>> {
        let vocabulary = normalize_tag_vocabulary(vocabulary)?;
        let prompt_entries = flatten_vocabulary_prompts(
            &vocabulary,
            &self.config.prompt_prefix,
            &self.config.prompt_suffix,
        )?;

        // Compute text embeddings for any prompts not already cached.
        let uncached_prompts = prompt_entries
            .iter()
            .map(|e| e.prompt.clone())
            .filter(|prompt| !self.text_embedding_cache.contains_key(prompt))
            .collect::<BTreeSet<_>>()
            .into_iter()
            .collect::<Vec<_>>();
        if !uncached_prompts.is_empty() {
            let embeddings = compute_text_embeddings(
                &mut self.text_session,
                &self.tokenizer,
                &uncached_prompts,
                self.config.max_text_length,
            )?;
            for (prompt, embedding) in uncached_prompts.into_iter().zip(embeddings) {
                self.text_embedding_cache.insert(prompt, embedding);
            }
        }

        // Single vision pass for this image.
        let image_embedding =
            compute_image_embedding(&mut self.vision_session, image, self.image_size)?;

        // Dot product + logit scale/bias + sigmoid, aggregating variants by max score.
        let mut aggregated = BTreeMap::<String, f32>::new();
        for entry in &prompt_entries {
            let text_embedding = self
                .text_embedding_cache
                .get(&entry.prompt)
                .expect("text embedding must be cached at this point");
            let dot: f32 = image_embedding
                .iter()
                .zip(text_embedding.iter())
                .map(|(a, b)| a * b)
                .sum();
            let score = sigmoid(dot * LOGIT_SCALE + LOGIT_BIAS);
            aggregated
                .entry(entry.label.clone())
                .and_modify(|current| *current = current.max(score))
                .or_insert(score);
        }

        let mut aggregated = aggregated.into_iter().collect::<Vec<_>>();
        aggregated.sort_by(|left, right| {
            right
                .1
                .total_cmp(&left.1)
                .then_with(|| left.0.cmp(&right.0))
        });
        Ok(aggregated)
    }

    pub fn render_prompt(&self, label: &str) -> String {
        render_siglip2_prompt(
            &self.config.prompt_prefix,
            &self.config.prompt_suffix,
            label,
        )
    }
}

#[derive(Clone, Debug)]
pub struct Siglip2PromptEntry {
    pub label: String,
    pub prompt: String,
}

#[derive(Clone, Debug, Deserialize)]
pub struct Siglip2ConfigFile {
    pub _name_or_path: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
pub struct Siglip2PreprocessorConfigFile {
    pub size: Siglip2PreprocessorSize,
}

#[derive(Clone, Debug, Deserialize)]
pub struct Siglip2PreprocessorSize {
    pub height: usize,
    pub width: usize,
}

#[derive(Clone, Debug)]
pub struct Siglip2ModelInfo {
    pub model_id: String,
    pub image_size: usize,
}

impl Siglip2ModelInfo {
    pub fn from_files(
        config_path: &Path,
        preprocessor_config_path: &Path,
    ) -> Result<Self> {
        let config = std::fs::read_to_string(config_path).with_context(|| {
            format!("failed to read SigLIP2 config: {}", config_path.display())
        })?;
        let parsed =
            serde_json::from_str::<Siglip2ConfigFile>(&config).with_context(|| {
                format!(
                    "failed to parse SigLIP2 config JSON: {}",
                    config_path.display()
                )
            })?;
        let preprocessor_config = std::fs::read_to_string(preprocessor_config_path)
            .with_context(|| {
                format!(
                    "failed to read SigLIP2 preprocessor config: {}",
                    preprocessor_config_path.display()
                )
            })?;
        let preprocessor_parsed =
            serde_json::from_str::<Siglip2PreprocessorConfigFile>(&preprocessor_config)
                .with_context(|| {
                format!(
                    "failed to parse SigLIP2 preprocessor config JSON: {}",
                    preprocessor_config_path.display()
                )
            })?;
        if preprocessor_parsed.size.height != preprocessor_parsed.size.width {
            return Err(anyhow!(
                "SigLIP2 preprocessor size must be square, got {}x{}",
                preprocessor_parsed.size.width,
                preprocessor_parsed.size.height
            ));
        }
        Ok(Self {
            model_id: parsed
                ._name_or_path
                .unwrap_or_else(|| "google/siglip2-base-patch16-224".to_string()),
            image_size: preprocessor_parsed.size.height,
        })
    }
}

pub fn compute_text_embeddings(
    session: &mut Session,
    tokenizer: &Tokenizer,
    prompts: &[String],
    sequence_length: usize,
) -> Result<Vec<Vec<f32>>> {
    let encodings = tokenizer
        .encode_batch(prompts.to_vec(), true)
        .map_err(|error| anyhow!("failed to tokenize SigLIP2 prompts: {error}"))?;
    let input_ids = encodings
        .iter()
        .flat_map(|enc| enc.get_ids().iter().copied().map(i64::from))
        .collect::<Vec<_>>();
    let batch_size = prompts.len();
    let input_tensor =
        Tensor::from_array((vec![batch_size as i64, sequence_length as i64], input_ids))?
            .upcast();
    let outputs = session
        .run(vec![(
            "input_ids".to_string(),
            SessionInputValue::from(input_tensor),
        )])
        .context("SigLIP2 text model inference failed")?;
    let pooler = outputs["pooler_output"]
        .try_extract_tensor::<f32>()
        .context("SigLIP2 text model output `pooler_output` is missing")?;
    // pooler shape: [batch, 768] — L2-normalize each row
    let embed_dim = pooler.1.len() / batch_size;
    Ok(pooler.1.chunks(embed_dim).map(l2_normalize).collect())
}

pub fn compute_image_embedding(
    session: &mut Session,
    image: &TagImage,
    image_size: usize,
) -> Result<Vec<f32>> {
    let pixel_values = preprocess_image(image, image_size)?;
    let pixel_tensor = Tensor::from_array((
        vec![1_i64, 3_i64, image_size as i64, image_size as i64],
        pixel_values,
    ))?
    .upcast();
    let outputs = session
        .run(vec![(
            "pixel_values".to_string(),
            SessionInputValue::from(pixel_tensor),
        )])
        .context("SigLIP2 vision model inference failed")?;
    let pooler = outputs["pooler_output"]
        .try_extract_tensor::<f32>()
        .context("SigLIP2 vision model output `pooler_output` is missing")?;
    Ok(l2_normalize(&pooler.1))
}

pub fn prepare_candidate_labels(candidate_labels: &[String]) -> Result<Vec<String>> {
    let labels = candidate_labels
        .iter()
        .map(|label| normalize_candidate_label(label))
        .filter(|label| !label.is_empty())
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect::<Vec<_>>();
    if labels.is_empty() {
        return Err(anyhow!(
            "at least one non-empty candidate label is required for SigLIP2 tagging"
        ));
    }
    Ok(labels)
}

pub fn prepare_vocabulary_entries(
    candidate_labels: &[String],
) -> Result<Vec<TagVocabularyEntry>> {
    prepare_candidate_labels(candidate_labels)?
        .into_iter()
        .map(TagVocabularyEntry::new)
        .collect()
}

pub fn normalize_candidate_label(label: &str) -> String {
    label
        .trim()
        .replace(['_', '-'], " ")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
}

pub fn build_default_candidate_variants(label: &str) -> Vec<String> {
    let label = normalize_candidate_label(label);
    if label.is_empty() {
        return Vec::new();
    }
    [
        label.clone(),
        format!("{} {}", english_indefinite_article(&label), label),
        format!("the {label}"),
    ]
    .into_iter()
    .collect::<BTreeSet<_>>()
    .into_iter()
    .collect()
}

pub fn english_indefinite_article(label: &str) -> &'static str {
    let Some(first_char) = label.chars().find(|char| char.is_ascii_alphanumeric()) else {
        return "a";
    };
    if matches!(first_char.to_ascii_lowercase(), 'a' | 'e' | 'i' | 'o' | 'u') {
        return "an";
    }
    "a"
}

pub fn normalize_tag_vocabulary(
    vocabulary: &[TagVocabularyEntry],
) -> Result<Vec<TagVocabularyEntry>> {
    let mut merged = BTreeMap::<String, BTreeSet<String>>::new();
    for entry in vocabulary {
        let normalized =
            TagVocabularyEntry::with_variants(&entry.label, &entry.variants)?;
        merged
            .entry(normalized.label)
            .or_default()
            .extend(normalized.variants);
    }
    if merged.is_empty() {
        return Err(anyhow!("tag vocabulary cannot be empty"));
    }
    Ok(merged
        .into_iter()
        .map(|(label, variants)| TagVocabularyEntry {
            label,
            variants: variants.into_iter().collect(),
        })
        .collect())
}

pub fn aggregate_variant_scores(
    prompt_labels: &[String],
    scores: &[f32],
) -> Result<Vec<(String, f32)>> {
    if prompt_labels.len() != scores.len() {
        return Err(anyhow!(
            "SigLIP2 returned {} scores for {} prompt labels",
            scores.len(),
            prompt_labels.len()
        ));
    }
    let mut aggregated = BTreeMap::<String, f32>::new();
    for (label, score) in prompt_labels.iter().zip(scores.iter().copied()) {
        aggregated
            .entry(label.clone())
            .and_modify(|current| *current = current.max(score))
            .or_insert(score);
    }
    let mut aggregated = aggregated.into_iter().collect::<Vec<_>>();
    aggregated.sort_by(|left, right| {
        right
            .1
            .total_cmp(&left.1)
            .then_with(|| left.0.cmp(&right.0))
    });
    Ok(aggregated)
}

pub fn flatten_vocabulary_prompts(
    vocabulary: &[TagVocabularyEntry],
    prompt_prefix: &str,
    prompt_suffix: &str,
) -> Result<Vec<Siglip2PromptEntry>> {
    let vocabulary = normalize_tag_vocabulary(vocabulary)?;
    Ok(vocabulary
        .into_iter()
        .flat_map(|entry| {
            entry
                .variants
                .into_iter()
                .map(|variant| Siglip2PromptEntry {
                    label: entry.label.clone(),
                    prompt: render_siglip2_prompt(prompt_prefix, prompt_suffix, &variant),
                })
                .collect::<Vec<_>>()
        })
        .collect())
}

pub fn preprocess_image(image: &TagImage, image_size: usize) -> Result<Vec<f32>> {
    let resized = image
        .into_dynamic_image()?
        .resize_exact(image_size as u32, image_size as u32, FilterType::Triangle)
        .to_rgb8();
    let mut pixel_values = Vec::with_capacity(image_size * image_size * 3);
    for channel in 0..3 {
        for y in 0..image_size {
            for x in 0..image_size {
                let sample = resized.get_pixel(x as u32, y as u32)[channel];
                let sample = sample as f32 / 255.0;
                let sample =
                    (sample - DEFAULT_IMAGE_MEAN[channel]) / DEFAULT_IMAGE_STD[channel];
                pixel_values.push(sample);
            }
        }
    }
    Ok(pixel_values)
}

pub fn render_siglip2_prompt(prefix: &str, suffix: &str, label: &str) -> String {
    format!("{prefix}{label}{suffix}")
}

pub fn l2_normalize(v: &[f32]) -> Vec<f32> {
    let norm = v.iter().map(|x| x * x).sum::<f32>().sqrt();
    v.iter().map(|x| x / norm).collect()
}

pub fn sigmoid(value: f32) -> f32 {
    1.0 / (1.0 + (-value).exp())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_candidate_labels() {
        let labels = prepare_candidate_labels(&[
            " portrait ".to_string(),
            "".to_string(),
            "Land_scape".to_string(),
            "portrait".to_string(),
        ])
        .expect("labels");
        assert_eq!(
            labels,
            vec!["land scape".to_string(), "portrait".to_string()]
        );
    }

    #[test]
    fn rejects_empty_candidate_labels() {
        let error = prepare_candidate_labels(&["  ".to_string()])
            .expect_err("expected validation error");
        assert!(error
            .to_string()
            .contains("at least one non-empty candidate label"));
    }

    #[test]
    fn builds_default_variants() {
        assert_eq!(
            build_default_candidate_variants("ornate window"),
            vec![
                "an ornate window".to_string(),
                "ornate window".to_string(),
                "the ornate window".to_string()
            ]
        );
        assert_eq!(
            build_default_candidate_variants("interior"),
            vec![
                "an interior".to_string(),
                "interior".to_string(),
                "the interior".to_string()
            ]
        );
    }

    #[test]
    fn merges_vocabulary_variants_by_label() {
        let vocabulary = normalize_tag_vocabulary(&[
            TagVocabularyEntry::new("window").expect("entry"),
            TagVocabularyEntry::with_variants(
                "window",
                ["stained glass window", "ornate window"],
            )
            .expect("entry"),
        ])
        .expect("vocabulary");
        assert_eq!(vocabulary.len(), 1);
        assert_eq!(vocabulary[0].label, "window");
        assert!(vocabulary[0]
            .variants
            .contains(&"stained glass window".to_string()));
        assert!(vocabulary[0]
            .variants
            .contains(&"ornate window".to_string()));
    }

    #[test]
    fn aggregates_variant_scores_by_max_score() {
        let aggregated = aggregate_variant_scores(
            &[
                "window".to_string(),
                "window".to_string(),
                "book".to_string(),
            ],
            &[0.2, 0.5, 0.3],
        )
        .expect("aggregated");
        assert_eq!(
            aggregated,
            vec![("window".to_string(), 0.5), ("book".to_string(), 0.3)]
        );
    }

    #[test]
    fn flattens_vocabulary_into_prompt_entries() {
        let prompts = flatten_vocabulary_prompts(
            &[TagVocabularyEntry::with_variants(
                "window",
                ["stained glass window", "ornate window"],
            )
            .expect("entry")],
            DEFAULT_PROMPT_PREFIX,
            DEFAULT_PROMPT_SUFFIX,
        )
        .expect("prompts");
        assert_eq!(prompts.len(), 5);
        assert!(prompts.iter().any(|entry| entry.label == "window"));
        assert!(prompts
            .iter()
            .any(|entry| { entry.prompt == "This is a photo of stained glass window." }));
    }

    #[test]
    fn builds_prompt_from_config() {
        let prompt = render_siglip2_prompt(
            DEFAULT_PROMPT_PREFIX,
            DEFAULT_PROMPT_SUFFIX,
            "portrait",
        );
        assert_eq!(prompt, "This is a photo of portrait.");
    }

    #[test]
    fn preprocesses_image_to_chw_tensor() {
        let image = TagImage {
            width: 1,
            height: 1,
            rgba8: vec![255, 127, 0, 255],
        };
        let processed = preprocess_image(&image, 1).expect("processed image");
        assert_eq!(processed.len(), 3);
        assert!((processed[0] - 1.0).abs() < 0.0001);
        assert!((processed[1] - (-0.0039215684)).abs() < 0.0001);
        assert!((processed[2] - (-1.0)).abs() < 0.0001);
    }

    #[test]
    fn sigmoid_maps_zero_to_half() {
        assert!((sigmoid(0.0) - 0.5).abs() < f32::EPSILON);
    }

    #[test]
    fn l2_normalize_produces_unit_vector() {
        let v = vec![3.0_f32, 4.0];
        let n = l2_normalize(&v);
        assert!((n[0] - 0.6).abs() < 1e-6);
        assert!((n[1] - 0.8).abs() < 1e-6);
    }
}
