struct ToneParams {
    exposure: f32,
    contrast: f32,
    blacks: f32,
    whites: f32,
    highlights: f32,
    shadows: f32,
    gamma: f32,
    _pad: f32,
};

@group(0) @binding(0) var input_tex: texture_2d<f32>;
@group(0) @binding(1) var output_tex: texture_storage_2d<rgba16float, write>;
@group(0) @binding(2) var<uniform> params: ToneParams;

// ACEScct transfer functions (working space is ACEScct / AP1 log).
fn acescct_to_linear(v: f32) -> f32 {
    if v < 0.1552511416 {
        return (v - 0.0729055342) / 10.5402377417;
    }
    return pow(2.0, v * 17.52 - 9.72);
}
fn linear_to_acescct(v: f32) -> f32 {
    if v <= 0.0078125 {
        return 10.5402377417 * v + 0.0729055342;
    }
    return (log2(max(v, 1.1754944e-38)) + 9.72) / 17.52;
}

// AP1 luminance coefficients (ACES S-2014-004).
fn luminance(rgb: vec3<f32>) -> f32 {
    return dot(rgb, vec3<f32>(0.2722287, 0.6740818, 0.0536895));
}

@compute @workgroup_size(16, 16)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
    let dims = textureDimensions(input_tex);
    if (gid.x >= dims.x || gid.y >= dims.y) { return; }

    let c = textureLoad(input_tex, vec2<i32>(gid.xy), 0);

    // Decode ACEScct → linear AP1 for all tone math.
    var lin = vec3<f32>(
        acescct_to_linear(c.r),
        acescct_to_linear(c.g),
        acescct_to_linear(c.b),
    );

    // Exposure in EV stops: each +1 doubles luminance, each -1 halves it.
    lin = lin * pow(2.0, params.exposure);

    // Contrast: adjust luminance around mid-grey 0.18, then shift all channels
    // by the same delta so hue stays stable.
    let mid_luma = 0.18;
    let luma = luminance(lin);
    let contrast_luma = mid_luma + (luma - mid_luma) * pow(2.0, params.contrast);
    lin = lin + vec3<f32>(contrast_luma - luma);

    // Black level lift.
    lin = lin + vec3<f32>(params.blacks);

    // Whites: additive ceiling lift targeting highlights.
    let whites_mask = smoothstep(0.5, 1.0, luminance(lin));
    lin = lin + vec3<f32>(params.whites * whites_mask);

    // Shadows lift (low-end boost): apply to pixels below 0.5 luminance.
    let shadow_mask = 1.0 - smoothstep(0.0, 0.5, luminance(lin));
    lin = lin + vec3<f32>(params.shadows * shadow_mask * 0.5);

    // Highlights roll-off (compress high end): apply to pixels above 0.5 luminance.
    let highlight_mask = smoothstep(0.5, 1.0, luminance(lin));
    lin = lin * (1.0 - params.highlights * highlight_mask * 0.5);

    // Gamma: power curve (1.0 = no change). Use sign*pow(abs) to handle negative values
    // gracefully — preserves the sign so shadow detail isn't hard-clamped to 0.
    let signs = sign(lin);
    lin = signs * pow(abs(lin), vec3<f32>(params.gamma));

    // Re-encode to ACEScct.
    let out = vec3<f32>(
        linear_to_acescct(lin.r),
        linear_to_acescct(lin.g),
        linear_to_acescct(lin.b),
    );

    textureStore(output_tex, vec2<i32>(gid.xy), vec4<f32>(out, c.a));
}
