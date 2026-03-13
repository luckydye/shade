// basic_adjust.wgsl — fused tone + color adjustment in a single compute pass.
// Eliminates one intermediate texture compared to running tone then color separately.

struct ToneParams {
    exposure: f32,
    contrast: f32,
    blacks: f32,
    highlights: f32,
    shadows: f32,
    gamma: f32,
    black_point: f32,
    white_point: f32,
};

struct ColorParams {
    saturation: f32,
    vibrancy: f32,
    temperature: f32,
    tint: f32,
};

@group(0) @binding(0) var input_tex: texture_2d<f32>;
@group(0) @binding(1) var output_tex: texture_storage_2d<rgba16float, write>;
@group(0) @binding(2) var<uniform> tone: ToneParams;
@group(0) @binding(3) var<uniform> color: ColorParams;

// ── Tone helpers ──────────────────────────────────────────────────────────────
fn apply_tone(c: vec4<f32>, p: ToneParams) -> vec4<f32> {
    // Input levels: remap [black_point, white_point] → [0, 1].
    var rgb = (c.rgb - vec3<f32>(p.black_point)) / max(p.white_point - p.black_point, 0.001);
    // Exposure in EV stops: each +1 doubles luminance, each -1 halves it.
    rgb = rgb * pow(2.0, p.exposure);
    // Contrast: pivot around mid-grey 0.18. Slope = 2^contrast (logarithmic scale).
    let mid = vec3<f32>(0.18);
    rgb = mid + (rgb - mid) * pow(2.0, p.contrast);
    rgb = rgb + vec3<f32>(p.blacks);
    let shadow_mask = 1.0 - smoothstep(0.0, 0.5, rgb.r);
    rgb = rgb + vec3<f32>(p.shadows * shadow_mask * 0.5);
    let highlight_mask = smoothstep(0.5, 1.0, rgb.r);
    rgb = rgb * (1.0 - p.highlights * highlight_mask * 0.5);
    // Gamma: power curve (1.0 = no change). Use sign*pow(abs) to handle negative values
    // gracefully — preserves the sign so shadow detail isn't hard-clamped to 0.
    let signs = sign(rgb);
    rgb = signs * pow(abs(rgb), vec3<f32>(p.gamma));
    return vec4<f32>(rgb, c.a);
}

// ── Colour helpers ────────────────────────────────────────────────────────────
fn rgb_to_hsl(c: vec3<f32>) -> vec3<f32> {
    let mx = max(c.r, max(c.g, c.b));
    let mn = min(c.r, min(c.g, c.b));
    let l = (mx + mn) * 0.5;
    let delta = mx - mn;
    if delta < 0.0001 { return vec3<f32>(0.0, 0.0, l); }
    let s = select(delta / (2.0 - mx - mn), delta / (mx + mn), l < 0.5);
    var h: f32;
    if mx == c.r { h = (c.g - c.b) / delta + select(6.0, 0.0, c.g >= c.b); }
    else if mx == c.g { h = (c.b - c.r) / delta + 2.0; }
    else { h = (c.r - c.g) / delta + 4.0; }
    return vec3<f32>(h / 6.0, s, l);
}

fn hue_to_rgb(p: f32, q: f32, t_in: f32) -> f32 {
    var t = t_in;
    if t < 0.0 { t += 1.0; }
    if t > 1.0 { t -= 1.0; }
    if t < 1.0/6.0 { return p + (q-p)*6.0*t; }
    if t < 0.5 { return q; }
    if t < 2.0/3.0 { return p + (q-p)*(2.0/3.0-t)*6.0; }
    return p;
}

fn hsl_to_rgb(hsl: vec3<f32>) -> vec3<f32> {
    if hsl.y < 0.0001 { return vec3<f32>(hsl.z); }
    let q = select(hsl.z + hsl.y - hsl.z*hsl.y, hsl.z*(1.0+hsl.y), hsl.z < 0.5);
    let p2 = 2.0*hsl.z - q;
    return vec3<f32>(
        hue_to_rgb(p2, q, hsl.x + 1.0/3.0),
        hue_to_rgb(p2, q, hsl.x),
        hue_to_rgb(p2, q, hsl.x - 1.0/3.0)
    );
}

fn apply_color(c: vec4<f32>, p: ColorParams) -> vec4<f32> {
    var rgb = c.rgb;
    // Temperature: von Kries white balance along blue-yellow axis.
    // Multiplicative in linear light — positive = warm (more red, less blue).
    let temp_gain = pow(2.0, p.temperature * 0.5);
    rgb = vec3<f32>(rgb.r * temp_gain, rgb.g, rgb.b / temp_gain);

    // Tint: shift along green-magenta axis.
    // Positive = magenta (reduce green). Multiplicative in linear light.
    let tint_gain = pow(2.0, p.tint * 0.5);
    rgb = vec3<f32>(rgb.r, rgb.g / tint_gain, rgb.b);
    // Saturation
    let hsl = rgb_to_hsl(rgb);
    let new_sat = clamp(hsl.y * p.saturation, 0.0, 1.0);
    rgb = hsl_to_rgb(vec3<f32>(hsl.x, new_sat, hsl.z));
    // Vibrancy
    let hsl2 = rgb_to_hsl(rgb);
    let vib_sat = clamp(hsl2.y + p.vibrancy*(1.0-hsl2.y)*0.5, 0.0, 1.0);
    rgb = hsl_to_rgb(vec3<f32>(hsl2.x, vib_sat, hsl2.z));
    return vec4<f32>(rgb, c.a);
}

@compute @workgroup_size(16, 16)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
    let dims = textureDimensions(input_tex);
    if gid.x >= dims.x || gid.y >= dims.y { return; }
    let p = vec2<i32>(gid.xy);
    var c = textureLoad(input_tex, p, 0);
    c = apply_tone(c, tone);
    c = apply_color(c, color);
    textureStore(output_tex, p, c);
}
