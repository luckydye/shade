//! Text shaping and layout via `cosmic-text`.
//!
//! Bridges the declarative [`TextContent`]/[`TextStyle`] data model to a flat
//! list of [`PlacedGlyph`]s in canvas pixels, suitable for the GPU rasterizer.
//!
//! `cosmic-text` is invoked with a manually-constructed `fontdb::Database`
//! (no system probe) so this module is wasm-clean and pulls only the fonts
//! registered on the surrounding [`crate::LayerStack`].

use anyhow::{anyhow, Context, Result};
use cosmic_text::{
    fontdb, Attrs, Buffer, Family, FontSystem, Metrics, Shaping, Style as CtStyle, Weight,
};
use std::collections::HashMap;
use std::sync::Arc;

use crate::text::{FontEntry, FontId, TextContent, TextStyle};
use crate::text_buffer::PlacedGlyph;

/// Stateful layout engine. Owns a `cosmic_text::FontSystem` populated from
/// shade's [`FontEntry`] map, plus the bidirectional id mapping needed to
/// translate shaped glyphs back into shade [`FontId`]s.
pub struct TextLayoutEngine {
    font_system: FontSystem,
    /// shade `FontId` → canonical family name to drive `Attrs::family`.
    font_families: HashMap<FontId, String>,
    /// `fontdb::ID` → shade `FontId` for translating shaped glyphs.
    fontdb_to_shade: HashMap<fontdb::ID, FontId>,
}

impl TextLayoutEngine {
    /// Build an engine from the fonts currently registered on a `LayerStack`.
    pub fn new(fonts: &HashMap<FontId, FontEntry>) -> Result<Self> {
        let mut db = fontdb::Database::new();
        let mut font_families = HashMap::new();
        let mut fontdb_to_shade = HashMap::new();

        for (&shade_id, entry) in fonts {
            let source = fontdb::Source::Binary(Arc::new(entry.blob.clone()));
            let ids = db.load_font_source(source);
            if ids.is_empty() {
                return Err(anyhow!(
                    "fontdb refused to parse FontEntry {shade_id} (family={:?})",
                    entry.family
                ));
            }
            // First face in a collection is the canonical lookup target.
            if let Some(face_info) = db.face(ids[0]) {
                if let Some((name, _)) = face_info.families.first() {
                    font_families.insert(shade_id, name.clone());
                }
            }
            for id in ids.iter() {
                fontdb_to_shade.insert(*id, shade_id);
            }
        }

        // Locale only affects script-fallback selection; "en-US" is a safe
        // default for Latin-first documents and avoids env-dependent probing.
        let font_system = FontSystem::new_with_locale_and_db("en-US".to_string(), db);
        Ok(Self {
            font_system,
            font_families,
            fontdb_to_shade,
        })
    }

    /// Shape and layout `content` according to `style`. Coordinates are in
    /// canvas pixels (top-down Y), with glyph positions on the baseline.
    pub fn layout(&mut self, content: &TextContent, style: &TextStyle) -> Result<Vec<PlacedGlyph>> {
        if content.text.is_empty() {
            return Ok(Vec::new());
        }
        let family_name = self
            .font_families
            .get(&style.font_id)
            .cloned()
            .ok_or_else(|| anyhow!("font_id {} is not registered with the engine", style.font_id))?;

        let metrics = Metrics::new(style.size_px, style.size_px * style.line_height);
        let mut buffer = Buffer::new(&mut self.font_system, metrics);
        buffer.set_size(&mut self.font_system, style.max_width, None);

        let weight = Weight(style.weight);
        let cstyle = if style.italic {
            CtStyle::Italic
        } else {
            CtStyle::Normal
        };
        let attrs = Attrs::new()
            .family(Family::Name(&family_name))
            .weight(weight)
            .style(cstyle);

        buffer.set_text(&mut self.font_system, &content.text, attrs, Shaping::Advanced);
        buffer.shape_until_scroll(&mut self.font_system, false);

        let mut placed = Vec::new();
        for run in buffer.layout_runs() {
            for glyph in run.glyphs.iter() {
                // Pen position in float canvas-pixel coords (top-down Y).
                // Mirrors LayoutGlyph::physical's float math, sans rounding.
                let pen_x = glyph.x + glyph.font_size * glyph.x_offset;
                let pen_y = (glyph.y - glyph.font_size * glyph.y_offset) + run.line_y;

                let shade_id = self
                    .fontdb_to_shade
                    .get(&glyph.font_id)
                    .copied()
                    // Fall back to the requested font; a missing entry means
                    // cosmic-text fell through to a script-fallback we never
                    // registered, which v1 documents simply won't have.
                    .unwrap_or(style.font_id);

                placed.push(PlacedGlyph {
                    font_id: shade_id,
                    glyph_id: glyph.glyph_id,
                    x: pen_x,
                    y: pen_y,
                    size_px: glyph.font_size,
                    color: style.color,
                });
            }
        }
        Ok(placed)
    }
}

