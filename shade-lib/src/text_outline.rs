//! Glyph outline extraction in em-units.
//!
//! Loads a TTF/OTF blob via `ttf-parser`, walks the outline of a single
//! glyph, and produces a flat list of quadratic Bézier segments plus a
//! horizontal band acceleration index. This is the per-glyph geometry that
//! the GPU rasterizer (Slug-style direct curve rendering) consumes.
//!
//! Lines are widened to degenerate quadratics with the control point at the
//! chord midpoint so the shader's root finder uses one code path. Cubic
//! Béziers (CFF / `.otf`) are recursively subdivided into quadratics under
//! a fixed em-units error tolerance.

use anyhow::{anyhow, Result};
use ttf_parser::{Face, GlyphId, OutlineBuilder};

/// A 2D point in font em-units (Y-up, native TrueType orientation).
pub type Point2 = [f32; 2];

/// A quadratic Bézier segment in em-units.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct QuadBezier {
    pub p0: Point2,
    pub p1: Point2,
    pub p2: Point2,
}

/// Axis-aligned rectangle in em-units.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Rect {
    pub min: Point2,
    pub max: Point2,
}

impl Rect {
    pub const ZERO: Self = Self {
        min: [0.0, 0.0],
        max: [0.0, 0.0],
    };

    pub fn width(&self) -> f32 {
        self.max[0] - self.min[0]
    }

    pub fn height(&self) -> f32 {
        self.max[1] - self.min[1]
    }
}

/// One horizontal strip of a glyph's bounding box, listing the indices of
/// curves whose y-extent overlaps the strip.
#[derive(Debug, Clone, PartialEq)]
pub struct GlyphBand {
    pub y_min: f32,
    pub y_max: f32,
    pub curve_indices: Vec<u32>,
}

/// Per-glyph geometry consumed by the GPU rasterizer.
#[derive(Debug, Clone)]
pub struct GlyphCurves {
    pub curves: Vec<QuadBezier>,
    pub bands: Vec<GlyphBand>,
    pub em_bbox: Rect,
    pub advance: f32,
    pub units_per_em: u16,
}

/// Default number of horizontal bands per glyph.
pub const DEFAULT_BANDS: usize = 16;

/// Maximum em-units error accepted when approximating a cubic with a single
/// quadratic before subdividing.
const CUBIC_TO_QUAD_MAX_ERROR: f32 = 1.0;
/// Defensive cap on subdivision recursion to bound worst-case glyph size.
const CUBIC_TO_QUAD_MAX_DEPTH: u32 = 10;

/// Implements [`ttf_parser::OutlineBuilder`] and produces a flat curve list.
struct OutlineCollector {
    curves: Vec<QuadBezier>,
    current: Point2,
    contour_start: Point2,
}

impl OutlineCollector {
    fn new() -> Self {
        Self {
            curves: Vec::new(),
            current: [0.0, 0.0],
            contour_start: [0.0, 0.0],
        }
    }

    fn line(&mut self, end: Point2) {
        let mid = [
            (self.current[0] + end[0]) * 0.5,
            (self.current[1] + end[1]) * 0.5,
        ];
        self.curves.push(QuadBezier {
            p0: self.current,
            p1: mid,
            p2: end,
        });
        self.current = end;
    }

    fn quad(&mut self, ctrl: Point2, end: Point2) {
        self.curves.push(QuadBezier {
            p0: self.current,
            p1: ctrl,
            p2: end,
        });
        self.current = end;
    }

    fn cubic(&mut self, c1: Point2, c2: Point2, end: Point2) {
        let p0 = self.current;
        cubic_to_quads(
            p0,
            c1,
            c2,
            end,
            CUBIC_TO_QUAD_MAX_ERROR,
            0,
            &mut self.curves,
        );
        self.current = end;
    }
}

