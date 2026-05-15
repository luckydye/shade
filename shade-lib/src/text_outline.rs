//! Glyph outline extraction in em-units, organized for Slug-style GPU rendering.
//!
//! Loads a TTF/OTF blob via `ttf-parser`, walks the outline of a single
//! glyph, and produces a flat list of quadratic Bézier segments plus the
//! two-axis band acceleration index used by the Slug pixel shader.
//!
//! Each glyph carries:
//!
//! - `curves`: quadratic Béziers in em-units (Y-up, native TrueType).
//! - `h_bands`: horizontal strips of the em bbox; for each strip, the indices
//!   of curves whose y-extent overlaps it, **sorted by descending max-x** so
//!   the fragment shader's left-of-pixel early-exit is valid.
//! - `v_bands`: same for vertical strips, sorted by descending max-y.
//! - `band_transform`: `(scale_x, scale_y, offset_x, offset_y)` such that
//!   for an em-space sample coordinate `(x, y)`,
//!     `v_band_index = clamp(floor(x · scale_x + offset_x), 0, band_max_x)`
//!     `h_band_index = clamp(floor(y · scale_y + offset_y), 0, band_max_y)`
//!   — matching the Slug pixel shader's `coord · bandTransform.xy + bandTransform.zw`
//!   formulation directly.
//!
//! Lines are widened to degenerate quadratics with the control point at the
//! chord midpoint so the GPU root finder uses a single code path. Cubic
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

/// One axis-aligned strip in a glyph's bbox.
///
/// Curve indices are sorted by descending max-coord on the band's
/// **perpendicular** axis: H bands sort by descending max-x, V bands by
/// descending max-y. The order enables the fragment shader's early-out.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct GlyphBand {
    pub curve_indices: Vec<u32>,
}

/// Per-glyph geometry consumed by the GPU rasterizer.
#[derive(Debug, Clone)]
pub struct GlyphCurves {
    pub curves: Vec<QuadBezier>,
    pub h_bands: Vec<GlyphBand>,
    pub v_bands: Vec<GlyphBand>,
    /// `(scale_x, scale_y, offset_x, offset_y)` — see module docs.
    pub band_transform: [f32; 4],
    pub em_bbox: Rect,
    pub advance: f32,
    pub units_per_em: u16,
}

/// Default number of bands per axis. 16 is the standard Slug-paper value.
pub const DEFAULT_BANDS_PER_AXIS: usize = 16;

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
#[cfg(test)]
fn quad_y_extent(q: &QuadBezier) -> (f32, f32) {
    quad_axis_extent(q, Axis::Y)
}

/// Inclusive x-range of a quadratic Bézier on t ∈ [0, 1].
#[cfg(test)]
fn quad_x_extent(q: &QuadBezier) -> (f32, f32) {
    quad_axis_extent(q, Axis::X)
}

#[derive(Clone, Copy)]
enum Axis {
    X = 0,
    Y = 1,
}

fn quad_axis_extent(q: &QuadBezier, axis: Axis) -> (f32, f32) {
    let i = axis as usize;
    let mut lo = q.p0[i].min(q.p2[i]);
    let mut hi = q.p0[i].max(q.p2[i]);
    // Interior extremum: d/dt = 0 ⇒ t = (p0 - p1) / (p0 - 2*p1 + p2).
    let denom = q.p0[i] - 2.0 * q.p1[i] + q.p2[i];
    if denom.abs() > f32::EPSILON {
        let t = (q.p0[i] - q.p1[i]) / denom;
        if t > 0.0 && t < 1.0 {
            let mt = 1.0 - t;
            let v = mt * mt * q.p0[i] + 2.0 * mt * t * q.p1[i] + t * t * q.p2[i];
            lo = lo.min(v);
            hi = hi.max(v);
        }
    }
    (lo, hi)
}

/// Build the H-band index for a glyph: `num_bands` uniform horizontal strips
/// covering `bbox`'s y range. Returns `(bands, scale_y, offset_y)` such that
/// `h_band_index = clamp(floor(y · scale_y + offset_y), 0, num_bands - 1)`.
///
/// Curves within each band are sorted by descending max-x.
pub fn build_h_bands(
    curves: &[QuadBezier],
    num_bands: usize,
    bbox: Rect,
) -> (Vec<GlyphBand>, f32, f32) {
    build_axis_bands(curves, num_bands, bbox, Axis::Y)
}

/// Build the V-band index. Returns `(bands, scale_x, offset_x)`.
/// Curves within each band are sorted by descending max-y.
pub fn build_v_bands(
    curves: &[QuadBezier],
    num_bands: usize,
    bbox: Rect,
) -> (Vec<GlyphBand>, f32, f32) {
    build_axis_bands(curves, num_bands, bbox, Axis::X)
}

