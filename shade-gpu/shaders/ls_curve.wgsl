// ls_curve.wgsl — Luminosity-Saturation curve adjustment.
// LUT maps input luminosity (0-1) to output saturation multiplier.
// Input: float texture, Output: rgba16float storage texture.

@group(0) @binding(0) var input_tex: texture_2d<f32>;
@group(0) @binding(1) var output_tex: texture_storage_2d<rgba16float, write>;
@group(0) @binding(2) var<storage, read> lut: array<f32, 256>;

fn rgb_to_hsl(c: vec3<f32>) -> vec3<f32> {
    let mx = max(c.r, max(c.g, c.b));
    let mn = min(c.r, min(c.g, c.b));
    let l  = (mx + mn) * 0.5;
    let delta = mx - mn;
    if delta < 0.0001 { return vec3<f32>(0.0, 0.0, l); }
    let s = select(delta / (2.0 - mx - mn), delta / (mx + mn), l < 0.5);
    var h: f32;
    if      mx == c.r { h = (c.g - c.b) / delta + select(6.0, 0.0, c.g >= c.b); }
    else if mx == c.g { h = (c.b - c.r) / delta + 2.0; }
    else              { h = (c.r - c.g) / delta + 4.0; }
    return vec3<f32>(h / 6.0, s, l);
}

fn hue_to_rgb(p2: f32, q: f32, t_in: f32) -> f32 {
    var t = t_in;
    if t < 0.0 { t += 1.0; }
    if t > 1.0 { t -= 1.0; }
    if t < 1.0/6.0 { return p2 + (q - p2) * 6.0 * t; }
    if t < 0.5     { return q; }
    if t < 2.0/3.0 { return p2 + (q - p2) * (2.0/3.0 - t) * 6.0; }
    return p2;
}

fn hsl_to_rgb(hsl: vec3<f32>) -> vec3<f32> {
    if hsl.y < 0.0001 { return vec3<f32>(hsl.z); }
    let q  = select(hsl.z + hsl.y - hsl.z * hsl.y, hsl.z * (1.0 + hsl.y), hsl.z < 0.5);
    let p2 = 2.0 * hsl.z - q;
    return vec3<f32>(
        hue_to_rgb(p2, q, hsl.x + 1.0/3.0),
        hue_to_rgb(p2, q, hsl.x),
        hue_to_rgb(p2, q, hsl.x - 1.0/3.0),
    );
}

fn sample_lut(val: f32) -> f32 {
    let idx = val * 255.0;
    if (idx <= 0.0) {
        let slope = lut[1] - lut[0];
        return lut[0] + slope * idx;
    }
    if (idx >= 255.0) {
        let slope = lut[255] - lut[254];
        return lut[255] + slope * (idx - 255.0);
    }
    let lo = u32(floor(idx));
    let hi = lo + 1u;
    return mix(lut[lo], lut[hi], fract(idx));
}

@compute @workgroup_size(16, 16)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
    let dims = textureDimensions(input_tex);
    if gid.x >= dims.x || gid.y >= dims.y { return; }
    var c = textureLoad(input_tex, vec2<i32>(gid.xy), 0);

    let hdr_scale = max(max(c.r, max(c.g, c.b)), 1.0);
    let hsl = rgb_to_hsl(c.rgb / hdr_scale);

    let sat_mult = sample_lut(hsl.z);
    let s_new = clamp(hsl.y * sat_mult, 0.0, 1.0);

    let rgb_out = hsl_to_rgb(vec3<f32>(hsl.x, s_new, hsl.z)) * hdr_scale;
    textureStore(output_tex, vec2<i32>(gid.xy), vec4<f32>(rgb_out, c.a));
}