impl OutlineBuilder for OutlineCollector {
    fn move_to(&mut self, x: f32, y: f32) {
        self.current = [x, y];
        self.contour_start = [x, y];
    }
    fn line_to(&mut self, x: f32, y: f32) {
        self.line([x, y]);
    }
    fn quad_to(&mut self, x1: f32, y1: f32, x: f32, y: f32) {
        self.quad([x1, y1], [x, y]);
    }
    fn curve_to(&mut self, x1: f32, y1: f32, x2: f32, y2: f32, x: f32, y: f32) {
        self.cubic([x1, y1], [x2, y2], [x, y]);
    }
    fn close(&mut self) {
        if self.current != self.contour_start {
            self.line(self.contour_start);
        }
    }
}

/// Recursive cubic→quadratic subdivision via de Casteljau at t = 0.5.
fn cubic_to_quads(
    p0: Point2,
    c1: Point2,
    c2: Point2,
    p3: Point2,
    max_err: f32,
    depth: u32,
    out: &mut Vec<QuadBezier>,
) {
    // Single-quadratic fit: q = (3*c1 + 3*c2 - p0 - p3) / 4.
    let q = [
        (3.0 * (c1[0] + c2[0]) - p0[0] - p3[0]) * 0.25,
        (3.0 * (c1[1] + c2[1]) - p0[1] - p3[1]) * 0.25,
    ];
    // Closed-form upper bound on max deviation between the cubic and this
    // quadratic approximation (Sederberg, *Computer-Aided Geometric Design*):
    //     err = (sqrt(3) / 36) · |p3 - 3*c2 + 3*c1 - p0|
    // Robust for S-curves where midpoints coincide despite high curvature.
    const K: f32 = 0.048_112_52; // sqrt(3) / 36
    let dx = p3[0] - 3.0 * c2[0] + 3.0 * c1[0] - p0[0];
    let dy = p3[1] - 3.0 * c2[1] + 3.0 * c1[1] - p0[1];
    let err = K * (dx * dx + dy * dy).sqrt();

    if err <= max_err || depth >= CUBIC_TO_QUAD_MAX_DEPTH {
        out.push(QuadBezier {
            p0,
            p1: q,
            p2: p3,
        });
        return;
    }
    let p01 = midpoint(p0, c1);
    let p12 = midpoint(c1, c2);
    let p23 = midpoint(c2, p3);
    let p012 = midpoint(p01, p12);
    let p123 = midpoint(p12, p23);
    let p0123 = midpoint(p012, p123);
    cubic_to_quads(p0, p01, p012, p0123, max_err, depth + 1, out);
    cubic_to_quads(p0123, p123, p23, p3, max_err, depth + 1, out);
}

fn midpoint(a: Point2, b: Point2) -> Point2 {
    [(a[0] + b[0]) * 0.5, (a[1] + b[1]) * 0.5]
}

/// Inclusive y-range of a quadratic Bézier on t ∈ [0, 1].
fn quad_y_extent(q: &QuadBezier) -> (f32, f32) {
    let mut y_min = q.p0[1].min(q.p2[1]);
    let mut y_max = q.p0[1].max(q.p2[1]);
    // Interior extremum: y'(t) = 0 ⇒ t = (p0 - p1) / (p0 - 2*p1 + p2).
    let denom = q.p0[1] - 2.0 * q.p1[1] + q.p2[1];
    if denom.abs() > f32::EPSILON {
        let t = (q.p0[1] - q.p1[1]) / denom;
        if t > 0.0 && t < 1.0 {
            let mt = 1.0 - t;
            let y_t = mt * mt * q.p0[1] + 2.0 * mt * t * q.p1[1] + t * t * q.p2[1];
            y_min = y_min.min(y_t);
            y_max = y_max.max(y_t);
        }
    }
    (y_min, y_max)
}

