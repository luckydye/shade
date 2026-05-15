// WGSL port of EricLengyel/Slug reference shaders (MIT). Renders text directly
// from quadratic Bézier outlines on the GPU; no atlas, no SDF — analytic
// coverage per pixel via root-finding plus dual-axis band acceleration.
//
// Patent: US 10,373,352 was permanently dedicated to the public domain on
// 2026-03-17 (see https://terathon.com/blog/decade-slug.html). Reference
// shaders re-licensed MIT/Apache-2.0 at github.com/EricLengyel/Slug.
//
// This port substitutes the original 2D textures for storage buffers so all
// data lives in one bind group, matching shade's compute-first conventions.

struct GpuGlyphMeta {
    curves_offset: u32,
    band_headers_offset: u32,
    band_max_x: u32,
    band_max_y: u32,
    band_transform: vec4<f32>,
    em_bbox: vec4<f32>,
    units_per_em: f32,
    _pad0: f32,
    _pad1: f32,
    _pad2: f32,
};

struct GpuBandHeader {
    curve_count: u32,
    curves_offset: u32,
};

struct GpuPlacedGlyph {
    meta_index: u32,
    _pad0: u32,
    _pad1: u32,
    _pad2: u32,
    xy_size: vec4<f32>,
    color: vec4<f32>,
};

struct ViewUniform {
    target_size: vec2<f32>,
    _pad: vec2<f32>,
};

@group(0) @binding(0) var<storage, read> curves: array<f32>;
@group(0) @binding(1) var<storage, read> band_headers: array<GpuBandHeader>;
@group(0) @binding(2) var<storage, read> band_curves_idx: array<u32>;
@group(0) @binding(3) var<storage, read> glyph_metas: array<GpuGlyphMeta>;
@group(0) @binding(4) var<storage, read> instances: array<GpuPlacedGlyph>;
@group(0) @binding(5) var<uniform> view: ViewUniform;

struct VertexOut {
    @builtin(position) clip_pos: vec4<f32>,
    @location(0) em_coord: vec2<f32>,
    @location(1) @interpolate(flat) meta_index: u32,
    @location(2) @interpolate(flat) color: vec4<f32>,
};

// ── Vertex shader ──────────────────────────────────────────────────────────
//
// One instance per placed glyph; six vertices per instance form a screen-space
// quad covering the glyph's em bbox plus a half-pixel margin so the fragment
// shader's analytic-AA footprint never falls outside the rasterized fragments.
// (The reference Slug shader does proper anisotropic dilation along the vertex
// normal; that's a v1.1 follow-up — without it, glyph silhouettes under heavy
// transforms can show ≤1-pixel cracks.)
@vertex
fn vs_main(@builtin(vertex_index) vid: u32, @builtin(instance_index) iid: u32) -> VertexOut {
    let inst = instances[iid];
    let gmeta = glyph_metas[inst.meta_index];

    let pen = inst.xy_size.xy;
    let size_px = inst.xy_size.z;
    let scale_em_to_px = size_px / gmeta.units_per_em;

    // Half-pixel margin in em-units, padding the quad outward so AA samples
    // at the glyph silhouette fall inside the rasterized region.
    let em_margin = 0.5 / scale_em_to_px;
    let em_min = gmeta.em_bbox.xy - vec2<f32>(em_margin, em_margin);
    let em_max = gmeta.em_bbox.zw + vec2<f32>(em_margin, em_margin);

    // Two CCW triangles forming a unit-square quad.
    var corners = array<vec2<f32>, 6>(
        vec2<f32>(0.0, 0.0), vec2<f32>(1.0, 0.0), vec2<f32>(1.0, 1.0),
        vec2<f32>(0.0, 0.0), vec2<f32>(1.0, 1.0), vec2<f32>(0.0, 1.0),
    );
    let uv = corners[vid];
    let em = mix(em_min, em_max, uv);

    // TrueType Y is up; screen Y is down — flip y when projecting to pixels.
    let screen_x = pen.x + em.x * scale_em_to_px;
    let screen_y = pen.y - em.y * scale_em_to_px;

    let ndc_x = (screen_x / view.target_size.x) * 2.0 - 1.0;
    let ndc_y = 1.0 - (screen_y / view.target_size.y) * 2.0;

    var out: VertexOut;
    out.clip_pos = vec4<f32>(ndc_x, ndc_y, 0.0, 1.0);
    out.em_coord = em;
    out.meta_index = inst.meta_index;
    out.color = inst.color;
    return out;
}

