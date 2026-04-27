//! GPU buffer encoding for Slug-style text rendering.
//!
//! Translates the CPU-side outline geometry produced by
//! [`crate::text_outline`] into the four shared storage buffers consumed by
//! the text render pass — plus a per-layer instance buffer of placed glyphs.
//!
//! Buffer layout (std430 on the WGSL side, all 16-byte safe on the Rust side):
//!
//! - `curves: array<f32>`           — 6 floats per quadratic Bézier
//!   `(p1.x, p1.y, p2.x, p2.y, p3.x, p3.y)`, tightly packed. Curves are
//!   indexed by their position in this array as `QuadBezier` units; the
//!   shader multiplies by 6 to get the float offset.
//! - `band_headers: array<GpuBandHeader>` — 8 bytes each, one per band.
//!   For each glyph the headers are laid out as `[h_bands…, v_bands…]`,
//!   matching the Slug shader's `glyphLoc.x + bandIndex.y` (H) and
//!   `glyphLoc.x + bandMax.y + 1 + bandIndex.x` (V) reads.
//! - `band_curves: array<u32>`      — flat list of **global** curve indices
//!   (into `curves` in QuadBezier units). Each header's
//!   `[curves_offset, curves_offset + curve_count)` slice is sorted by
//!   descending max-x (H bands) or max-y (V bands).
//! - `glyph_metas: array<GpuGlyphMeta>` — 64 bytes each, one per unique
//!   `(FontId, glyph_id)` registered in the layout.
//! - `instances: array<GpuPlacedGlyph>` — 48 bytes each, one per placed glyph
//!   for a given text layer.

use anyhow::{anyhow, Result};
use bytemuck::{Pod, Zeroable};
use std::collections::HashMap;

use crate::text::FontId;
use crate::text_outline::GlyphCurves;

/// Number of floats stored per quadratic Bézier in the curves buffer
/// (3 control points × 2 coords).
pub const FLOATS_PER_CURVE: usize = 6;

/// Per-glyph metadata, 64 bytes / 16-byte aligned.
#[repr(C)]
#[derive(Debug, Clone, Copy, PartialEq, Pod, Zeroable)]
pub struct GpuGlyphMeta {
    /// First curve of this glyph in the global `curves` array, measured in
    /// `QuadBezier` units (multiply by `FLOATS_PER_CURVE` for the float index).
    pub curves_offset: u32,
    /// Index into `band_headers` where this glyph's H-then-V header block begins.
    pub band_headers_offset: u32,
    /// Maximum V-band index — i.e. `num_v_bands - 1` — for `clamp` in the shader.
    pub band_max_x: u32,
    /// Maximum H-band index — i.e. `num_h_bands - 1`.
    pub band_max_y: u32,
    /// `(scale_x, scale_y, offset_x, offset_y)` so that
    /// `band_index_xy = clamp(floor(em_coord · scale + offset), 0, band_max_xy)`.
    pub band_transform: [f32; 4],
    /// Em-units bounding box: `[x_min, y_min, x_max, y_max]`.
    pub em_bbox: [f32; 4],
    pub units_per_em: f32,
    pub _pad: [f32; 3],
}

/// One band's `(curve_count, curves_offset)` header, 8 bytes.
///
/// `curves_offset` is an absolute index into the global `band_curves` buffer.
#[repr(C)]
#[derive(Debug, Clone, Copy, PartialEq, Pod, Zeroable)]
pub struct GpuBandHeader {
    pub curve_count: u32,
    pub curves_offset: u32,
}

/// One placed glyph (instance) in canvas pixels, 48 bytes / 16-byte aligned.
#[repr(C)]
#[derive(Debug, Clone, Copy, PartialEq, Pod, Zeroable)]
pub struct GpuPlacedGlyph {
    /// Index into the `glyph_metas` buffer.
    pub meta_index: u32,
    pub _pad0: [u32; 3],
    /// `[x, y, size_px, _unused]`. `(x, y)` is the glyph's pen position
    /// in canvas pixels; `size_px` is the rendered em size.
    pub xy_size: [f32; 4],
    /// Linear sRGB, straight alpha.
    pub color: [f32; 4],
}

