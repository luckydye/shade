// Horizontal Gaussian blur pass (σ≈1.5, 7-tap kernel)
struct SharpenPassParams {
    _unused: f32,
};

@group(0) @binding(0) var input_tex: texture_2d<f32>;
@group(0) @binding(1) var output_tex: texture_storage_2d<rgba16float, write>;

const KERNEL: array<f32, 7> = array<f32, 7>(
    0.0625, 0.125, 0.1875, 0.25, 0.1875, 0.125, 0.0625
);

@compute @workgroup_size(16, 16)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
    let dims = textureDimensions(input_tex);
    if gid.x >= dims.x || gid.y >= dims.y { return; }
    var acc = vec4<f32>(0.0);
    for (var i: i32 = -3; i <= 3; i++) {
        let sx = clamp(i32(gid.x) + i, 0, i32(dims.x) - 1);
        acc += textureLoad(input_tex, vec2<i32>(sx, i32(gid.y)), 0) * KERNEL[u32(i + 3)];
    }
    textureStore(output_tex, vec2<i32>(gid.xy), acc);
}
