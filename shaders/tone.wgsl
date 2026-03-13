struct ToneParams {
    exposure: f32,
    contrast: f32,
    blacks: f32,
    highlights: f32,
    shadows: f32,
    gamma: f32,
};

@group(0) @binding(0) var input_tex: texture_2d<f32>;
@group(0) @binding(1) var output_tex: texture_storage_2d<rgba16float, write>;
@group(0) @binding(2) var<uniform> params: ToneParams;

fn luminance(rgb: vec3<f32>) -> f32 {
    return dot(rgb, vec3<f32>(0.2126, 0.7152, 0.0722));
}

@compute @workgroup_size(16, 16)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
    let dims = textureDimensions(input_tex);
    if (gid.x >= dims.x || gid.y >= dims.y) { return; }

    var c = textureLoad(input_tex, vec2<i32>(gid.xy), 0);

    // Exposure in EV stops: each +1 doubles luminance, each -1 halves it.
    c = vec4<f32>(c.rgb * pow(2.0, params.exposure), c.a);

    // Contrast: adjust luminance around mid-grey 0.18, then shift all channels
    // by the same delta so hue stays stable.
    let mid_luma = 0.18;
    let luma = luminance(c.rgb);
    let contrast_luma = mid_luma + (luma - mid_luma) * pow(2.0, params.contrast);
    c = vec4<f32>(c.rgb + vec3<f32>(contrast_luma - luma), c.a);

    // Black level lift
    c = vec4<f32>(c.rgb + vec3<f32>(params.blacks), c.a);

    // Shadows lift (low-end boost): apply to pixels below 0.5 luminance.
    let shadow_mask = 1.0 - smoothstep(0.0, 0.5, luminance(c.rgb));
    c = vec4<f32>(c.rgb + vec3<f32>(params.shadows * shadow_mask * 0.5), c.a);

    // Highlights roll-off (compress high end): apply to pixels above 0.5 luminance.
    let highlight_mask = smoothstep(0.5, 1.0, luminance(c.rgb));
    c = vec4<f32>(c.rgb * (1.0 - params.highlights * highlight_mask * 0.5), c.a);

    // Gamma: power curve (1.0 = no change). Use sign*pow(abs) to handle negative values
    // gracefully — preserves the sign so shadow detail isn't hard-clamped to 0.
    let signs = sign(c.rgb);
    c = vec4<f32>(signs * pow(abs(c.rgb), vec3<f32>(params.gamma)), c.a);

    textureStore(output_tex, vec2<i32>(gid.xy), c);
}
