struct ColorParams {
    saturation: f32,   // 1.0 = unchanged, 0.0 = monochrome, 2.0 = double
    vibrancy: f32,     // selective saturation boost for less-saturated pixels
    temperature: f32,  // -1.0 to 1.0 (cool to warm)
    tint: f32,         // -1.0 to 1.0 (green to magenta)
};

@group(0) @binding(0) var input_tex: texture_2d<f32>;
@group(0) @binding(1) var output_tex: texture_storage_2d<rgba8unorm, write>;
@group(0) @binding(2) var<uniform> params: ColorParams;

fn rgb_to_hsl(c: vec3<f32>) -> vec3<f32> {
    let maxC = max(c.r, max(c.g, c.b));
    let minC = min(c.r, min(c.g, c.b));
    let l = (maxC + minC) * 0.5;
    let delta = maxC - minC;
    if (delta < 0.0001) { return vec3<f32>(0.0, 0.0, l); }
    let s = select(delta / (2.0 - maxC - minC), delta / (maxC + minC), l < 0.5);
    var h: f32;
    if (maxC == c.r) {
        h = (c.g - c.b) / delta + select(6.0, 0.0, c.g >= c.b);
    } else if (maxC == c.g) {
        h = (c.b - c.r) / delta + 2.0;
    } else {
        h = (c.r - c.g) / delta + 4.0;
    }
    return vec3<f32>(h / 6.0, s, l);
}

fn hue_to_rgb(p: f32, q: f32, t_in: f32) -> f32 {
    var t = t_in;
    if (t < 0.0) { t += 1.0; }
    if (t > 1.0) { t -= 1.0; }
    if (t < 1.0/6.0) { return p + (q - p) * 6.0 * t; }
    if (t < 1.0/2.0) { return q; }
    if (t < 2.0/3.0) { return p + (q - p) * (2.0/3.0 - t) * 6.0; }
    return p;
}

fn hsl_to_rgb(hsl: vec3<f32>) -> vec3<f32> {
    if (hsl.y < 0.0001) { return vec3<f32>(hsl.z); }
    let q = select(hsl.z + hsl.y - hsl.z * hsl.y, hsl.z * (1.0 + hsl.y), hsl.z < 0.5);
    let p = 2.0 * hsl.z - q;
    return vec3<f32>(
        hue_to_rgb(p, q, hsl.x + 1.0/3.0),
        hue_to_rgb(p, q, hsl.x),
        hue_to_rgb(p, q, hsl.x - 1.0/3.0)
    );
}

@compute @workgroup_size(16, 16)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
    let dims = textureDimensions(input_tex);
    if (gid.x >= dims.x || gid.y >= dims.y) { return; }
    var c = textureLoad(input_tex, vec2<i32>(gid.xy), 0);

    // Temperature: shift blue-yellow axis
    c = vec4<f32>(
        c.r + params.temperature * 0.1,
        c.g,
        c.b - params.temperature * 0.1,
        c.a
    );
    // Tint: green-magenta axis
    c = vec4<f32>(
        c.r + params.tint * 0.05,
        c.g - params.tint * 0.1,
        c.b + params.tint * 0.05,
        c.a
    );

    // Saturation
    let hsl = rgb_to_hsl(c.rgb);
    let new_sat = clamp(hsl.y * params.saturation, 0.0, 1.0);
    var rgb_new = hsl_to_rgb(vec3<f32>(hsl.x, new_sat, hsl.z));

    // Vibrancy: boost less-saturated pixels more
    let vibrancy_boost = params.vibrancy * (1.0 - hsl.y);
    let hsl2 = rgb_to_hsl(rgb_new);
    let vib_sat = clamp(hsl2.y + vibrancy_boost * 0.5, 0.0, 1.0);
    rgb_new = hsl_to_rgb(vec3<f32>(hsl2.x, vib_sat, hsl2.z));

    c = clamp(vec4<f32>(rgb_new, c.a), vec4<f32>(0.0), vec4<f32>(1.0));
    textureStore(output_tex, vec2<i32>(gid.xy), c);
}
