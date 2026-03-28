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

fn sample_lut(val: f32) -> f32 {
    let idx = val * 255.0;
    if (idx <= 0.0) {
        let slope = lut_master[1] - lut_master[0];
        return lut_master[0] + slope * idx;
    }
    if (idx >= 255.0) {
        let slope = lut_master[255] - lut_master[254];
        return lut_master[255] + slope * (idx - 255.0);
    }
    let lo = u32(floor(idx));
    let hi = lo + 1u;
    return mix(lut_master[lo], lut_master[hi], fract(idx));
}

fn sample_lut_r(val: f32) -> f32 {
    let idx = val * 255.0;
    if (idx <= 0.0) {
        let slope = lut_r[1] - lut_r[0];
        return lut_r[0] + slope * idx;
    }
    if (idx >= 255.0) {
        let slope = lut_r[255] - lut_r[254];
        return lut_r[255] + slope * (idx - 255.0);
    }
    let lo = u32(floor(idx));
    let hi = lo + 1u;
    return mix(lut_r[lo], lut_r[hi], fract(idx));
}

fn sample_lut_g(val: f32) -> f32 {
    let idx = val * 255.0;
    if (idx <= 0.0) {
        let slope = lut_g[1] - lut_g[0];
        return lut_g[0] + slope * idx;
    }
    if (idx >= 255.0) {
        let slope = lut_g[255] - lut_g[254];
        return lut_g[255] + slope * (idx - 255.0);
    }
    let lo = u32(floor(idx));
    let hi = lo + 1u;
    return mix(lut_g[lo], lut_g[hi], fract(idx));
}

fn sample_lut_b(val: f32) -> f32 {
    let idx = val * 255.0;
    if (idx <= 0.0) {
        let slope = lut_b[1] - lut_b[0];
        return lut_b[0] + slope * idx;
    }
    if (idx >= 255.0) {
        let slope = lut_b[255] - lut_b[254];
        return lut_b[255] + slope * (idx - 255.0);
    }
    let lo = u32(floor(idx));
    let hi = lo + 1u;
    return mix(lut_b[lo], lut_b[hi], fract(idx));
}

@compute @workgroup_size(16, 16)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
    let dims = textureDimensions(input_tex);
    if (gid.x >= dims.x || gid.y >= dims.y) { return; }
    var c = textureLoad(input_tex, vec2<i32>(gid.xy), 0);
    c = vec4<f32>(
        sample_lut(c.r),
        sample_lut(c.g),
        sample_lut(c.b),
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
