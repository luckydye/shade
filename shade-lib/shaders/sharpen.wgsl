struct SharpenParams {
    amount: f32,     // sharpening strength (0.0–2.0)
    threshold: f32,  // suppress sharpening in smooth areas (0.0–1.0)
};

@group(0) @binding(0) var input_tex: texture_2d<f32>;
@group(0) @binding(1) var output_tex: texture_storage_2d<rgba16float, write>;
@group(0) @binding(2) var<uniform> params: SharpenParams;

@compute @workgroup_size(16, 16)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
    let dims = textureDimensions(input_tex);
    if (gid.x >= dims.x || gid.y >= dims.y) { return; }

    let p = vec2<i32>(gid.xy);
    let c = textureLoad(input_tex, p, 0);

    // Box blur 3x3
    var blur = vec4<f32>(0.0);
    for (var dy: i32 = -1; dy <= 1; dy++) {
        for (var dx: i32 = -1; dx <= 1; dx++) {
            let np = clamp(p + vec2<i32>(dx, dy), vec2<i32>(0), vec2<i32>(dims) - vec2<i32>(1));
            blur += textureLoad(input_tex, np, 0);
        }
    }
    blur /= 9.0;

    // Unsharp mask: edge = original - blur; measure edge magnitude for threshold
    let edge = c - blur;
    let edge_mag = length(edge.rgb);
    let threshold_mask = smoothstep(0.0, params.threshold + 0.01, edge_mag);

    let sharpened = c + edge * params.amount * threshold_mask;
    textureStore(output_tex, vec2<i32>(gid.xy), sharpened);
}
