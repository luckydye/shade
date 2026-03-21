// Non-Local Means denoiser.
//
// For each output pixel, a 15×15 search window is scanned. Each candidate is
// weighted by the similarity of a 5×5 patch around it to the reference patch.
// Luminance (Y) and chrominance (Cb, Cr) are filtered with independent h values
// mapped from luma_strength / chroma_strength.

struct DenoiseUniform {
    luma_strength: f32,
    chroma_strength: f32,
    step_x: f32,
    step_y: f32,
}

@group(0) @binding(0) var input_tex: texture_2d<f32>;
@group(0) @binding(1) var output_tex: texture_storage_2d<rgba16float, write>;
@group(0) @binding(2) var<uniform> params: DenoiseUniform;

fn to_ycbcr(c: vec3<f32>) -> vec3<f32> {
    return vec3<f32>(
         0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b,
        -0.1146 * c.r - 0.3854 * c.g + 0.5000 * c.b,
         0.5000 * c.r - 0.4542 * c.g - 0.0458 * c.b,
    );
}

fn from_ycbcr(ycc: vec3<f32>) -> vec3<f32> {
    return vec3<f32>(
        ycc.x + 1.5748 * ycc.z,
        ycc.x - 0.1873 * ycc.y - 0.4681 * ycc.z,
        ycc.x + 1.8556 * ycc.y,
    );
}

fn sample_linear(tex: texture_2d<f32>, p: vec2<f32>, dims: vec2<u32>) -> vec4<f32> {
    let max_coord = vec2<f32>(f32(dims.x) - 1.0, f32(dims.y) - 1.0);
    let clamped = clamp(p, vec2<f32>(0.0), max_coord);
    let base = floor(clamped);
    let frac = clamped - base;

    let x0 = i32(base.x);
    let y0 = i32(base.y);
    let x1 = min(x0 + 1, i32(dims.x) - 1);
    let y1 = min(y0 + 1, i32(dims.y) - 1);

    let c00 = textureLoad(tex, vec2<i32>(x0, y0), 0);
    let c10 = textureLoad(tex, vec2<i32>(x1, y0), 0);
    let c01 = textureLoad(tex, vec2<i32>(x0, y1), 0);
    let c11 = textureLoad(tex, vec2<i32>(x1, y1), 0);

    let top = mix(c00, c10, frac.x);
    let bottom = mix(c01, c11, frac.x);
    return mix(top, bottom, frac.y);
}

@compute @workgroup_size(16, 16)
fn main(
    @builtin(global_invocation_id) gid: vec3<u32>,
) {
    let dims = textureDimensions(input_tex);
    if gid.x >= dims.x || gid.y >= dims.y { return; }

    // h controls filtering strength; normalise SSD by patch_size (25 pixels)
    let h_y = params.luma_strength * 0.10 + 0.001;
    let h_c = params.chroma_strength * 0.15 + 0.001;
    let inv_h2_y = 1.0 / (h_y * h_y * 25.0);
    let inv_h2_c = 1.0 / (h_c * h_c * 50.0);  // 50 = 2 channels × 25 pixels
    let center = vec2<f32>(gid.xy);
    let output_step = max(vec2<f32>(params.step_x, params.step_y), vec2<f32>(0.0001));

    var acc_y = 0.0; var acc_cb = 0.0; var acc_cr = 0.0;
    var w_y = 0.0;   var w_c = 0.0;

    for (var dy = -7; dy <= 7; dy++) {
        for (var dx = -7; dx <= 7; dx++) {
            let search_offset =
                vec2<f32>(f32(dx) / output_step.x, f32(dy) / output_step.y);
            let candidate_center = center + search_offset;
            var ssd_y = 0.0;
            var ssd_c = 0.0;
            for (var py = -2; py <= 2; py++) {
                for (var px = -2; px <= 2; px++) {
                    let patch_offset =
                        vec2<f32>(f32(px) / output_step.x, f32(py) / output_step.y);
                    let ref_ycc =
                        to_ycbcr(sample_linear(input_tex, center + patch_offset, dims).rgb);
                    let cand_ycc = to_ycbcr(
                        sample_linear(input_tex, candidate_center + patch_offset, dims).rgb
                    );
                    let diff_y = ref_ycc.x - cand_ycc.x;
                    let diff_cb = ref_ycc.y - cand_ycc.y;
                    let diff_cr = ref_ycc.z - cand_ycc.z;
                    ssd_y += diff_y * diff_y;
                    ssd_c += diff_cb * diff_cb + diff_cr * diff_cr;
                }
            }

            let wy = exp(-ssd_y * inv_h2_y);
            let wc = exp(-ssd_c * inv_h2_c);
            let cand_ycc = to_ycbcr(sample_linear(input_tex, candidate_center, dims).rgb);
            acc_y  += cand_ycc.x * wy;
            acc_cb += cand_ycc.y * wc;
            acc_cr += cand_ycc.z * wc;
            w_y += wy;
            w_c += wc;
        }
    }

    let ycc = vec3<f32>(acc_y / w_y, acc_cb / w_c, acc_cr / w_c);
    let alpha = textureLoad(input_tex, vec2<i32>(gid.xy), 0).a;
    textureStore(output_tex, vec2<i32>(gid.xy), vec4<f32>(from_ycbcr(ycc), alpha));
}