// ── Pixel shader ───────────────────────────────────────────────────────────

// Defensive cap: prevents pathological glyph data from producing unbounded
// fragment work. 256 curves in one band is far more than any sane glyph.
const MAX_CURVES_PER_BAND: u32 = 256u;

fn load_curve(i: u32) -> mat3x2<f32> {
    let base = i * 6u;
    return mat3x2<f32>(
        vec2<f32>(curves[base + 0u], curves[base + 1u]),
        vec2<f32>(curves[base + 2u], curves[base + 3u]),
        vec2<f32>(curves[base + 4u], curves[base + 5u]),
    );
}

// Eligibility code (Slug, equation 3): bits 0 and 8 indicate whether the two
// roots of the quadratic in the band's perpendicular axis make a contribution
// to coverage. Encodes the "is the contribution at +∞ or -∞" sign rules.
fn calc_root_code(y1: f32, y2: f32, y3: f32) -> u32 {
    let i1 = bitcast<u32>(y1) >> 31u;
    let i2 = bitcast<u32>(y2) >> 30u;
    let i3 = bitcast<u32>(y3) >> 29u;

    var shift = (i2 & 2u) | (i1 & ~2u);
    shift = (i3 & 4u) | (shift & ~4u);

    return ((0x2E74u >> shift) & 0x0101u);
}

// Solve the curve's y polynomial = 0 for t ∈ ℝ; return x at those crossings.
// Curve points are already sample-relative (renderCoord subtracted).
fn solve_horiz_poly(p1: vec2<f32>, p2: vec2<f32>, p3: vec2<f32>) -> vec2<f32> {
    let a = p1 - p2 * 2.0 + p3;
    let b = p1 - p2;
    var t1: f32;
    var t2: f32;
    if (abs(a.y) < 1.0 / 65536.0) {
        // Polynomial nearly linear: -2b·t + c = 0 → t = c / (2b).
        let t = p1.y * (0.5 / b.y);
        t1 = t;
        t2 = t;
    } else {
        let d = sqrt(max(b.y * b.y - a.y * p1.y, 0.0));
        t1 = (b.y - d) / a.y;
        t2 = (b.y + d) / a.y;
    }
    return vec2<f32>(
        (a.x * t1 - b.x * 2.0) * t1 + p1.x,
        (a.x * t2 - b.x * 2.0) * t2 + p1.x,
    );
}

fn solve_vert_poly(p1: vec2<f32>, p2: vec2<f32>, p3: vec2<f32>) -> vec2<f32> {
    let a = p1 - p2 * 2.0 + p3;
    let b = p1 - p2;
    var t1: f32;
    var t2: f32;
    if (abs(a.x) < 1.0 / 65536.0) {
        let t = p1.x * (0.5 / b.x);
        t1 = t;
        t2 = t;
    } else {
        let d = sqrt(max(b.x * b.x - a.x * p1.x, 0.0));
        t1 = (b.x - d) / a.x;
        t2 = (b.x + d) / a.x;
    }
    return vec2<f32>(
        (a.y * t1 - b.y * 2.0) * t1 + p1.y,
        (a.y * t2 - b.y * 2.0) * t2 + p1.y,
    );
}