/// One-shot layout: build a [`TextLayoutEngine`], call [`TextLayoutEngine::layout`],
/// and discard the engine. Convenient for tests and ad-hoc rendering; for
/// production use, hold an engine on the renderer to reuse the font cache.
pub fn layout_text(
    content: &TextContent,
    style: &TextStyle,
    fonts: &HashMap<FontId, FontEntry>,
) -> Result<Vec<PlacedGlyph>> {
    let mut engine = TextLayoutEngine::new(fonts).context("constructing TextLayoutEngine")?;
    engine.layout(content, style)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::text::{TextContent, TextStyle};
    use std::collections::HashMap;

    /// Locate a TTF/OTF on disk for live shaping tests. Returns `None` when
    /// no system font is present so the test gracefully skips on minimal CI.
    fn try_load_test_font() -> Option<(String, Vec<u8>)> {
        let candidates = [
            "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
            "/usr/share/fonts/TTF/DejaVuSans.ttf",
            "/usr/share/fonts/dejavu/DejaVuSans.ttf",
            "/usr/share/fonts/opentype/tlwg/Loma.otf",
            "/Library/Fonts/Helvetica.ttc",
            "/System/Library/Fonts/Helvetica.ttc",
            "C:\\Windows\\Fonts\\arial.ttf",
        ];
        for path in candidates {
            if let Ok(bytes) = std::fs::read(path) {
                return Some((path.to_string(), bytes));
            }
        }
        None
    }

    fn skip_or_engine_with_font() -> Option<(TextLayoutEngine, FontId, HashMap<FontId, FontEntry>)>
    {
        let (path, bytes) = match try_load_test_font() {
            Some(v) => v,
            None => {
                eprintln!("SKIP: no system font available for layout test");
                return None;
            }
        };
        eprintln!("layout test using font: {path}");
        let mut fonts = HashMap::new();
        let entry = FontEntry::new("test", bytes);
        fonts.insert(1u64, entry);
        let engine = TextLayoutEngine::new(&fonts).unwrap();
        Some((engine, 1u64, fonts))
    }

    #[test]
    fn empty_text_yields_empty_glyphs() {
        let fonts: HashMap<FontId, FontEntry> = HashMap::new();
        let placed = layout_text(
            &TextContent::new(""),
            &TextStyle::new(0, 16.0),
            &fonts,
        )
        .unwrap();
        assert!(placed.is_empty());
    }

    #[test]
    fn unregistered_font_id_is_an_error() {
        let fonts: HashMap<FontId, FontEntry> = HashMap::new();
        let err = layout_text(
            &TextContent::new("hello"),
            &TextStyle::new(0, 16.0),
            &fonts,
        )
        .unwrap_err();
        let msg = format!("{err}");
        assert!(msg.contains("not registered"), "unexpected error: {msg}");
    }

    #[test]
    fn engine_constructor_accepts_empty_font_map() {
        let fonts: HashMap<FontId, FontEntry> = HashMap::new();
        TextLayoutEngine::new(&fonts).expect("empty font map should be allowed");
    }

    #[test]
    fn engine_constructor_rejects_garbage_blob() {
        let mut fonts = HashMap::new();
        fonts.insert(1u64, FontEntry::new("not-a-font", b"definitely not a font".to_vec()));
        match TextLayoutEngine::new(&fonts) {
            Ok(_) => panic!("expected fontdb to reject the garbage blob"),
            Err(e) => assert!(format!("{e}").contains("fontdb refused")),
        }
    }

    // ── Live tests using a real system font ───────────────────────────────

    #[test]
    fn shapes_ascii_text_into_left_to_right_glyphs() {
        let Some((mut engine, font_id, _fonts)) = skip_or_engine_with_font() else {
            return;
        };
        let placed = engine
            .layout(&TextContent::new("Hello"), &TextStyle::new(font_id, 32.0))
            .expect("layout failed");
        assert!(
            !placed.is_empty(),
            "shaping 'Hello' must produce at least one glyph"
        );
        // Glyph x positions monotonic non-decreasing for LTR Latin.
        for w in placed.windows(2) {
            assert!(
                w[1].x >= w[0].x,
                "glyphs not left-to-right: {} then {}",
                w[0].x,
                w[1].x
            );
        }
        // All glyphs report the requested size.
        for g in &placed {
            assert!((g.size_px - 32.0).abs() < 1e-3);
        }
        // All glyphs map back to the registered shade FontId.
        for g in &placed {
            assert_eq!(g.font_id, font_id);
        }
    }

    #[test]
    fn max_width_forces_a_line_break() {
        let Some((mut engine, font_id, _fonts)) = skip_or_engine_with_font() else {
            return;
        };
        let mut style = TextStyle::new(font_id, 32.0);
        // Narrow box should force wrapping for a multi-word string.
        style.max_width = Some(40.0);
        let placed = engine
            .layout(
                &TextContent::new("the quick brown fox"),
                &style,
            )
            .expect("layout failed");
        // Multiple lines → at least one glyph y > the first glyph's y.
        let first_y = placed[0].y;
        let any_below = placed.iter().any(|g| g.y > first_y + 1.0);
        assert!(
            any_below,
            "expected wrapping to a second line, but all glyphs share y={first_y}"
        );
    }

    #[test]
    fn larger_size_produces_proportionally_larger_advance() {
        let Some((mut engine, font_id, _fonts)) = skip_or_engine_with_font() else {
            return;
        };
        let small = engine
            .layout(&TextContent::new("AB"), &TextStyle::new(font_id, 16.0))
            .unwrap();
        let large = engine
            .layout(&TextContent::new("AB"), &TextStyle::new(font_id, 64.0))
            .unwrap();
        assert_eq!(small.len(), 2);
        assert_eq!(large.len(), 2);
        let small_advance = small[1].x - small[0].x;
        let large_advance = large[1].x - large[0].x;
        let ratio = large_advance / small_advance;
        // Within ~3% of 4× — small slack accommodates hinting / sub-pixel binning.
        assert!(
            (ratio - 4.0).abs() < 0.12,
            "advance ratio expected ~4×, got {ratio} (small={small_advance}, large={large_advance})"
        );
    }
}