/// Partition `bbox` vertically into `num_bands` equal strips and assign each
/// curve index to every strip its y-extent overlaps.
pub fn build_bands(curves: &[QuadBezier], num_bands: usize, bbox: Rect) -> Vec<GlyphBand> {
    assert!(num_bands >= 1, "num_bands must be at least 1");
    let height = (bbox.max[1] - bbox.min[1]).max(f32::EPSILON);
    let band_h = height / num_bands as f32;
    let mut bands: Vec<GlyphBand> = (0..num_bands)
        .map(|i| GlyphBand {
            y_min: bbox.min[1] + band_h * i as f32,
            y_max: bbox.min[1] + band_h * (i + 1) as f32,
            curve_indices: Vec::new(),
        })
        .collect();
    for (idx, q) in curves.iter().enumerate() {
        let (y0, y1) = quad_y_extent(q);
        for band in &mut bands {
            if y1 >= band.y_min && y0 <= band.y_max {
                band.curve_indices.push(idx as u32);
            }
        }
    }
    bands
}

/// Extract a single glyph's outline from an OTF/TTF blob in em-units.
///
/// `num_bands` controls band-acceleration granularity; pass [`DEFAULT_BANDS`]
/// if unsure. Returns an empty `GlyphCurves` (no curves, no bands) for glyphs
/// without outlines (whitespace, control codes), preserving advance width.
pub fn outline_glyph(blob: &[u8], glyph_id: u16, num_bands: usize) -> Result<GlyphCurves> {
    let face = Face::parse(blob, 0)
        .map_err(|e| anyhow!("ttf-parser face parse failed: {e:?}"))?;
    let units_per_em = face.units_per_em();
    let advance = face
        .glyph_hor_advance(GlyphId(glyph_id))
        .map(|a| a as f32)
        .unwrap_or(0.0);

    let mut collector = OutlineCollector::new();
    let bbox_opt = face.outline_glyph(GlyphId(glyph_id), &mut collector);

    let em_bbox = match bbox_opt {
        Some(b) => Rect {
            min: [b.x_min as f32, b.y_min as f32],
            max: [b.x_max as f32, b.y_max as f32],
        },
        None => Rect::ZERO,
    };

    let bands = if collector.curves.is_empty() {
        Vec::new()
    } else {
        build_bands(&collector.curves, num_bands.max(1), em_bbox)
    };

    Ok(GlyphCurves {
        curves: collector.curves,
        bands,
        em_bbox,
        advance,
        units_per_em,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn approx_eq(a: f32, b: f32, eps: f32) -> bool {
        (a - b).abs() <= eps
    }

    // ── OutlineCollector behaviour ──────────────────────────────────────

    #[test]
    fn line_to_widens_to_degenerate_quad_with_midpoint_control() {
        let mut c = OutlineCollector::new();
        c.move_to(0.0, 0.0);
        c.line_to(10.0, 0.0);
        assert_eq!(c.curves.len(), 1);
        let q = c.curves[0];
        assert_eq!(q.p0, [0.0, 0.0]);
        assert_eq!(q.p1, [5.0, 0.0]);
        assert_eq!(q.p2, [10.0, 0.0]);
    }

    #[test]
    fn quad_to_passes_through_control_unchanged() {
        let mut c = OutlineCollector::new();
        c.move_to(0.0, 0.0);
        c.quad_to(5.0, 10.0, 10.0, 0.0);
        assert_eq!(c.curves.len(), 1);
        assert_eq!(c.curves[0].p1, [5.0, 10.0]);
    }

    #[test]
    fn close_path_emits_segment_back_to_contour_start() {
        let mut c = OutlineCollector::new();
        c.move_to(0.0, 0.0);
        c.line_to(10.0, 0.0);
        c.line_to(10.0, 10.0);
        c.close();
        // 3 segments: line + line + closing line back to (0,0).
        assert_eq!(c.curves.len(), 3);
        let last = c.curves.last().unwrap();
        assert_eq!(last.p0, [10.0, 10.0]);
        assert_eq!(last.p2, [0.0, 0.0]);
    }

    #[test]
    fn close_is_noop_when_already_at_contour_start() {
        let mut c = OutlineCollector::new();
        c.move_to(0.0, 0.0);
        c.line_to(10.0, 0.0);
        c.line_to(0.0, 0.0); // already returned manually
        c.close();
        assert_eq!(c.curves.len(), 2, "close must not add a redundant segment");
    }

    #[test]
    fn move_to_resets_current_without_emitting_segment() {
        let mut c = OutlineCollector::new();
        c.move_to(5.0, 5.0);
        c.move_to(10.0, 10.0);
        assert!(c.curves.is_empty());
        assert_eq!(c.current, [10.0, 10.0]);
        assert_eq!(c.contour_start, [10.0, 10.0]);
    }

    // ── cubic_to_quads subdivision ───────────────────────────────────────

    #[test]
    fn cubic_that_is_already_quadratic_yields_one_segment() {
        // Pick c1 == c2 == midpoint of p0 and p3, lifted in y → exact quadratic.
        let p0 = [0.0, 0.0];
        let c1 = [5.0, 5.0];
        let c2 = [5.0, 5.0];
        let p3 = [10.0, 0.0];
        let mut out = Vec::new();
        cubic_to_quads(p0, c1, c2, p3, CUBIC_TO_QUAD_MAX_ERROR, 0, &mut out);
        assert_eq!(out.len(), 1, "expected single quadratic, got {out:?}");
    }

    #[test]
    fn cubic_with_high_curvature_subdivides() {
        // S-curve cubic that no single quadratic can match well.
        let p0 = [0.0, 0.0];
        let c1 = [100.0, 100.0];
        let c2 = [-100.0, 100.0];
        let p3 = [100.0, 0.0];
        let mut out = Vec::new();
        cubic_to_quads(p0, c1, c2, p3, 0.5, 0, &mut out);
        assert!(
            out.len() > 1,
            "high-curvature cubic should subdivide, got {} curves",
            out.len()
        );
        // Endpoints must match the original cubic.
        assert_eq!(out.first().unwrap().p0, p0);
        assert_eq!(out.last().unwrap().p2, p3);
        // Adjacent segments must share endpoints (path continuity).
        for w in out.windows(2) {
            assert_eq!(w[0].p2, w[1].p0);
        }
    }

    #[test]
    fn cubic_to_quads_respects_max_depth() {
        // Pathological cubic — but capped depth must still terminate.
        let p0 = [0.0, 0.0];
        let c1 = [1e6, 1e6];
        let c2 = [-1e6, 1e6];
        let p3 = [1e6, 0.0];
        let mut out = Vec::new();
        cubic_to_quads(p0, c1, c2, p3, 0.0001, 0, &mut out);
        // Depth cap is 10 → at most 2^10 = 1024 segments.
        assert!(out.len() <= 1024);
        assert!(!out.is_empty());
    }

    // ── y-extent solver ──────────────────────────────────────────────────

    #[test]
    fn quad_y_extent_returns_endpoints_for_monotone_quad() {
        let q = QuadBezier {
            p0: [0.0, 0.0],
            p1: [5.0, 5.0],
            p2: [10.0, 10.0],
        };
        let (lo, hi) = quad_y_extent(&q);
        assert!(approx_eq(lo, 0.0, 1e-5));
        assert!(approx_eq(hi, 10.0, 1e-5));
    }

    #[test]
    fn quad_y_extent_finds_interior_apex() {
        // Symmetric arch: apex at t = 0.5 → y(0.5) = 0.25*0 + 0.5*10 + 0.25*0 = 5
        let q = QuadBezier {
            p0: [0.0, 0.0],
            p1: [5.0, 10.0],
            p2: [10.0, 0.0],
        };
        let (lo, hi) = quad_y_extent(&q);
        assert!(approx_eq(lo, 0.0, 1e-5));
        assert!(approx_eq(hi, 5.0, 1e-5));
    }

    #[test]
    fn quad_y_extent_finds_interior_minimum() {
        // Inverted arch: minimum at t = 0.5 → y(0.5) = -5
        let q = QuadBezier {
            p0: [0.0, 0.0],
            p1: [5.0, -10.0],
            p2: [10.0, 0.0],
        };
        let (lo, hi) = quad_y_extent(&q);
        assert!(approx_eq(lo, -5.0, 1e-5));
        assert!(approx_eq(hi, 0.0, 1e-5));
    }

    // ── build_bands ──────────────────────────────────────────────────────

    #[test]
    fn build_bands_partitions_bbox_into_equal_strips() {
        let bbox = Rect {
            min: [0.0, 0.0],
            max: [10.0, 100.0],
        };
        let bands = build_bands(&[], 4, bbox);
        assert_eq!(bands.len(), 4);
        assert!(approx_eq(bands[0].y_min, 0.0, 1e-5));
        assert!(approx_eq(bands[0].y_max, 25.0, 1e-5));
        assert!(approx_eq(bands[3].y_max, 100.0, 1e-5));
    }

    #[test]
    fn build_bands_assigns_curve_only_to_overlapping_bands() {
        let curves = vec![QuadBezier {
            p0: [0.0, 10.0],
            p1: [5.0, 12.0],
            p2: [10.0, 14.0],
        }];
        let bbox = Rect {
            min: [0.0, 0.0],
            max: [10.0, 100.0],
        };
        let bands = build_bands(&curves, 4, bbox);
        // Curve sits in y ∈ [10, 14] → only band 0 (y ∈ [0, 25]).
        assert_eq!(bands[0].curve_indices, vec![0]);
        assert!(bands[1].curve_indices.is_empty());
        assert!(bands[2].curve_indices.is_empty());
        assert!(bands[3].curve_indices.is_empty());
    }

    #[test]
    fn build_bands_replicates_curves_across_multiple_overlapping_bands() {
        let curves = vec![QuadBezier {
            p0: [0.0, 0.0],
            p1: [5.0, 100.0],
            p2: [10.0, 0.0],
        }];
        let bbox = Rect {
            min: [0.0, 0.0],
            max: [10.0, 100.0],
        };
        // y(t) = 200·t·(1-t), peak at t=0.5 → 50. Bands of height 25:
        // [0,25] [25,50] [50,75] [75,100]. Curve y-range is [0, 50] →
        // overlaps bands 0, 1, 2 (band 2 by inclusive y_min boundary).
        let bands = build_bands(&curves, 4, bbox);
        assert_eq!(bands[0].curve_indices, vec![0]);
        assert_eq!(bands[1].curve_indices, vec![0]);
        assert_eq!(bands[2].curve_indices, vec![0]);
        assert!(bands[3].curve_indices.is_empty());
    }

    #[test]
    fn build_bands_includes_curves_with_apex_above_endpoints() {
        // Curve endpoints in band 0 only, but apex reaches into band 1.
        // Without the y-extent solver this would miss band 1.
        let curves = vec![QuadBezier {
            p0: [0.0, 5.0],
            p1: [5.0, 30.0],
            p2: [10.0, 5.0],
        }];
        let bbox = Rect {
            min: [0.0, 0.0],
            max: [10.0, 40.0],
        };
        let bands = build_bands(&curves, 4, bbox); // bands of height 10
        assert!(bands[0].curve_indices.contains(&0), "endpoint band");
        assert!(
            bands[1].curve_indices.contains(&0),
            "apex band must be detected via interior extremum solve"
        );
        assert!(!bands[2].curve_indices.contains(&0));
    }

    // ── Surface API smoke ────────────────────────────────────────────────

    #[test]
    fn outline_glyph_rejects_invalid_blob() {
        let err = outline_glyph(b"not a font", 0, DEFAULT_BANDS).unwrap_err();
        let msg = format!("{err}");
        assert!(msg.contains("ttf-parser"), "unexpected error: {msg}");
    }
}
