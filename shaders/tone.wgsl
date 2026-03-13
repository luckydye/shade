struct ToneParams {
    exposure: f32,
    contrast: f32,
    blacks: f32,
    highlights: f32,
    shadows: f32,
    gamma: f32,
    black_point: f32,
    white_point: f32,
};

@group(0) @binding(0) var input_tex: texture_2d<f32>;
@group(0) @binding(1) var output_tex: texture_storage_2d<rgba16float, write>;
@group(0) @binding(2) var<uniform> params: ToneParams;

@compute @workgroup_size(16, 16)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
    let dims = textureDimensions(input_tex);
    if (gid.x >= dims.x || gid.y >= dims.y) { return; }

    var c = textureLoad(input_tex, vec2<i32>(gid.xy), 0);

    // Input levels: remap [black_point, white_point] → [0, 1].
    c = vec4<f32>((c.rgb - vec3<f32>(params.black_point)) / max(params.white_point - params.black_point, 0.001), c.a);

    // Exposure in EV stops: each +1 doubles luminance, each -1 halves it.
    c = vec4<f32>(c.rgb * pow(2.0, params.exposure), c.a);

    // Contrast: pivot around mid-grey 0.18. Slope = 2^contrast so each unit
    // doubles/halves the contrast range, matching the EV scale of exposure.
    // Out-of-range values are preserved as-is and handled by the gamma step below.
    let mid = vec3<f32>(0.18);
    c = vec4<f32>(mid + (c.rgb - mid) * pow(2.0, params.contrast), c.a);

    // Black level lift
    c = vec4<f32>(c.rgb + vec3<f32>(params.blacks), c.a);

    // Shadows lift (low-end boost): apply to pixels below 0.5
    let shadow_mask = 1.0 - smoothstep(0.0, 0.5, c.r);
    c = vec4<f32>(c.rgb + vec3<f32>(params.shadows * shadow_mask * 0.5), c.a);

    // Highlights roll-off (compress high end): apply to pixels above 0.5
    let highlight_mask = smoothstep(0.5, 1.0, c.r);
    c = vec4<f32>(c.rgb * (1.0 - params.highlights * highlight_mask * 0.5), c.a);

    // Gamma: power curve (1.0 = no change). Use sign*pow(abs) to handle negative values
    // gracefully — preserves the sign so shadow detail isn't hard-clamped to 0.
    let signs = sign(c.rgb);
    c = vec4<f32>(signs * pow(abs(c.rgb), vec3<f32>(params.gamma)), c.a);

    textureStore(output_tex, vec2<i32>(gid.xy), c);
}