fn build_axis_bands(
    curves: &[QuadBezier],
    num_bands: usize,
    bbox: Rect,
    axis: Axis,
) -> (Vec<GlyphBand>, f32, f32) {
    assert!(num_bands >= 1, "num_bands must be at least 1");
    let i = axis as usize;
    let span = (bbox.max[i] - bbox.min[i]).max(f32::EPSILON);
    let scale = num_bands as f32 / span;
    let offset = -bbox.min[i] * scale;
    let max_idx = (num_bands - 1) as i32;

    let mut bands: Vec<GlyphBand> = (0..num_bands)
        .map(|_| GlyphBand::default())
        .collect();

    for (idx, q) in curves.iter().enumerate() {
        let (lo, hi) = quad_axis_extent(q, axis);
        let i0 = ((lo * scale + offset).floor() as i32)
            .max(0)
            .min(max_idx) as usize;
        let i1 = ((hi * scale + offset).floor() as i32)
            .max(0)
            .min(max_idx) as usize;
        for slot in i0..=i1 {
            bands[slot].curve_indices.push(idx as u32);
        }
    }

    // Sort descending by perpendicular-axis max: H bands by max-x, V by max-y.
    let perp = match axis {
        Axis::Y => Axis::X,
        Axis::X => Axis::Y,
    };
    for band in &mut bands {
        band.curve_indices.sort_by(|&a, &b| {
            let ma = quad_axis_extent(&curves[a as usize], perp).1;
            let mb = quad_axis_extent(&curves[b as usize], perp).1;
            mb.partial_cmp(&ma).unwrap_or(std::cmp::Ordering::Equal)
        });
    }

    (bands, scale, offset)
}

