struct ToneParams {
    exposure: f32,
    contrast: f32,
    blacks: f32,
    highlights: f32,
    shadows: f32,
};

@group(0) @binding(0) var input_tex: texture_2d<f32>;
@group(0) @binding(1) var output_tex: texture_storage_2d<rgba8unorm, write>;
@group(0) @binding(2) var<uniform> params: ToneParams;

@compute @workgroup_size(16, 16)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
    let dims = textureDimensions(input_tex);
    if (gid.x >= dims.x || gid.y >= dims.y) { return; }

    var c = textureLoad(input_tex, vec2<i32>(gid.xy), 0);

    // Exposure: 2^exposure multiplier
    c = vec4<f32>(c.rgb * pow(2.0, params.exposure), c.a);

    // Contrast: pivot around mid-grey 0.18
    let mid = vec3<f32>(0.18);
    c = vec4<f32>(mid + (c.rgb - mid) * (1.0 + params.contrast), c.a);

    // Black level lift
    c = vec4<f32>(c.rgb + vec3<f32>(params.blacks), c.a);

    // Shadows lift (low-end boost): apply to pixels below 0.5
    let shadow_mask = 1.0 - smoothstep(0.0, 0.5, c.r);
    c = vec4<f32>(c.rgb + vec3<f32>(params.shadows * shadow_mask * 0.5), c.a);

    // Highlights roll-off (compress high end): apply to pixels above 0.5
    let highlight_mask = smoothstep(0.5, 1.0, c.r);
    c = vec4<f32>(c.rgb * (1.0 - params.highlights * highlight_mask * 0.5), c.a);

    // Clamp to [0, 1]
    c = clamp(c, vec4<f32>(0.0), vec4<f32>(1.0));

    textureStore(output_tex, vec2<i32>(gid.xy), c);
}
