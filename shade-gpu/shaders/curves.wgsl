// LUT-based curves: 256-entry float array per channel (R, G, B) plus master
// Input: float texture, Output: rgba16float storage texture
// Bindings: input_tex, output_tex, lut_r (array<f32,256>), lut_g, lut_b, lut_master

struct CurvesParams {
    apply_per_channel: u32,  // 1 = per-channel, 0 = master only
};

@group(0) @binding(0) var input_tex: texture_2d<f32>;
@group(0) @binding(1) var output_tex: texture_storage_2d<rgba16float, write>;
@group(0) @binding(2) var<storage, read> lut_r: array<f32, 256>;
@group(0) @binding(3) var<storage, read> lut_g: array<f32, 256>;
@group(0) @binding(4) var<storage, read> lut_b: array<f32, 256>;
@group(0) @binding(5) var<storage, read> lut_master: array<f32, 256>;
@group(0) @binding(6) var<uniform> params: CurvesParams;

fn sample_lut_pair(val: f32, lo_val: f32, hi_val: f32) -> f32 {
    let idx = clamp(val * 255.0, 0.0, 255.0);
    let frac = fract(idx);
    return mix(lo_val, hi_val, frac);
}

fn sample_lut_master(val: f32) -> f32 {
    let idx = clamp(val * 255.0, 0.0, 255.0);
    let lo = u32(floor(idx));
    let hi = min(lo + 1u, 255u);
    return sample_lut_pair(val, lut_master[lo], lut_master[hi]);
}

fn sample_lut_r(val: f32) -> f32 {
    let idx = clamp(val * 255.0, 0.0, 255.0);
    let lo = u32(floor(idx));
    let hi = min(lo + 1u, 255u);
    return sample_lut_pair(val, lut_r[lo], lut_r[hi]);
}

fn sample_lut_g(val: f32) -> f32 {
    let idx = clamp(val * 255.0, 0.0, 255.0);
    let lo = u32(floor(idx));
    let hi = min(lo + 1u, 255u);
    return sample_lut_pair(val, lut_g[lo], lut_g[hi]);
}

fn sample_lut_b(val: f32) -> f32 {
    let idx = clamp(val * 255.0, 0.0, 255.0);
    let lo = u32(floor(idx));
    let hi = min(lo + 1u, 255u);
    return sample_lut_pair(val, lut_b[lo], lut_b[hi]);
}

@compute @workgroup_size(16, 16)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
    let dims = textureDimensions(input_tex);
    if (gid.x >= dims.x || gid.y >= dims.y) { return; }
    var c = textureLoad(input_tex, vec2<i32>(gid.xy), 0);
    // Apply master curve first
    c = vec4<f32>(
        sample_lut_master(c.r),
        sample_lut_master(c.g),
        sample_lut_master(c.b),
        c.a
    );
    if (params.apply_per_channel == 1u) {
        c = vec4<f32>(
            sample_lut_r(c.r),
            sample_lut_g(c.g),
            sample_lut_b(c.b),
            c.a
        );
    }
    textureStore(output_tex, vec2<i32>(gid.xy), c);
}
