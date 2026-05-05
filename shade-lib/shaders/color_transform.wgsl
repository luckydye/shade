// GPU-side colour space transform.
// Used to convert source images into the ACEScct working space on load,
// and from ACEScct to the display/export colour space on output.

struct ColorTransformParams {
    // Transform mode:
    //   0 = identity (passthrough)
    //   1 = linear → sRGB (legacy gamma encode)
    //   2 = sRGB → linear (legacy gamma decode)
    //   3 = matrix only (linear → linear)
    //   4 = power-law gamma decode then matrix (e.g. AdobeRGB → linear)
    //   5 = matrix then sRGB encode (e.g. linear → Display P3)
    //   6 = sRGB EOTF → matrix → ACEScct OETF  (sRGB/P3 → ACEScct)
    //   7 = ACEScct EOTF → matrix → sRGB OETF  (ACEScct → sRGB/Display P3)
    //   8 = power-law gamma EOTF → matrix → ACEScct OETF  (AdobeRGB/ProPhoto → ACEScct)
    //   9 = matrix → ACEScct OETF  (linear → ACEScct, no gamma decode)
    //  10 = ACEScct EOTF → matrix  (ACEScct → linear, no output encode)
    mode: u32,
    gamma: f32,        // source gamma for modes 4/8 (e.g. 2.2, 1.8)
    _pad0: f32,
    _pad1: f32,
    // 3×3 colour matrix, stored as 3 vec4 rows (xyz + padding)
    row0: vec4<f32>,   // [m00, m01, m02, 0]
    row1: vec4<f32>,   // [m10, m11, m12, 0]
    row2: vec4<f32>,   // [m20, m21, m22, 0]
};

@group(0) @binding(0) var input_tex:  texture_2d<f32>;
@group(0) @binding(1) var output_tex: texture_storage_2d<rgba16float, write>;
@group(0) @binding(2) var<uniform>    params: ColorTransformParams;

// ── Transfer functions ────────────────────────────────────────────────────────

fn srgb_to_linear(v: f32) -> f32 {
    return select(v / 12.92, pow((v + 0.055) / 1.055, 2.4), v > 0.04045);
}

fn linear_to_srgb(v: f32) -> f32 {
    let c = max(v, 0.0);
    return select(c * 12.92, 1.055 * pow(c, 1.0/2.4) - 0.055, c > 0.0031308);
}

// ACEScct EOTF: encoded log value → linear AP1 scene light.
// Y_BRK ≈ 0.1552511416 = (log2(0.0078125) + 9.72) / 17.52
fn acescct_to_linear(v: f32) -> f32 {
    if v < 0.1552511416 {
        return (v - 0.0729055342) / 10.5402377417;
    }
    return pow(2.0, v * 17.52 - 9.72);
}

// ACEScct OETF: linear AP1 scene light → encoded log value.
fn linear_to_acescct(v: f32) -> f32 {
    if v <= 0.0078125 {
        return 10.5402377417 * v + 0.0729055342;
    }
    return (log2(max(v, 1.1754944e-38)) + 9.72) / 17.52;
}

fn apply_matrix(rgb: vec3<f32>, p: ColorTransformParams) -> vec3<f32> {
    return vec3<f32>(
        dot(p.row0.xyz, rgb),
        dot(p.row1.xyz, rgb),
        dot(p.row2.xyz, rgb)
    );
}

// ── Main ──────────────────────────────────────────────────────────────────────

@compute @workgroup_size(16, 16)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
    let dims = textureDimensions(input_tex);
    if gid.x >= dims.x || gid.y >= dims.y { return; }
    let p = vec2<i32>(gid.xy);
    var c = textureLoad(input_tex, p, 0);
    var rgb = c.rgb;

    switch params.mode {
        case 0u: {
            // identity
        }
        case 1u: {
            // linear → sRGB
            rgb = vec3<f32>(linear_to_srgb(rgb.r), linear_to_srgb(rgb.g), linear_to_srgb(rgb.b));
        }
        case 2u: {
            // sRGB → linear
            rgb = vec3<f32>(srgb_to_linear(rgb.r), srgb_to_linear(rgb.g), srgb_to_linear(rgb.b));
        }
        case 3u: {
            // matrix only (linear → linear)
            rgb = apply_matrix(rgb, params);
        }
        case 4u: {
            // decode gamma then matrix (e.g. AdobeRGB → linear sRGB)
            rgb = pow(max(rgb, vec3<f32>(0.0)), vec3<f32>(params.gamma));
            rgb = apply_matrix(rgb, params);
        }
        case 5u: {
            // matrix then encode sRGB transfer (e.g. linear sRGB → Display P3)
            rgb = apply_matrix(rgb, params);
            rgb = vec3<f32>(linear_to_srgb(rgb.r), linear_to_srgb(rgb.g), linear_to_srgb(rgb.b));
        }
        case 6u: {
            // sRGB EOTF → matrix → ACEScct OETF  (sRGB or Display P3 → ACEScct)
            rgb = vec3<f32>(srgb_to_linear(rgb.r), srgb_to_linear(rgb.g), srgb_to_linear(rgb.b));
            rgb = apply_matrix(rgb, params);
            rgb = vec3<f32>(linear_to_acescct(rgb.r), linear_to_acescct(rgb.g), linear_to_acescct(rgb.b));
        }
        case 7u: {
            // ACEScct EOTF → matrix → sRGB OETF  (ACEScct → sRGB or Display P3)
            rgb = vec3<f32>(acescct_to_linear(rgb.r), acescct_to_linear(rgb.g), acescct_to_linear(rgb.b));
            rgb = apply_matrix(rgb, params);
            rgb = vec3<f32>(linear_to_srgb(rgb.r), linear_to_srgb(rgb.g), linear_to_srgb(rgb.b));
        }
        case 8u: {
            // power-law gamma EOTF → matrix → ACEScct OETF  (AdobeRGB/ProPhoto → ACEScct)
            rgb = pow(max(rgb, vec3<f32>(0.0)), vec3<f32>(params.gamma));
            rgb = apply_matrix(rgb, params);
            rgb = vec3<f32>(linear_to_acescct(rgb.r), linear_to_acescct(rgb.g), linear_to_acescct(rgb.b));
        }
        case 9u: {
            // linear → matrix → ACEScct OETF  (LinearSrgb → ACEScct)
            rgb = apply_matrix(rgb, params);
            rgb = vec3<f32>(linear_to_acescct(rgb.r), linear_to_acescct(rgb.g), linear_to_acescct(rgb.b));
        }
        case 10u: {
            // ACEScct EOTF → matrix  (ACEScct → linear, no output encoding)
            rgb = vec3<f32>(acescct_to_linear(rgb.r), acescct_to_linear(rgb.g), acescct_to_linear(rgb.b));
            rgb = apply_matrix(rgb, params);
        }
        default: {}
    }

    textureStore(output_tex, p, vec4<f32>(rgb, c.a));
}