/// Extract a single glyph's outline from an OTF/TTF blob in em-units.
///
/// `num_h_bands` and `num_v_bands` control the per-axis granularity; pass
/// [`DEFAULT_BANDS_PER_AXIS`] for both if unsure. Returns an empty
/// `GlyphCurves` (no curves, no bands) for glyphs without outlines
/// (whitespace, control codes), preserving advance width.
pub fn outline_glyph(
    blob: &[u8],
    glyph_id: u16,
    num_h_bands: usize,
    num_v_bands: usize,
) -> Result<GlyphCurves> {
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

    if collector.curves.is_empty() {
        return Ok(GlyphCurves {
            curves: collector.curves,
            h_bands: Vec::new(),
            v_bands: Vec::new(),
            band_transform: [0.0; 4],
            em_bbox,
            advance,
            units_per_em,
        });
    }

    let (h_bands, scale_y, offset_y) =
        build_h_bands(&collector.curves, num_h_bands.max(1), em_bbox);
    let (v_bands, scale_x, offset_x) =
        build_v_bands(&collector.curves, num_v_bands.max(1), em_bbox);

    Ok(GlyphCurves {
        curves: collector.curves,
        h_bands,
        v_bands,
        band_transform: [scale_x, scale_y, offset_x, offset_y],
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
        c.line_to(0.0, 0.0);
        c.close();
        assert_eq!(c.curves.len(), 2);
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
        let mut out = Vec::new();
        cubic_to_quads(
            [0.0, 0.0],
            [5.0, 5.0],
            [5.0, 5.0],
            [10.0, 0.0],
            CUBIC_TO_QUAD_MAX_ERROR,
            0,
            &mut out,
        );
        assert_eq!(out.len(), 1);
    }

    #[test]
    fn cubic_with_high_curvature_subdivides() {
        let mut out = Vec::new();
        cubic_to_quads(
            [0.0, 0.0],
            [100.0, 100.0],
            [-100.0, 100.0],
            [100.0, 0.0],
            0.5,
            0,
            &mut out,
        );
        assert!(out.len() > 1);
        assert_eq!(out.first().unwrap().p0, [0.0, 0.0]);
        assert_eq!(out.last().unwrap().p2, [100.0, 0.0]);
        for w in out.windows(2) {
            assert_eq!(w[0].p2, w[1].p0);
        }
    }

    #[test]
    fn cubic_to_quads_respects_max_depth() {
        let mut out = Vec::new();
        cubic_to_quads(
            [0.0, 0.0],
            [1e6, 1e6],
            [-1e6, 1e6],
            [1e6, 0.0],
            0.0001,
            0,
            &mut out,
        );
        assert!(out.len() <= 1024);
        assert!(!out.is_empty());
    }

    // ── y- and x-extent solver ───────────────────────────────────────────

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
    fn quad_x_extent_finds_interior_apex() {
        let q = QuadBezier {
            p0: [0.0, 0.0],
            p1: [10.0, 5.0],
            p2: [0.0, 10.0],
        };
        let (lo, hi) = quad_x_extent(&q);
        assert!(approx_eq(lo, 0.0, 1e-5));
        assert!(approx_eq(hi, 5.0, 1e-5));
    }

    // ── Two-axis band index ─────────────────────────────────────────────

    fn unit_bbox() -> Rect {
        Rect {
            min: [0.0, 0.0],
            max: [100.0, 100.0],
        }
    }

    #[test]
    fn build_h_bands_transform_matches_shader_formula() {
        let bbox = unit_bbox();
        let (_bands, scale_y, offset_y) = build_h_bands(&[], 4, bbox);
        // 4 bands over [0, 100] → scale = 0.04, offset = 0.
        assert!(approx_eq(scale_y, 0.04, 1e-6));
        assert!(approx_eq(offset_y, 0.0, 1e-6));
        // y = 30 → band 1 (range [25, 50)).
        let idx = (30.0 * scale_y + offset_y).floor() as i32;
        assert_eq!(idx, 1);
        // y = 99.99 → band 3.
        let idx = (99.99 * scale_y + offset_y).floor() as i32;
        assert_eq!(idx, 3);
    }

    #[test]
    fn build_h_bands_assigns_each_curve_to_overlapping_strips_only() {
        let curves = vec![QuadBezier {
            p0: [0.0, 10.0],
            p1: [50.0, 12.0],
            p2: [100.0, 14.0],
        }];
        let bbox = unit_bbox();
        let (bands, _, _) = build_h_bands(&curves, 4, bbox);
        // Curve y ∈ [10, 14] → only band 0 (y ∈ [0, 25)).
        assert_eq!(bands[0].curve_indices, vec![0]);
        assert!(bands[1].curve_indices.is_empty());
        assert!(bands[2].curve_indices.is_empty());
        assert!(bands[3].curve_indices.is_empty());
    }

    #[test]
    fn build_h_bands_finds_apex_overlap_via_extent_solver() {
        // Endpoints in band 0 only (y=5), but apex reaches into band 1.
        // y(0.5) = 0.25·5 + 0.5·55 + 0.25·5 = 30 → band 1 (y ∈ [25, 50)).
        let curves = vec![QuadBezier {
            p0: [0.0, 5.0],
            p1: [50.0, 55.0],
            p2: [100.0, 5.0],
        }];
        let bbox = unit_bbox();
        let (bands, _, _) = build_h_bands(&curves, 4, bbox);
        assert!(bands[0].curve_indices.contains(&0));
        assert!(bands[1].curve_indices.contains(&0));
        assert!(!bands[2].curve_indices.contains(&0));
    }

    #[test]
    fn build_h_bands_sorts_by_descending_max_x() {
        // Three curves all sit in band 0 (y ∈ [0, 5]), differing by max-x.
        let curves = vec![
            QuadBezier {
                p0: [10.0, 1.0],
                p1: [11.0, 1.0],
                p2: [12.0, 1.0],
            }, // max-x = 12
            QuadBezier {
                p0: [80.0, 1.0],
                p1: [85.0, 1.0],
                p2: [90.0, 1.0],
            }, // max-x = 90
            QuadBezier {
                p0: [40.0, 1.0],
                p1: [45.0, 1.0],
                p2: [50.0, 1.0],
            }, // max-x = 50
        ];
        let bbox = unit_bbox();
        let (bands, _, _) = build_h_bands(&curves, 4, bbox);
        // Sorted descending by max-x: 1 (90), 2 (50), 0 (12).
        assert_eq!(bands[0].curve_indices, vec![1, 2, 0]);
    }

    #[test]
    fn build_v_bands_sorts_by_descending_max_y() {
        let curves = vec![
            QuadBezier {
                p0: [1.0, 10.0],
                p1: [1.0, 11.0],
                p2: [1.0, 12.0],
            },
            QuadBezier {
                p0: [1.0, 80.0],
                p1: [1.0, 85.0],
                p2: [1.0, 90.0],
            },
            QuadBezier {
                p0: [1.0, 40.0],
                p1: [1.0, 45.0],
                p2: [1.0, 50.0],
            },
        ];
        let bbox = unit_bbox();
        let (bands, _, _) = build_v_bands(&curves, 4, bbox);
        // Sorted descending by max-y: 1 (90), 2 (50), 0 (12).
        assert_eq!(bands[0].curve_indices, vec![1, 2, 0]);
    }

    // ── Surface API smoke ────────────────────────────────────────────────

    #[test]
    fn outline_glyph_rejects_invalid_blob() {
        let err = outline_glyph(b"not a font", 0, 16, 16).unwrap_err();
        assert!(format!("{err}").contains("ttf-parser"));
    }
}
