// Vertical joint bilateral filter pass. Input is the H-pass result; the same
// full-resolution guide drives the range weights in both passes.

struct DenoiseUniform {
    luma_strength: f32,
    chroma_strength: f32,
    step_x: f32,
    step_y: f32,
}

@group(0) @binding(0) var input_tex: texture_2d<f32>;
@group(0) @binding(1) var guide_tex: texture_2d<f32>;
@group(0) @binding(2) var output_tex: texture_storage_2d<rgba16float, write>;
@group(0) @binding(3) var<uniform> params: DenoiseUniform;

const SPATIAL: array<f32, 11> = array<f32, 11>(
    0.0222, 0.0456, 0.0799, 0.1191, 0.1515, 0.1640,
    0.1515, 0.1191, 0.0799, 0.0456, 0.0222
);

// ACEScct transfer functions for linearising before YCbCr conversion.
fn acescct_to_linear(v: f32) -> f32 {
    if v < 0.1552511416 { return (v - 0.0729055342) / 10.5402377417; }
    return pow(2.0, v * 17.52 - 9.72);
}
fn linear_to_acescct(v: f32) -> f32 {
    if v <= 0.0078125 { return 10.5402377417 * v + 0.0729055342; }
    return (log2(max(v, 1.1754944e-38)) + 9.72) / 17.52;
}

// YCbCr using AP1 primaries (ACES S-2014-004 luma: Y = 0.2722287 R + 0.6740818 G + 0.0536895 B).
fn to_ycbcr(c: vec3<f32>) -> vec3<f32> {
    let lin = vec3<f32>(acescct_to_linear(c.r), acescct_to_linear(c.g), acescct_to_linear(c.b));
    return vec3<f32>(
         0.2722287 * lin.r + 0.6740818 * lin.g + 0.0536895 * lin.b,
        -0.1438369 * lin.r - 0.3561631 * lin.g + 0.5000000 * lin.b,
         0.5000000 * lin.r - 0.4631138 * lin.g - 0.0368862 * lin.b,
    );
}

fn from_ycbcr(ycc: vec3<f32>) -> vec3<f32> {
    let lin = vec3<f32>(
        ycc.x + 1.4555426 * ycc.z,
        ycc.x - 0.1507441 * ycc.y - 0.5878225 * ycc.z,
        ycc.x + 1.8926210 * ycc.y,
    );
    return vec3<f32>(linear_to_acescct(lin.r), linear_to_acescct(lin.g), linear_to_acescct(lin.b));
}

fn sample_linear(tex: texture_2d<f32>, p: vec2<f32>, dims: vec2<u32>) -> vec4<f32> {
    let max_coord = vec2<f32>(f32(dims.x) - 1.0, f32(dims.y) - 1.0);
    let clamped = clamp(p, vec2<f32>(0.0), max_coord);
    let base = floor(clamped);
    let frac = clamped - base;

    let x0 = i32(base.x);
    let y0 = i32(base.y);
    let x1 = min(x0 + 1, i32(dims.x) - 1);
    let y1 = min(y0 + 1, i32(dims.y) - 1);

    let c00 = textureLoad(tex, vec2<i32>(x0, y0), 0);
    let c10 = textureLoad(tex, vec2<i32>(x1, y0), 0);
    let c01 = textureLoad(tex, vec2<i32>(x0, y1), 0);
    let c11 = textureLoad(tex, vec2<i32>(x1, y1), 0);

    let top = mix(c00, c10, frac.x);
    let bottom = mix(c01, c11, frac.x);
    return mix(top, bottom, frac.y);
}

@compute @workgroup_size(16, 16)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
    let dims = textureDimensions(input_tex);
    if gid.x >= dims.x || gid.y >= dims.y { return; }

    let sigma_r_y = params.luma_strength * 0.15 + 0.001;
    let sigma_r_c = params.chroma_strength * 0.25 + 0.001;
    let inv2_y = 1.0 / (2.0 * sigma_r_y * sigma_r_y);
    let inv2_c = 1.0 / (2.0 * sigma_r_c * sigma_r_c);

    let center = vec2<f32>(gid.xy);
    let output_step_y = max(params.step_y, 0.0001);
    let guide_ctr = to_ycbcr(sample_linear(guide_tex, center, dims).rgb);

    var acc_y = 0.0; var acc_cb = 0.0; var acc_cr = 0.0;
    var w_y = 0.0;   var w_c = 0.0;

    for (var dy = -5; dy <= 5; dy++) {
        let q = vec2<f32>(center.x, center.y + f32(dy) / output_step_y);
        let sw = SPATIAL[u32(dy + 5)];

        let g = to_ycbcr(sample_linear(guide_tex, q, dims).rgb);
        let s = to_ycbcr(sample_linear(input_tex, q, dims).rgb);

        let dly = guide_ctr.x - g.x;
        let dc = length(guide_ctr.yz - g.yz);

        let wy = sw * exp(-dly * dly * inv2_y);
        let wc = sw * exp(-dc * dc * inv2_c);

        acc_y  += s.x * wy;
        acc_cb += s.y * wc;
        acc_cr += s.z * wc;
        w_y += wy;
        w_c += wc;
    }

    let ycc = vec3<f32>(acc_y / w_y, acc_cb / w_c, acc_cr / w_c);
    let alpha = textureLoad(input_tex, vec2<i32>(gid.xy), 0).a;
    textureStore(output_tex, vec2<i32>(gid.xy), vec4<f32>(from_ycbcr(ycc), alpha));
}
