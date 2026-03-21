// Vertical Gaussian pass + unsharp mask composite
struct SharpenParams {
    amount: f32,
    threshold: f32,
    step_x: f32,
    step_y: f32,
};

@group(0) @binding(0) var original_tex: texture_2d<f32>;
@group(0) @binding(1) var blurred_h_tex: texture_2d<f32>;
@group(0) @binding(2) var output_tex: texture_storage_2d<rgba16float, write>;
@group(0) @binding(3) var<uniform> params: SharpenParams;

const KERNEL: array<f32, 7> = array<f32, 7>(
    0.0625, 0.125, 0.1875, 0.25, 0.1875, 0.125, 0.0625
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

    let c00 = textureLoad(blurred_h_tex, vec2<i32>(x0, y0), 0);
    let c10 = textureLoad(blurred_h_tex, vec2<i32>(x1, y0), 0);
    let c01 = textureLoad(blurred_h_tex, vec2<i32>(x0, y1), 0);
    let c11 = textureLoad(blurred_h_tex, vec2<i32>(x1, y1), 0);

    let top = mix(c00, c10, frac.x);
    let bottom = mix(c01, c11, frac.x);
    return mix(top, bottom, frac.y);
}

@compute @workgroup_size(16, 16)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
    let dims = textureDimensions(original_tex);
    if gid.x >= dims.x || gid.y >= dims.y { return; }
    let p = vec2<i32>(gid.xy);
    // Vertical blur of the horizontally-blurred texture
    var blur = vec4<f32>(0.0);
    let center = vec2<f32>(gid.xy);
    let output_step_y = max(params.step_y, 0.0001);
    for (var i: i32 = -3; i <= 3; i++) {
        let sample_y = center.y + f32(i) / output_step_y;
        blur += sample_linear(vec2<f32>(center.x, sample_y), dims) * KERNEL[u32(i + 3)];
    }
    let original = textureLoad(original_tex, p, 0);
    let edge = original - blur;
    let edge_mag = length(edge.rgb);
    let mask = smoothstep(0.0, params.threshold + 0.001, edge_mag);
    let sharpened = original + edge * params.amount * mask;
    textureStore(output_tex, p, sharpened);
}