/// Logical placed-glyph used by the layout stage.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct PlacedGlyph {
    pub font_id: FontId,
    pub glyph_id: u16,
    pub x: f32,
    pub y: f32,
    pub size_px: f32,
    pub color: [f32; 4],
}

/// Accumulator that builds the four shared storage buffers from a stream of
/// glyphs. Idempotent on `(FontId, glyph_id)` — re-adding a glyph returns its
/// existing meta index without growing any buffer.
#[derive(Debug, Default)]
pub struct GlyphBufferLayout {
    /// `FLOATS_PER_CURVE` floats per quadratic Bézier.
    pub curves: Vec<f32>,
    /// One header per band; H bands first, then V bands, contiguous per glyph.
    pub band_headers: Vec<GpuBandHeader>,
    /// Global curve indices (in `QuadBezier` units), referenced by headers.
    pub band_curves: Vec<u32>,
    pub glyph_metas: Vec<GpuGlyphMeta>,
    glyph_lookup: HashMap<(FontId, u16), u32>,
}

impl GlyphBufferLayout {
    pub fn new() -> Self {
        Self::default()
    }

    /// Look up an already-encoded glyph; returns `None` if not yet added.
    pub fn meta_index(&self, font_id: FontId, glyph_id: u16) -> Option<u32> {
        self.glyph_lookup.get(&(font_id, glyph_id)).copied()
    }

    /// Append `glyph`'s curves, bands, and metadata to the buffers, returning
    /// the newly-assigned meta index. If `(font_id, glyph_id)` is already
    /// present, returns the existing index without modifying any buffer.
    pub fn add_glyph(
        &mut self,
        font_id: FontId,
        glyph_id: u16,
        glyph: &GlyphCurves,
    ) -> u32 {
        if let Some(existing) = self.meta_index(font_id, glyph_id) {
            return existing;
        }
        // Curves: append all of this glyph's quadratics. `curves_base` is the
        // first new curve's index in `QuadBezier` units.
        let curves_base = (self.curves.len() / FLOATS_PER_CURVE) as u32;
        for q in &glyph.curves {
            self.curves
                .extend_from_slice(&[q.p0[0], q.p0[1], q.p1[0], q.p1[1], q.p2[0], q.p2[1]]);
        }

        // Bands: H first, then V. Each band emits one header plus a slice of
        // global curve indices into `band_curves`.
        let band_headers_offset = self.band_headers.len() as u32;
        for band in glyph.h_bands.iter().chain(glyph.v_bands.iter()) {
            let curves_offset = self.band_curves.len() as u32;
            for &local_idx in &band.curve_indices {
                self.band_curves.push(curves_base + local_idx);
            }
            self.band_headers.push(GpuBandHeader {
                curve_count: band.curve_indices.len() as u32,
                curves_offset,
            });
        }

        let meta = GpuGlyphMeta {
            curves_offset: curves_base,
            band_headers_offset,
            band_max_x: glyph.v_bands.len().saturating_sub(1) as u32,
            band_max_y: glyph.h_bands.len().saturating_sub(1) as u32,
            band_transform: glyph.band_transform,
            em_bbox: [
                glyph.em_bbox.min[0],
                glyph.em_bbox.min[1],
                glyph.em_bbox.max[0],
                glyph.em_bbox.max[1],
            ],
            units_per_em: glyph.units_per_em as f32,
            _pad: [0.0; 3],
        };
        let meta_index = self.glyph_metas.len() as u32;
        self.glyph_metas.push(meta);
        self.glyph_lookup.insert((font_id, glyph_id), meta_index);
        meta_index
    }

