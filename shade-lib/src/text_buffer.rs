//! GPU buffer encoding for text rendering.
//!
//! Translates the CPU-side outline geometry produced by
//! [`crate::text_outline`] into the four shared storage buffers consumed by
//! the text render pass — plus a per-layer instance buffer of placed glyphs.
//!
//! Buffer layout (std430 on the WGSL side, all 16-byte safe on the Rust side):
//!
//! - `curves: array<f32>`       — 6 floats per quadratic Bézier (p0, p1, p2),
//!   tightly packed; indexed by `GpuGlyphMeta::curves_offset` (in floats).
//! - `bands: array<GpuBand>`    — 16 bytes each.
//! - `band_curve_indices: array<u32>` — flat sparse index, sliced by each
//!   band's `[curve_start .. curve_start + curve_count)`.
//! - `glyph_metas: array<GpuGlyphMeta>` — 48 bytes each, one per unique
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

/// Per-glyph metadata, 48 bytes / 16-byte aligned.
#[repr(C)]
#[derive(Debug, Clone, Copy, PartialEq, Pod, Zeroable)]
pub struct GpuGlyphMeta {
    /// Offset (in `f32`s) into the global curves buffer.
    pub curves_offset: u32,
    /// Offset (in `GpuBand`s) into the global bands buffer.
    pub bands_offset: u32,
    /// Number of bands belonging to this glyph.
    pub bands_count: u32,
    pub _pad0: u32,
    /// Em-units bounding box: `[x_min, y_min, x_max, y_max]`.
    pub em_bbox: [f32; 4],
    pub units_per_em: f32,
    pub _pad1: [f32; 3],
}

/// One horizontal band within a glyph's bbox, 16 bytes.
#[repr(C)]
#[derive(Debug, Clone, Copy, PartialEq, Pod, Zeroable)]
pub struct GpuBand {
    pub y_min: f32,
    pub y_max: f32,
    /// Index into the global `band_curve_indices` buffer.
    pub curve_start: u32,
    pub curve_count: u32,
}

/// One placed glyph (instance) in canvas pixels, 48 bytes / 16-byte aligned.
#[repr(C)]
#[derive(Debug, Clone, Copy, PartialEq, Pod, Zeroable)]
pub struct GpuPlacedGlyph {
    /// Index into the `glyph_metas` buffer.
    pub meta_index: u32,
    pub _pad0: [u32; 3],
    /// `[x, y, size_px, _unused]` — `x, y` is the glyph's origin in canvas
    /// pixels (top-left corner of the em-box for now); `size_px` is the
    /// rendered em size in pixels.
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
    pub curves: Vec<f32>,
    pub bands: Vec<GpuBand>,
    pub band_curve_indices: Vec<u32>,
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
        let curves_offset = self.curves.len() as u32;
        for q in &glyph.curves {
            self.curves
                .extend_from_slice(&[q.p0[0], q.p0[1], q.p1[0], q.p1[1], q.p2[0], q.p2[1]]);
        }
        let bands_offset = self.bands.len() as u32;
        for band in &glyph.bands {
            let curve_start = self.band_curve_indices.len() as u32;
            self.band_curve_indices.extend_from_slice(&band.curve_indices);
            self.bands.push(GpuBand {
                y_min: band.y_min,
                y_max: band.y_max,
                curve_start,
                curve_count: band.curve_indices.len() as u32,
            });
        }
        let bands_count = glyph.bands.len() as u32;
        let meta = GpuGlyphMeta {
            curves_offset,
            bands_offset,
            bands_count,
            _pad0: 0,
            em_bbox: [
                glyph.em_bbox.min[0],
                glyph.em_bbox.min[1],
                glyph.em_bbox.max[0],
                glyph.em_bbox.max[1],
            ],
            units_per_em: glyph.units_per_em as f32,
            _pad1: [0.0; 3],
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
        assert!(std::mem::size_of::<GpuGlyphMeta>() == 48);
        assert!(std::mem::size_of::<GpuBand>() == 16);
        assert!(std::mem::size_of::<GpuPlacedGlyph>() == 48);
        assert!(std::mem::align_of::<GpuGlyphMeta>() >= 4);
        assert!(std::mem::align_of::<GpuPlacedGlyph>() >= 4);
    };

