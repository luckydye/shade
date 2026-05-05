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

// 18% grey in ACEScct and one EV expressed as an ACEScct additive offset (1/17.52).
const MIDGREY: f32 = 0.4136;
const LOG_STEP: f32 = 0.05707;

// AP1 luminance coefficients (ACES S-2014-004).
fn luminance(rgb: vec3<f32>) -> f32 {
    return dot(rgb, vec3<f32>(0.2722287, 0.6740818, 0.0536895));
}

@compute @workgroup_size(16, 16)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
    let dims = textureDimensions(input_tex);
    if (gid.x >= dims.x || gid.y >= dims.y) { return; }

    let c = textureLoad(input_tex, vec2<i32>(gid.xy), 0);
    var v = c.rgb;

    // Exposure: additive log offset — each EV stop shifts ACEScct by LOG_STEP.
    v += vec3<f32>(params.exposure * LOG_STEP);

    // Contrast: scale deviation from mid-grey in log space.
    // params.contrast = 0 → no change; +1 → doubles deviation; -1 → zeroes deviation.
    var luma = luminance(v);
    v += vec3<f32>((luma - MIDGREY) * params.contrast);

    // Blacks: additive shadow adjustment, masked to values below mid-grey.
    luma = luminance(v);
    let black_mask = 1.0 - smoothstep(0.0, MIDGREY, luma);
    v += vec3<f32>(params.blacks * black_mask);

    // Whites: additive highlight adjustment, masked to values above mid-grey.
    luma = luminance(v);
    let white_mask = smoothstep(MIDGREY, 0.6, luma);
    v += vec3<f32>(params.whites * white_mask);

    // Shadows: lift/lower the lower quarter of tones (~0–0.38 ACEScct).
    luma = luminance(v);
    let shadow_mask = 1.0 - smoothstep(0.05, 0.38, luma);
    v += vec3<f32>(params.shadows * LOG_STEP * shadow_mask);

    // Highlights: lift/lower the upper quarter of tones (~0.45–0.65 ACEScct).
    luma = luminance(v);
    let highlight_mask = smoothstep(0.45, 0.65, luma);
    v -= vec3<f32>(params.highlights * LOG_STEP * highlight_mask);

    // Gamma: power curve pivoted at MIDGREY so mid-grey is always preserved.
    let t = v / MIDGREY;
    let sgn = sign(t);
    v = sgn * pow(abs(t) + 1e-7, vec3<f32>(params.gamma)) * MIDGREY;

    textureStore(output_tex, vec2<i32>(gid.xy), vec4<f32>(v, c.a));
}
