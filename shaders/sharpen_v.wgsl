// Vertical Gaussian pass + unsharp mask composite
struct SharpenParams {
    amount: f32,
    threshold: f32,
};

@group(0) @binding(0) var original_tex: texture_2d<f32>;
@group(0) @binding(1) var blurred_h_tex: texture_2d<f32>;
@group(0) @binding(2) var output_tex: texture_storage_2d<rgba8unorm, write>;
@group(0) @binding(3) var<uniform> params: SharpenParams;

const KERNEL: array<f32, 7> = array<f32, 7>(
    0.0625, 0.125, 0.1875, 0.25, 0.1875, 0.125, 0.0625
);

@compute @workgroup_size(16, 16)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
    let dims = textureDimensions(original_tex);
    if gid.x >= dims.x || gid.y >= dims.y { return; }
    let p = vec2<i32>(gid.xy);
    // Vertical blur of the horizontally-blurred texture
    var blur = vec4<f32>(0.0);
    for (var i: i32 = -3; i <= 3; i++) {
        let sy = clamp(p.y + i, 0, i32(dims.y) - 1);
        blur += textureLoad(blurred_h_tex, vec2<i32>(p.x, sy), 0) * KERNEL[u32(i + 3)];
    }
    let original = textureLoad(original_tex, p, 0);
    let edge = original - blur;
    let edge_mag = length(edge.rgb);
    let mask = smoothstep(0.0, params.threshold + 0.001, edge_mag);
    let sharpened = clamp(original + edge * params.amount * mask, vec4<f32>(0.0), vec4<f32>(1.0));
    textureStore(output_tex, p, sharpened);
}
