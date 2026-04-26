//! Text-layer data model: text content, style, and font registry types.
//!
//! This module is intentionally rendering-backend-agnostic. It defines the
//! declarative description of a text layer that travels through the document
//! (serde-serializable, no GPU types). The rasterizer and GPU placement
//! pipeline live elsewhere and consume these types.

use serde::{Deserialize, Serialize};
use std::ops::Range;

/// Identifier for a font registered in a [`crate::LayerStack`].
pub type FontId = u64;

/// A 64-bit content hash of a font blob, used for dedup and cache keys.
pub type FontBlobHash = u64;

/// Horizontal alignment of text within its layout box.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
pub enum TextAlign {
    #[default]
    Left,
    Center,
    Right,
    Justify,
}

/// Origin point used when applying the layer's `AffineTransform`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
pub enum TextAnchor {
    #[default]
    TopLeft,
    TopCenter,
    TopRight,
    CenterLeft,
    Center,
    CenterRight,
    BottomLeft,
    BottomCenter,
    BottomRight,
    BaselineLeft,
    BaselineCenter,
    BaselineRight,
}

/// Per-range style overrides for rich-text runs.
///
/// `range` is a byte range into [`TextContent::text`]. Empty `spans` means the
/// entire string uses [`TextStyle`] defaults.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TextSpan {
    pub range: Range<usize>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub override_font: Option<FontId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub override_color: Option<[f32; 4]>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub override_size_px: Option<f32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub override_weight: Option<u16>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub override_italic: Option<bool>,
}

/// Textual content of a text layer.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
pub struct TextContent {
    pub text: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub spans: Vec<TextSpan>,
}

impl TextContent {
    pub fn new(text: impl Into<String>) -> Self {
        Self {
            text: text.into(),
            spans: Vec::new(),
        }
    }
}

/// Layer-level style applied where [`TextSpan`] overrides do not specify.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TextStyle {
    pub font_id: FontId,
    /// Font size in canvas pixels at 1:1 zoom.
    pub size_px: f32,
    /// Multiplier of `size_px`; 1.2 is a common default.
    pub line_height: f32,
    /// Extra horizontal spacing between glyphs in canvas pixels.
    pub letter_spacing: f32,
    /// Maximum line width in canvas pixels; `None` disables wrapping.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_width: Option<f32>,
    #[serde(default)]
    pub align: TextAlign,
    #[serde(default)]
    pub anchor: TextAnchor,
    /// OpenType weight (100..=900). 400 = regular, 700 = bold.
    pub weight: u16,
    pub italic: bool,
    /// Default fill colour, **linear sRGB, straight alpha**.
    pub color: [f32; 4],
}

impl TextStyle {
    /// Construct a style with sensible defaults for `font_id` at `size_px`.
    pub fn new(font_id: FontId, size_px: f32) -> Self {
        Self {
            font_id,
            size_px,
            line_height: 1.2,
            letter_spacing: 0.0,
            max_width: None,
            align: TextAlign::default(),
            anchor: TextAnchor::default(),
            weight: 400,
            italic: false,
            color: [1.0, 1.0, 1.0, 1.0],
        }
    }
}

/// A font blob registered with a [`crate::LayerStack`].
///
/// `blob` is the raw OTF/TTF/TTC bytes; it is persisted with the document via
/// base64 so projects round-trip without external font dependencies.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FontEntry {
    /// Human-readable family/style label (informational, not used for lookup).
    pub family: String,
    #[serde(with = "crate::base64_serde")]
    pub blob: Vec<u8>,
    /// FNV-1a 64-bit hash of `blob`, used as a stable dedup key.
    pub blob_hash: FontBlobHash,
}

impl FontEntry {
    pub fn new(family: impl Into<String>, blob: Vec<u8>) -> Self {
        let blob_hash = fnv1a_64(&blob);
        Self {
            family: family.into(),
            blob,
            blob_hash,
        }
    }
}

/// FNV-1a 64-bit hash. Stable across platforms and Rust versions.
pub(crate) fn fnv1a_64(bytes: &[u8]) -> u64 {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for &b in bytes {
        h ^= b as u64;
        h = h.wrapping_mul(0x0000_0100_0000_01b3);
    }
    h
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fnv1a_known_vectors() {
        // FNV-1a 64-bit reference vectors.
        assert_eq!(fnv1a_64(b""), 0xcbf2_9ce4_8422_2325);
        assert_eq!(fnv1a_64(b"a"), 0xaf63_dc4c_8601_ec8c);
        assert_eq!(fnv1a_64(b"foobar"), 0x8594_4171_f739_67e8);
    }

    #[test]
    fn font_entry_hash_is_content_addressed() {
        let a = FontEntry::new("Roboto", b"abc".to_vec());
        let b = FontEntry::new("Different family label", b"abc".to_vec());
        assert_eq!(a.blob_hash, b.blob_hash);

        let c = FontEntry::new("Roboto", b"abd".to_vec());
        assert_ne!(a.blob_hash, c.blob_hash);
    }

    #[test]
    fn text_style_defaults_are_reasonable() {
        let s = TextStyle::new(7, 24.0);
        assert_eq!(s.font_id, 7);
        assert_eq!(s.size_px, 24.0);
        assert_eq!(s.weight, 400);
        assert!(!s.italic);
        assert_eq!(s.line_height, 1.2);
        assert_eq!(s.color, [1.0, 1.0, 1.0, 1.0]);
        assert!(s.max_width.is_none());
        assert_eq!(s.align, TextAlign::Left);
    }

    #[test]
    fn text_content_new_has_no_spans() {
        let c = TextContent::new("hi");
        assert_eq!(c.text, "hi");
        assert!(c.spans.is_empty());
    }

    #[test]
    fn text_content_serde_round_trip_with_spans() {
        let mut c = TextContent::new("hello");
        c.spans.push(TextSpan {
            range: 0..2,
            override_color: Some([1.0, 0.0, 0.0, 1.0]),
            override_font: None,
            override_size_px: None,
            override_weight: Some(700),
            override_italic: None,
        });
        let json = serde_json::to_string(&c).unwrap();
        let back: TextContent = serde_json::from_str(&json).unwrap();
        assert_eq!(back, c);
    }

    #[test]
    fn text_style_serde_round_trip() {
        let s = TextStyle {
            font_id: 42,
            size_px: 18.0,
            line_height: 1.4,
            letter_spacing: 0.5,
            max_width: Some(640.0),
            align: TextAlign::Center,
            anchor: TextAnchor::Center,
            weight: 600,
            italic: true,
            color: [0.1, 0.2, 0.3, 0.9],
        };
        let json = serde_json::to_string(&s).unwrap();
        let back: TextStyle = serde_json::from_str(&json).unwrap();
        assert_eq!(back, s);
    }

    #[test]
    fn text_content_omits_empty_spans_in_json() {
        let c = TextContent::new("hello");
        let json = serde_json::to_string(&c).unwrap();
        assert!(!json.contains("spans"), "empty spans should be skipped: {json}");
    }

    #[test]
    fn font_entry_blob_serde_round_trip_via_base64() {
        let bytes: Vec<u8> = (0u8..=255).collect();
        let entry = FontEntry::new("Test", bytes.clone());
        let json = serde_json::to_string(&entry).unwrap();
        let back: FontEntry = serde_json::from_str(&json).unwrap();
        assert_eq!(back.family, "Test");
        assert_eq!(back.blob, bytes);
        assert_eq!(back.blob_hash, entry.blob_hash);
    }
}
