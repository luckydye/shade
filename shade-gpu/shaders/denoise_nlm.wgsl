// Non-Local Means denoiser with workgroup shared-memory tile caching.
//
// For each output pixel, a 15×15 search window is scanned. Each candidate is
// weighted by the similarity of a 5×5 patch around it to the reference patch.
// Luminance (Y) and chrominance (Cb, Cr) are filtered with independent h values
// mapped from luma_strength / chroma_strength.
//
// Tile layout (workgroup 16×16, search half W=7, patch half P=2):
//   MARGIN = W + P = 9, TILE_W = 16 + 18 = 34, TILE_SIZE = 1156
//   3 × 1156 × 4 bytes = 13 872 bytes of workgroup memory (< 16 384 limit).

struct DenoiseUniform {
    luma_strength: f32,
    chroma_strength: f32,
    _pad0: f32,
    _pad1: f32,
}

@group(0) @binding(0) var input_tex: texture_2d<f32>;
@group(0) @binding(1) var output_tex: texture_storage_2d<rgba16float, write>;
@group(0) @binding(2) var<uniform> params: DenoiseUniform;

const TILE_W: i32 = 34;
const MARGIN: i32 = 9;  // W + P = 7 + 2

var<workgroup> sh_y:  array<f32, 1156>;
var<workgroup> sh_cb: array<f32, 1156>;
var<workgroup> sh_cr: array<f32, 1156>;

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

@compute @workgroup_size(16, 16)
fn main(
    @builtin(global_invocation_id) gid: vec3<u32>,
    @builtin(local_invocation_id) lid: vec3<u32>,
    @builtin(workgroup_id) wgid: vec3<u32>,
) {
    let dims = vec2<i32>(textureDimensions(input_tex));

    // ── Cooperative tile load ─────────────────────────────────────────────────
    // Origin of the workgroup in image space (top-left corner of the 16×16 block)
    let wg_origin = vec2<i32>(i32(wgid.x) * 16, i32(wgid.y) * 16);
    let tid = i32(lid.y * 16u + lid.x);

    for (var i = tid; i < 1156; i += 256) {
        let tx = i % TILE_W;
        let ty = i / TILE_W;
        let img_x = clamp(wg_origin.x - MARGIN + tx, 0, dims.x - 1);
        let img_y = clamp(wg_origin.y - MARGIN + ty, 0, dims.y - 1);
        let ycc = to_ycbcr(textureLoad(input_tex, vec2<i32>(img_x, img_y), 0).rgb);
        sh_y[i]  = ycc.x;
        sh_cb[i] = ycc.y;
        sh_cr[i] = ycc.z;
    }
    workgroupBarrier();

    // ── Per-pixel NLM ─────────────────────────────────────────────────────────
    let p = vec2<i32>(gid.xy);
    if p.x >= dims.x || p.y >= dims.y { return; }

    // h controls filtering strength; normalise SSD by patch_size (25 pixels)
    let h_y = params.luma_strength * 0.10 + 0.001;
    let h_c = params.chroma_strength * 0.15 + 0.001;
    let inv_h2_y = 1.0 / (h_y * h_y * 25.0);
    let inv_h2_c = 1.0 / (h_c * h_c * 50.0);  // 50 = 2 channels × 25 pixels

    // Centre of this pixel in tile coordinates
    let cx = i32(lid.x) + MARGIN;
    let cy = i32(lid.y) + MARGIN;

    var acc_y = 0.0; var acc_cb = 0.0; var acc_cr = 0.0;
    var w_y = 0.0;   var w_c = 0.0;

    for (var dy = -7; dy <= 7; dy++) {
        for (var dx = -7; dx <= 7; dx++) {
            // Accumulate patch SSD between reference (cx,cy) and candidate (cx+dx,cy+dy)
            var ssd_y = 0.0;
            var ssd_c = 0.0;
            for (var py = -2; py <= 2; py++) {
                for (var px = -2; px <= 2; px++) {
                    let ref_idx  = u32((cy + py) * TILE_W + (cx + px));
                    let cand_idx = u32((cy + dy + py) * TILE_W + (cx + dx + px));
                    let diff_y  = sh_y[ref_idx]  - sh_y[cand_idx];
                    let diff_cb = sh_cb[ref_idx] - sh_cb[cand_idx];
                    let diff_cr = sh_cr[ref_idx] - sh_cr[cand_idx];
                    ssd_y += diff_y * diff_y;
                    ssd_c += diff_cb * diff_cb + diff_cr * diff_cr;
                }
            }

            let wy = exp(-ssd_y * inv_h2_y);
            let wc = exp(-ssd_c * inv_h2_c);

            let cand = u32((cy + dy) * TILE_W + (cx + dx));
            acc_y  += sh_y[cand]  * wy;
            acc_cb += sh_cb[cand] * wc;
            acc_cr += sh_cr[cand] * wc;
            w_y += wy;
            w_c += wc;
        }
    }

    let ycc = vec3<f32>(acc_y / w_y, acc_cb / w_c, acc_cr / w_c);
    let alpha = textureLoad(input_tex, p, 0).a;
    textureStore(output_tex, p, vec4<f32>(from_ycbcr(ycc), alpha));
}