@fragment
fn fs_main(in: VertexOut) -> @location(0) vec4<f32> {
    let gmeta = glyph_metas[in.meta_index];

    // em-per-pixel from screen-space derivatives of em_coord. Independent
    // along x and y so the band thresholds correctly handle anisotropic
    // scaling.
    let ems_per_pixel = fwidth(in.em_coord);
    let pixels_per_em = vec2<f32>(1.0, 1.0) / ems_per_pixel;

    // Band index = clamp(floor(coord·scale + offset), 0, bandMax).
    let band_idx_f = in.em_coord * gmeta.band_transform.xy + gmeta.band_transform.zw;
    let band_idx_i = vec2<i32>(floor(band_idx_f));
    let band_idx = vec2<u32>(
        u32(clamp(band_idx_i.x, 0, i32(gmeta.band_max_x))),
        u32(clamp(band_idx_i.y, 0, i32(gmeta.band_max_y))),
    );

    var xcov: f32 = 0.0;
    var xwgt: f32 = 0.0;

    // ── Horizontal band (curves crossing y = sample.y) ──
    let h_header = band_headers[gmeta.band_headers_offset + band_idx.y];
    let h_count = min(h_header.curve_count, MAX_CURVES_PER_BAND);
    for (var i: u32 = 0u; i < h_count; i = i + 1u) {
        let curve_idx = band_curves_idx[h_header.curves_offset + i];
        let cv = load_curve(curve_idx);
        let p1 = cv[0] - in.em_coord;
        let p2 = cv[1] - in.em_coord;
        let p3 = cv[2] - in.em_coord;

        // Curves sorted by descending max-x; once we're more than half a pixel
        // to the right of the curve's max-x, no remaining curves contribute.
        if (max(max(p1.x, p2.x), p3.x) * pixels_per_em.x < -0.5) {
            break;
        }

        let code = calc_root_code(p1.y, p2.y, p3.y);
        if (code != 0u) {
            let r = solve_horiz_poly(p1, p2, p3) * pixels_per_em.x;
            if ((code & 1u) != 0u) {
                xcov = xcov + saturate(r.x + 0.5);
                xwgt = max(xwgt, saturate(1.0 - abs(r.x) * 2.0));
            }
            if (code > 1u) {
                xcov = xcov - saturate(r.y + 0.5);
                xwgt = max(xwgt, saturate(1.0 - abs(r.y) * 2.0));
            }
        }
    }

    var ycov: f32 = 0.0;
    var ywgt: f32 = 0.0;

    // ── Vertical band (curves crossing x = sample.x) ──
    // V headers follow all H headers within the glyph: offset by band_max_y + 1.
    let v_header = band_headers[
        gmeta.band_headers_offset + gmeta.band_max_y + 1u + band_idx.x
    ];
    let v_count = min(v_header.curve_count, MAX_CURVES_PER_BAND);
    for (var i: u32 = 0u; i < v_count; i = i + 1u) {
        let curve_idx = band_curves_idx[v_header.curves_offset + i];
        let cv = load_curve(curve_idx);
        let p1 = cv[0] - in.em_coord;
        let p2 = cv[1] - in.em_coord;
        let p3 = cv[2] - in.em_coord;

        if (max(max(p1.y, p2.y), p3.y) * pixels_per_em.y < -0.5) {
            break;
        }

        let code = calc_root_code(p1.x, p2.x, p3.x);
        if (code != 0u) {
            let r = solve_vert_poly(p1, p2, p3) * pixels_per_em.y;
            if ((code & 1u) != 0u) {
                ycov = ycov - saturate(r.x + 0.5);
                ywgt = max(ywgt, saturate(1.0 - abs(r.x) * 2.0));
            }
            if (code > 1u) {
                ycov = ycov + saturate(r.y + 0.5);
                ywgt = max(ywgt, saturate(1.0 - abs(r.y) * 2.0));
            }
        }
    }

    // Combine the two coverages. The weighted average is the primary path;
    // the min-of-magnitudes fallback covers cases where one axis has no
    // useful crossings near the pixel (degenerate near-horizontal/vertical
    // curves), as documented in the Slug paper.
    let denom = max(xwgt + ywgt, 1.0 / 65536.0);
    let weighted = abs(xcov * xwgt + ycov * ywgt) / denom;
    let coverage = saturate(max(weighted, min(abs(xcov), abs(ycov))));

    // Pre-multiplied output is conventional for blending; we keep straight
    // alpha here because the existing CompositePipeline expects straight RGB.
    return vec4<f32>(in.color.rgb, in.color.a * coverage);
}