    fn sample_glyph() -> GlyphCurves {
        // Two curves, one band that contains both.
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
        let bands = vec![GlyphBand {
            y_min: 0.0,
            y_max: 10.0,
            curve_indices: vec![0, 1],
        }];
        GlyphCurves {
            curves,
            bands,
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
        assert!(layout.bands.is_empty());
        assert!(layout.band_curve_indices.is_empty());
        assert!(layout.glyph_metas.is_empty());
        assert_eq!(layout.glyph_count(), 0);
    }

    #[test]
    fn add_glyph_appends_curves_bands_and_meta() {
        let mut layout = GlyphBufferLayout::new();
        let g = sample_glyph();
        let idx = layout.add_glyph(7, 42, &g);
        assert_eq!(idx, 0);

        // Curves: 2 curves × 6 floats = 12 floats.
        assert_eq!(layout.curves.len(), 2 * FLOATS_PER_CURVE);
        assert_eq!(&layout.curves[0..6], &[0.0, 0.0, 5.0, 10.0, 10.0, 0.0]);
        assert_eq!(&layout.curves[6..12], &[10.0, 0.0, 15.0, 5.0, 20.0, 0.0]);

        // One band containing two curves.
        assert_eq!(layout.bands.len(), 1);
        assert_eq!(layout.bands[0].y_min, 0.0);
        assert_eq!(layout.bands[0].y_max, 10.0);
        assert_eq!(layout.bands[0].curve_start, 0);
        assert_eq!(layout.bands[0].curve_count, 2);
        assert_eq!(layout.band_curve_indices, vec![0, 1]);

        // Meta points at the start.
        let meta = layout.glyph_metas[0];
        assert_eq!(meta.curves_offset, 0);
        assert_eq!(meta.bands_offset, 0);
        assert_eq!(meta.bands_count, 1);
        assert_eq!(meta.em_bbox, [0.0, 0.0, 20.0, 10.0]);
        assert_eq!(meta.units_per_em, 1000.0);
    }

    #[test]
    fn add_glyph_is_idempotent_on_font_glyph_pair() {
        let mut layout = GlyphBufferLayout::new();
        let g = sample_glyph();
        let a = layout.add_glyph(1, 5, &g);
        let curves_len = layout.curves.len();
        let bands_len = layout.bands.len();
        let metas_len = layout.glyph_metas.len();
        let b = layout.add_glyph(1, 5, &g);
        assert_eq!(a, b);
        assert_eq!(layout.curves.len(), curves_len);
        assert_eq!(layout.bands.len(), bands_len);
        assert_eq!(layout.glyph_metas.len(), metas_len);
    }

    #[test]
    fn add_glyph_distinct_pairs_get_separate_metas_with_correct_offsets() {
        let mut layout = GlyphBufferLayout::new();
        let g = sample_glyph();
        let i0 = layout.add_glyph(1, 5, &g);
        let i1 = layout.add_glyph(1, 6, &g);
        let i2 = layout.add_glyph(2, 5, &g); // same glyph_id, different font_id
        assert_eq!(i0, 0);
        assert_eq!(i1, 1);
        assert_eq!(i2, 2);
        assert_eq!(layout.glyph_metas[i1 as usize].curves_offset, FLOATS_PER_CURVE as u32 * 2);
        assert_eq!(layout.glyph_metas[i2 as usize].curves_offset, FLOATS_PER_CURVE as u32 * 4);
        assert_eq!(layout.glyph_metas[i1 as usize].bands_offset, 1);
        assert_eq!(layout.glyph_metas[i2 as usize].bands_offset, 2);
    }

    #[test]
    fn glyph_with_no_outline_records_zero_curves_and_bands() {
        let mut layout = GlyphBufferLayout::new();
        let empty = GlyphCurves {
            curves: vec![],
            bands: vec![],
            em_bbox: Rect::ZERO,
            advance: 250.0,
            units_per_em: 1000,
        };
        let idx = layout.add_glyph(1, 0, &empty);
        assert_eq!(idx, 0);
        assert!(layout.curves.is_empty());
        assert!(layout.bands.is_empty());
        let meta = layout.glyph_metas[0];
        assert_eq!(meta.bands_count, 0);
        assert_eq!(meta.curves_offset, 0);
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
    fn band_curve_indices_are_remapped_to_global_indices() {
        // Two glyphs with overlapping local indices [0, 1] each. Verify
        // band_curve_indices stores them at distinct global slices.
        let mut layout = GlyphBufferLayout::new();
        let g = sample_glyph(); // band points to local indices [0, 1]
        layout.add_glyph(1, 5, &g);
        layout.add_glyph(1, 6, &g);
        // Band 0 of glyph 0 → indices [0, 1] at offset 0.
        // Band 0 of glyph 1 → indices [0, 1] at offset 2.
        assert_eq!(layout.band_curve_indices, vec![0, 1, 0, 1]);
        assert_eq!(layout.bands[0].curve_start, 0);
        assert_eq!(layout.bands[0].curve_count, 2);
        assert_eq!(layout.bands[1].curve_start, 2);
        assert_eq!(layout.bands[1].curve_count, 2);
    }

    #[test]
    fn buffers_are_pod_castable_to_bytes() {
        let mut layout = GlyphBufferLayout::new();
        layout.add_glyph(1, 5, &sample_glyph());
        // bytemuck round-trip — proves all derives line up and the structs
        // are safely Pod for upload via wgpu::Queue::write_buffer.
        let _curves_bytes: &[u8] = bytemuck::cast_slice(&layout.curves);
        let _band_bytes: &[u8] = bytemuck::cast_slice(&layout.bands);
        let _idx_bytes: &[u8] = bytemuck::cast_slice(&layout.band_curve_indices);
        let _meta_bytes: &[u8] = bytemuck::cast_slice(&layout.glyph_metas);
    }
}
