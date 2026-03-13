// GPU-side colour space transform.
// Applied at display time: linear sRGB → display colour space.
// Also used for source linearisation when loaded on GPU.

struct ColorTransformParams {
    // Transform mode:
    //   0 = identity (passthrough)
    //   1 = linear sRGB → sRGB (gamma encode, for display)
    //   2 = sRGB → linear sRGB (gamma decode, for source linearisation)
    //   3 = matrix transform only (linear → linear, no gamma)
    //   4 = decode gamma then matrix (e.g. AdobeRGB → linear sRGB)
    //   5 = matrix then encode gamma (e.g. linear sRGB → Display P3)
    mode: u32,
    gamma: f32,        // source gamma for modes 4/5 (e.g. 2.2)
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
    let c = clamp(v, 0.0, 1.0);
    return select(c * 12.92, 1.055 * pow(c, 1.0/2.4) - 0.055, c > 0.0031308);
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
            // matrix then encode sRGB gamma
            rgb = apply_matrix(rgb, params);
            rgb = vec3<f32>(linear_to_srgb(rgb.r), linear_to_srgb(rgb.g), linear_to_srgb(rgb.b));
        }
        default: {}
    }

    textureStore(output_tex, p, vec4<f32>(rgb, c.a));
}
