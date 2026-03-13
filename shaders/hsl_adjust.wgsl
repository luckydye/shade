// hsl_adjust.wgsl — per-color hue/saturation/luminance balance.
// Three hue ranges (red, green, blue) with triangular weighting.

struct HslParams {
    red:   vec4<f32>,  // x=hue, y=sat, z=lum, w=unused
    green: vec4<f32>,
    blue:  vec4<f32>,
};

@group(0) @binding(0) var input_tex:  texture_2d<f32>;
@group(0) @binding(1) var output_tex: texture_storage_2d<rgba16float, write>;
@group(0) @binding(2) var<uniform> p: HslParams;

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

// Triangular hue weighting: 1.0 at center, 0.0 at ±1/3 away, handles wraparound.
fn hue_weight(hue: f32, center: f32) -> f32 {
    var d = abs(hue - center);
    if d > 0.5 { d = 1.0 - d; }
    return max(0.0, 1.0 - d * 3.0);
}

@compute @workgroup_size(16, 16)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
    let dims = textureDimensions(input_tex);
    if gid.x >= dims.x || gid.y >= dims.y { return; }
    let px = vec2<i32>(gid.xy);
    let c  = textureLoad(input_tex, px, 0);
    let hsl = rgb_to_hsl(c.rgb);

    // Scale hue weights by saturation so achromatic pixels are unaffected.
    let sat_blend = smoothstep(0.0, 0.05, hsl.y);
    let wr = hue_weight(hsl.x, 0.0)       * sat_blend;
    let wg = hue_weight(hsl.x, 1.0/3.0)   * sat_blend;
    let wb = hue_weight(hsl.x, 2.0/3.0)   * sat_blend;

    // Accumulate weighted deltas. Hue input is scaled ×0.5 (±1 slider → ±180°).
    let dh = (wr * p.red.x + wg * p.green.x + wb * p.blue.x) * 0.5;
    let ds =  wr * p.red.y + wg * p.green.y + wb * p.blue.y;
    let dl =  wr * p.red.z + wg * p.green.z + wb * p.blue.z;

    let h_new = fract(hsl.x + dh);
    let s_new = clamp(hsl.y + ds, 0.0, 1.0);
    let l_new = clamp(hsl.z + dl, 0.0, 1.0);

    let rgb_out = hsl_to_rgb(vec3<f32>(h_new, s_new, l_new));
    textureStore(output_tex, px, vec4<f32>(rgb_out, c.a));
}
