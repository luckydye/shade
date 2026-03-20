// Vertical Gaussian blur pass for denoising guide image (11-tap, σ≈2.5).

@group(0) @binding(0) var input_tex: texture_2d<f32>;
@group(0) @binding(1) var output_tex: texture_storage_2d<rgba16float, write>;

const KERNEL: array<f32, 11> = array<f32, 11>(
    0.0222, 0.0456, 0.0799, 0.1191, 0.1515, 0.1640,
    0.1515, 0.1191, 0.0799, 0.0456, 0.0222
);

@compute @workgroup_size(16, 16)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
    let dims = vec2<i32>(textureDimensions(input_tex));
    let p = vec2<i32>(gid.xy);
    if p.x >= dims.x || p.y >= dims.y { return; }
    var acc = vec4<f32>(0.0);
    for (var i: i32 = -5; i <= 5; i++) {
        let sy = clamp(p.y + i, 0, dims.y - 1);
        acc += textureLoad(input_tex, vec2<i32>(p.x, sy), 0) * KERNEL[u32(i + 5)];
    }
    textureStore(output_tex, p, acc);
}
