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

fn sample_lut(val: f32, lut: ptr<storage, array<f32, 256>, read>) -> f32 {
    let idx = val * 255.0;
    if (idx <= 0.0) {
        let slope = (*lut)[1] - (*lut)[0];
        return (*lut)[0] + slope * idx;
    }
    if (idx >= 255.0) {
        let slope = (*lut)[255] - (*lut)[254];
        return (*lut)[255] + slope * (idx - 255.0);
    }
    let lo = u32(floor(idx));
    let hi = lo + 1u;
    return mix((*lut)[lo], (*lut)[hi], fract(idx));
}

@compute @workgroup_size(16, 16)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
    let dims = textureDimensions(input_tex);
    if (gid.x >= dims.x || gid.y >= dims.y) { return; }
    var c = textureLoad(input_tex, vec2<i32>(gid.xy), 0);
    // Apply master curve first
    c = vec4<f32>(
        sample_lut(c.r, &lut_master),
        sample_lut(c.g, &lut_master),
        sample_lut(c.b, &lut_master),
        c.a
    );
    if (params.apply_per_channel == 1u) {
        c = vec4<f32>(
            sample_lut(c.r, &lut_r),
            sample_lut(c.g, &lut_g),
            sample_lut(c.b, &lut_b),
            c.a
        );
    }
    textureStore(output_tex, vec2<i32>(gid.xy), c);
}
