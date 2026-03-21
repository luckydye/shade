// Horizontal Gaussian blur pass for denoising guide image (11-tap, σ≈2.5).
// Produces a noise-suppressed guide used to stabilise bilateral range weights.

struct DenoiseUniform {
    luma_strength: f32,
    chroma_strength: f32,
    step_x: f32,
    step_y: f32,
}

@group(0) @binding(0) var input_tex: texture_2d<f32>;
@group(0) @binding(1) var output_tex: texture_storage_2d<rgba16float, write>;
@group(0) @binding(2) var<uniform> params: DenoiseUniform;

// σ=2.5, 11-tap normalised Gaussian kernel
const KERNEL: array<f32, 11> = array<f32, 11>(
    0.0222, 0.0456, 0.0799, 0.1191, 0.1515, 0.1640,
    0.1515, 0.1191, 0.0799, 0.0456, 0.0222
);

fn sample_linear(p: vec2<f32>, dims: vec2<u32>) -> vec4<f32> {
    let max_coord = vec2<f32>(f32(dims.x) - 1.0, f32(dims.y) - 1.0);
    let clamped = clamp(p, vec2<f32>(0.0), max_coord);
    let base = floor(clamped);
    let frac = clamped - base;

    let x0 = i32(base.x);
    let y0 = i32(base.y);
    let x1 = min(x0 + 1, i32(dims.x) - 1);
    let y1 = min(y0 + 1, i32(dims.y) - 1);

    let c00 = textureLoad(input_tex, vec2<i32>(x0, y0), 0);
    let c10 = textureLoad(input_tex, vec2<i32>(x1, y0), 0);
    let c01 = textureLoad(input_tex, vec2<i32>(x0, y1), 0);
    let c11 = textureLoad(input_tex, vec2<i32>(x1, y1), 0);

    let top = mix(c00, c10, frac.x);
    let bottom = mix(c01, c11, frac.x);
    return mix(top, bottom, frac.y);
}

@compute @workgroup_size(16, 16)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
    let dims = textureDimensions(input_tex);
    if gid.x >= dims.x || gid.y >= dims.y { return; }
    var acc = vec4<f32>(0.0);
    let center = vec2<f32>(gid.xy);
    let output_step_x = max(params.step_x, 0.0001);
    for (var i: i32 = -5; i <= 5; i++) {
        let sample_x = center.x + f32(i) / output_step_x;
        acc += sample_linear(vec2<f32>(sample_x, center.y), dims) * KERNEL[u32(i + 5)];
    }
    textureStore(output_tex, vec2<i32>(gid.xy), acc);
}