    /// Encode a list of [`PlacedGlyph`]s as `GpuPlacedGlyph` instances. Every
    /// referenced glyph must have been previously registered via
    /// [`Self::add_glyph`].
    pub fn build_instances(&self, placed: &[PlacedGlyph]) -> Result<Vec<GpuPlacedGlyph>> {
        let mut out = Vec::with_capacity(placed.len());
        for p in placed {
            let meta_index = self.meta_index(p.font_id, p.glyph_id).ok_or_else(|| {
                anyhow!(
                    "placed glyph (font={}, id={}) has no registered meta",
                    p.font_id,
                    p.glyph_id
                )
            })?;
            out.push(GpuPlacedGlyph {
                meta_index,
                _pad0: [0; 3],
                xy_size: [p.x, p.y, p.size_px, 0.0],
                color: p.color,
            });
        }
        Ok(out)
    }

    /// Number of unique glyphs registered.
    pub fn glyph_count(&self) -> usize {
        self.glyph_metas.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::text_outline::{GlyphBand, QuadBezier, Rect};

    // Compile-time layout assertions catch padding mistakes.
    const _: () = {
        assert!(std::mem::size_of::<GpuGlyphMeta>() == 64);
        assert!(std::mem::size_of::<GpuBandHeader>() == 8);
        assert!(std::mem::size_of::<GpuPlacedGlyph>() == 48);
    };

    /// Two curves, both H- and V-bands trivially containing both. 8 bands
    /// per axis to test header layout density.
    fn sample_glyph() -> GlyphCurves {
        let curves = vec![
            QuadBezier {
                p0: [0.0, 0.0],
                p1: [5.0, 10.0],
                p2: [10.0, 0.0],
            },
            QuadBezier {
                p0: [10.0, 0.0],
                p1: [15.0, 5.0],
                p2: [20.0, 0.0],
            },
        ];
        let h_bands = vec![GlyphBand {
            curve_indices: vec![1, 0],
        }];
        let v_bands = vec![GlyphBand {
            curve_indices: vec![0, 1],
        }];
        GlyphCurves {
            curves,
            h_bands,
            v_bands,
            band_transform: [0.05, 0.1, 0.0, 0.0],
            em_bbox: Rect {
                min: [0.0, 0.0],
                max: [20.0, 10.0],
            },
            advance: 20.0,
            units_per_em: 1000,
        }
    }

    #[test]
    fn empty_layout_has_no_buffers() {
        let layout = GlyphBufferLayout::new();
        assert!(layout.curves.is_empty());
        assert!(layout.band_headers.is_empty());
        assert!(layout.band_curves.is_empty());
        assert!(layout.glyph_metas.is_empty());
        assert_eq!(layout.glyph_count(), 0);
    }

    #[test]
    fn add_glyph_lays_out_curves_headers_and_meta() {
        let mut layout = GlyphBufferLayout::new();
        let g = sample_glyph();
        let idx = layout.add_glyph(7, 42, &g);
        assert_eq!(idx, 0);

        // 2 curves × 6 floats.
        assert_eq!(layout.curves.len(), 2 * FLOATS_PER_CURVE);

        // 1 H band + 1 V band → 2 headers, contiguous H then V.
        assert_eq!(layout.band_headers.len(), 2);
        assert_eq!(layout.band_headers[0].curve_count, 2); // H band
        assert_eq!(layout.band_headers[0].curves_offset, 0);
        assert_eq!(layout.band_headers[1].curve_count, 2); // V band
        assert_eq!(layout.band_headers[1].curves_offset, 2);

        // band_curves stores GLOBAL indices [1, 0, 0, 1] for first glyph
        // (curves_base = 0 here; H sort then V sort preserved).
        assert_eq!(layout.band_curves, vec![1, 0, 0, 1]);

        let meta = layout.glyph_metas[0];
        assert_eq!(meta.curves_offset, 0);
        assert_eq!(meta.band_headers_offset, 0);
        assert_eq!(meta.band_max_x, 0);
        assert_eq!(meta.band_max_y, 0);
        assert_eq!(meta.band_transform, [0.05, 0.1, 0.0, 0.0]);
        assert_eq!(meta.em_bbox, [0.0, 0.0, 20.0, 10.0]);
        assert_eq!(meta.units_per_em, 1000.0);
    }

    #[test]
    fn add_glyph_is_idempotent_on_font_glyph_pair() {
        let mut layout = GlyphBufferLayout::new();
        let g = sample_glyph();
        let a = layout.add_glyph(1, 5, &g);
        let curves_len = layout.curves.len();
        let headers_len = layout.band_headers.len();
        let band_curves_len = layout.band_curves.len();
        let metas_len = layout.glyph_metas.len();
        let b = layout.add_glyph(1, 5, &g);
        assert_eq!(a, b);
        assert_eq!(layout.curves.len(), curves_len);
        assert_eq!(layout.band_headers.len(), headers_len);
        assert_eq!(layout.band_curves.len(), band_curves_len);
        assert_eq!(layout.glyph_metas.len(), metas_len);
    }

    #[test]
    fn add_glyph_remaps_local_curve_indices_to_global() {
        // Two distinct glyphs sharing local curve indices [1, 0] / [0, 1].
        // The second glyph's band_curves entries must be offset by 2.
        let mut layout = GlyphBufferLayout::new();
        let g = sample_glyph();
        layout.add_glyph(1, 5, &g);
        layout.add_glyph(1, 6, &g);
        // First glyph contributes [1, 0, 0, 1]; second [3, 2, 2, 3] (shifted by 2).
        assert_eq!(layout.band_curves, vec![1, 0, 0, 1, 3, 2, 2, 3]);

        // Second glyph's meta points past the first's headers.
        let m1 = layout.glyph_metas[1];
        assert_eq!(m1.curves_offset, 2);
        assert_eq!(m1.band_headers_offset, 2);

        // Second glyph's H header points at the new band_curves slice.
        let header_h = layout.band_headers[m1.band_headers_offset as usize];
        assert_eq!(header_h.curves_offset, 4);
        assert_eq!(header_h.curve_count, 2);
    }

    #[test]
    fn add_glyph_multi_band_glyph_emits_h_then_v() {
        // 3 H bands + 5 V bands → 8 headers, H first.
        let curves = vec![QuadBezier {
            p0: [0.0, 0.0],
            p1: [5.0, 5.0],
            p2: [10.0, 0.0],
        }];
        let h_bands = vec![
            GlyphBand { curve_indices: vec![0] },
            GlyphBand { curve_indices: vec![] },
            GlyphBand { curve_indices: vec![] },
        ];
        let v_bands = vec![
            GlyphBand { curve_indices: vec![0] },
            GlyphBand { curve_indices: vec![0] },
            GlyphBand { curve_indices: vec![0] },
            GlyphBand { curve_indices: vec![] },
            GlyphBand { curve_indices: vec![] },
        ];
        let g = GlyphCurves {
            curves,
            h_bands,
            v_bands,
            band_transform: [0.1, 0.1, 0.0, 0.0],
            em_bbox: Rect {
                min: [0.0, 0.0],
                max: [10.0, 10.0],
            },
            advance: 10.0,
            units_per_em: 1000,
        };
        let mut layout = GlyphBufferLayout::new();
        layout.add_glyph(1, 1, &g);
        assert_eq!(layout.band_headers.len(), 8);
        let meta = layout.glyph_metas[0];
        assert_eq!(meta.band_max_y, 2); // 3 H bands
        assert_eq!(meta.band_max_x, 4); // 5 V bands
        // First three headers are H bands (counts 1, 0, 0).
        assert_eq!(layout.band_headers[0].curve_count, 1);
        assert_eq!(layout.band_headers[1].curve_count, 0);
        assert_eq!(layout.band_headers[2].curve_count, 0);
        // Next five are V bands (counts 1, 1, 1, 0, 0).
        assert_eq!(layout.band_headers[3].curve_count, 1);
        assert_eq!(layout.band_headers[4].curve_count, 1);
        assert_eq!(layout.band_headers[5].curve_count, 1);
        assert_eq!(layout.band_headers[6].curve_count, 0);
        assert_eq!(layout.band_headers[7].curve_count, 0);
    }

    #[test]
    fn empty_glyph_records_meta_with_no_bands_or_curves() {
        let mut layout = GlyphBufferLayout::new();
        let empty = GlyphCurves {
            curves: vec![],
            h_bands: vec![],
            v_bands: vec![],
            band_transform: [0.0; 4],
            em_bbox: Rect::ZERO,
            advance: 250.0,
            units_per_em: 1000,
        };
        let idx = layout.add_glyph(1, 0, &empty);
        assert_eq!(idx, 0);
        assert!(layout.curves.is_empty());
        assert!(layout.band_headers.is_empty());
        assert!(layout.band_curves.is_empty());
        let meta = layout.glyph_metas[0];
        assert_eq!(meta.band_max_x, 0);
        assert_eq!(meta.band_max_y, 0);
    }

    #[test]
    fn meta_index_returns_none_for_unregistered_glyph() {
        let layout = GlyphBufferLayout::new();
        assert!(layout.meta_index(1, 99).is_none());
    }

    #[test]
    fn build_instances_maps_placed_glyphs_to_meta_indices() {
        let mut layout = GlyphBufferLayout::new();
        let g = sample_glyph();
        let m1 = layout.add_glyph(1, 5, &g);
        let m2 = layout.add_glyph(1, 6, &g);
        let placed = [
            PlacedGlyph {
                font_id: 1,
                glyph_id: 5,
                x: 10.0,
                y: 100.0,
                size_px: 24.0,
                color: [1.0, 0.0, 0.0, 1.0],
            },
            PlacedGlyph {
                font_id: 1,
                glyph_id: 6,
                x: 30.0,
                y: 100.0,
                size_px: 24.0,
                color: [0.0, 1.0, 0.0, 1.0],
            },
        ];
        let instances = layout.build_instances(&placed).unwrap();
        assert_eq!(instances.len(), 2);
        assert_eq!(instances[0].meta_index, m1);
        assert_eq!(instances[0].xy_size, [10.0, 100.0, 24.0, 0.0]);
        assert_eq!(instances[0].color, [1.0, 0.0, 0.0, 1.0]);
        assert_eq!(instances[1].meta_index, m2);
        assert_eq!(instances[1].xy_size, [30.0, 100.0, 24.0, 0.0]);
    }

    #[test]
    fn build_instances_errors_on_unregistered_glyph() {
        let layout = GlyphBufferLayout::new();
        let placed = [PlacedGlyph {
            font_id: 99,
            glyph_id: 1,
            x: 0.0,
            y: 0.0,
            size_px: 16.0,
            color: [1.0; 4],
        }];
        let err = layout.build_instances(&placed).unwrap_err();
        let msg = format!("{err}");
        assert!(msg.contains("font=99"), "unexpected error: {msg}");
        assert!(msg.contains("id=1"));
    }

    #[test]
    fn buffers_are_pod_castable_to_bytes() {
        let mut layout = GlyphBufferLayout::new();
        layout.add_glyph(1, 5, &sample_glyph());
        let _curves_bytes: &[u8] = bytemuck::cast_slice(&layout.curves);
        let _headers_bytes: &[u8] = bytemuck::cast_slice(&layout.band_headers);
        let _band_curves_bytes: &[u8] = bytemuck::cast_slice(&layout.band_curves);
        let _meta_bytes: &[u8] = bytemuck::cast_slice(&layout.glyph_metas);
    }
}
