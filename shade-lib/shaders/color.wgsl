struct ColorParams {
    saturation: f32,   // 1.0 = unchanged, 0.0 = monochrome, 2.0 = double
    vibrancy: f32,     // selective saturation boost for less-saturated pixels
    temperature: f32,  // -1.0 to 1.0 (cool to warm), +/- 0.5 stop split
    tint: f32,         // -1.0 to 1.0 (green to magenta), +/- 0.5 stop split
};

@group(0) @binding(0) var input_tex: texture_2d<f32>;
@group(0) @binding(1) var output_tex: texture_storage_2d<rgba16float, write>;
@group(0) @binding(2) var<uniform> params: ColorParams;

// One linear-light exposure stop expressed as an additive ACEScct printer-light offset.
const LOG_STEP: f32 = 1.0 / 17.52;
const WB_STOP_RANGE: f32 = 0.5;

// AP1 luminance coefficients (ACES S-2014-004).
fn luminance(rgb: vec3<f32>) -> f32 {
    return dot(rgb, vec3<f32>(0.2722287, 0.6740818, 0.0536895));
}

// ACEScct EOTF: encoded log value -> linear AP1 scene light.
fn acescct_to_linear(v: f32) -> f32 {
    if v < 0.1552511416 {
        return (v - 0.0729055342) / 10.5402377417;
    }
    return pow(2.0, v * 17.52 - 9.72);
}

// ACEScct OETF: linear AP1 scene light -> encoded log value.
fn linear_to_acescct(v: f32) -> f32 {
    if v <= 0.0078125 {
        return 10.5402377417 * v + 0.0729055342;
    }
    return (log2(max(v, 1.1754944e-38)) + 9.72) / 17.52;
}

fn acescct_to_linear_rgb(rgb: vec3<f32>) -> vec3<f32> {
    return vec3<f32>(
        acescct_to_linear(rgb.r),
        acescct_to_linear(rgb.g),
        acescct_to_linear(rgb.b)
    );
}

fn linear_to_acescct_rgb(rgb: vec3<f32>) -> vec3<f32> {
    return vec3<f32>(
        linear_to_acescct(rgb.r),
        linear_to_acescct(rgb.g),
        linear_to_acescct(rgb.b)
    );
}

fn channel_saturation(rgb: vec3<f32>) -> f32 {
    let max_c = max(rgb.r, max(rgb.g, rgb.b));
    let min_c = min(rgb.r, min(rgb.g, rgb.b));
    if max_c <= 1e-6 {
        return 0.0;
    }
    return clamp((max_c - min_c) / max_c, 0.0, 1.0);
}

@compute @workgroup_size(16, 16)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
    let dims = textureDimensions(input_tex);
    if (gid.x >= dims.x || gid.y >= dims.y) { return; }
    var c = textureLoad(input_tex, vec2<i32>(gid.xy), 0);

    // White balance in ACEScct is a per-channel additive offset: equivalent to
    // multiplying linear AP1 channels by exposure gains, but without decoding.
    let temp_offset = params.temperature * WB_STOP_RANGE * LOG_STEP;
    let tint_offset = params.tint * WB_STOP_RANGE * LOG_STEP;

    // Temperature: positive warms by raising red and lowering blue.
    // Tint: positive shifts magenta by raising red/blue and lowering green.
    c = vec4<f32>(
        c.r + temp_offset + tint_offset * 0.5,
        c.g - tint_offset,
        c.b - temp_offset + tint_offset * 0.5,
        c.a
    );

    // Saturation/vibrancy operate in linear AP1. HSL in ACEScct log space is not meaningful
    // and causes large hue/lightness errors, especially near the toe and in HDR values.
    var lin = acescct_to_linear_rgb(c.rgb);
    let grey = vec3<f32>(luminance(lin));
    lin = grey + (lin - grey) * max(params.saturation, 0.0);

    // Vibrancy is a selective chroma scale: low-saturation colours get more positive boost,
    // while already-saturated colours are protected. Negative values reduce low/mid chroma first.
    let vib_weight = 1.0 - channel_saturation(lin);
    let vib_scale = max(0.0, 1.0 + params.vibrancy * vib_weight);
    lin = grey + (lin - grey) * vib_scale;

    c = vec4<f32>(linear_to_acescct_rgb(lin), c.a);
    textureStore(output_tex, vec2<i32>(gid.xy), c);
}
