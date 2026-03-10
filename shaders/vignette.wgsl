struct VignetteParams {
    amount: f32,     // 0.0 = none, 1.0 = full black corners
    midpoint: f32,   // 0.0–1.0, default 0.5
    feather: f32,    // softness, default 0.2
    roundness: f32,  // 1.0 = circular, <1 = elliptical
};

@group(0) @binding(0) var input_tex: texture_2d<f32>;
@group(0) @binding(1) var output_tex: texture_storage_2d<rgba8unorm, write>;
@group(0) @binding(2) var<uniform> params: VignetteParams;

@compute @workgroup_size(16, 16)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
    let dims = textureDimensions(input_tex);
    if (gid.x >= dims.x || gid.y >= dims.y) { return; }
    var c = textureLoad(input_tex, vec2<i32>(gid.xy), 0);

    let uv = vec2<f32>(f32(gid.x) / f32(dims.x), f32(gid.y) / f32(dims.y));
    let centered = (uv - 0.5) * vec2<f32>(params.roundness, 1.0);
    let dist = length(centered);
    let v = smoothstep(params.midpoint - params.feather, params.midpoint + params.feather, dist);
    let multiplier = 1.0 - v * params.amount;

    c = vec4<f32>(c.rgb * multiplier, c.a);
    textureStore(output_tex, vec2<i32>(gid.xy), c);
}
