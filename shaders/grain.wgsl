struct GrainParams {
    amount: f32,     // grain intensity (0.0–1.0)
    size: f32,       // grain size factor (1.0 = pixel-level, 4.0 = coarser)
    roughness: f32,  // luminance-based modulation (0.0–1.0)
    seed: f32,       // random seed (use frame counter)
};

@group(0) @binding(0) var input_tex: texture_2d<f32>;
@group(0) @binding(1) var output_tex: texture_storage_2d<rgba8unorm, write>;
@group(0) @binding(2) var<uniform> params: GrainParams;

fn hash(p: vec2<f32>) -> f32 {
    var p2 = fract(p * vec2<f32>(443.897, 441.423));
    p2 += dot(p2, p2.yx + 19.19);
    return fract((p2.x + p2.y) * p2.x);
}

@compute @workgroup_size(16, 16)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
    let dims = textureDimensions(input_tex);
    if (gid.x >= dims.x || gid.y >= dims.y) { return; }
    var c = textureLoad(input_tex, vec2<i32>(gid.xy), 0);

    // Grain computed in luminance space
    let luma = dot(c.rgb, vec3<f32>(0.299, 0.587, 0.114));
    let grain_uv = floor(vec2<f32>(gid.xy) / params.size) + vec2<f32>(params.seed * 7.3, params.seed * 3.7);
    let noise = hash(grain_uv) * 2.0 - 1.0;  // -1 to 1
    // Modulate by roughness: add more grain to midtones, less to highlights/shadows
    let luma_weight = 1.0 - abs(luma - 0.5) * 2.0 * (1.0 - params.roughness);
    let grain_val = noise * params.amount * luma_weight;
    c = clamp(vec4<f32>(c.rgb + vec3<f32>(grain_val), c.a), vec4<f32>(0.0), vec4<f32>(1.0));
    textureStore(output_tex, vec2<i32>(gid.xy), c);
}
