struct GlowParams {
    glow: vec4<f32>,
    image_space: vec4<f32>,
};

@group(0) @binding(0) var input_tex: texture_2d<f32>;
@group(0) @binding(1) var output_tex: texture_storage_2d<rgba16float, write>;
@group(0) @binding(2) var<uniform> params: GlowParams;

fn luminance(rgb: vec3<f32>) -> f32 {
    return dot(max(rgb, vec3<f32>(0.0)), vec3<f32>(0.2126, 0.7152, 0.0722));
}

fn sample_linear(p: vec2<f32>, dims: vec2<u32>) -> vec4<f32> {
    let max_coord = vec2<f32>(f32(dims.x) - 1.0, f32(dims.y) - 1.0);
    let clamped = clamp(p, vec2<f32>(0.0), max_coord);
    let base = floor(clamped);
    let frac = clamped - base;

    let x0 = i32(base.x);
    let y0 = i32(base.y);
    let x1 = min(x0 + 1, i32(dims.x) - 1);
    let y1 = min(y0 + 1, i32(dims.y) - 1);

    let c00 = textureLoad(input_tex, vec2<i32>(x0, y0), 0);
    let c10 = textureLoad(input_tex, vec2<i32>(x1, y0), 0);
    let c01 = textureLoad(input_tex, vec2<i32>(x0, y1), 0);
    let c11 = textureLoad(input_tex, vec2<i32>(x1, y1), 0);

    let top = mix(c00, c10, frac.x);
    let bottom = mix(c01, c11, frac.x);
    return mix(top, bottom, frac.y);
}

fn highlight_energy(rgb: vec3<f32>) -> f32 {
    let luma = luminance(rgb);
    let soft = smoothstep(0.4, 1.0, luma);
    let red_excess = max(rgb.r - max(rgb.g, rgb.b), 0.0);
    let compressed = 1.0 - exp(-max(luma, 0.0) * 1.5);
    return soft * (compressed + red_excess * 0.3);
}

fn glow_sample(origin: vec2<f32>, offset: vec2<f32>, dims: vec2<u32>) -> f32 {
    return highlight_energy(sample_linear(origin + offset, dims).rgb);
}

@compute @workgroup_size(16, 16)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
    let dims = textureDimensions(input_tex);
    if (gid.x >= dims.x || gid.y >= dims.y) { return; }

    let amount = clamp(params.glow.x, 0.0, 1.0);
    let spread_t = pow(amount, 0.7);
    let strength_t = amount * amount * (3.0 - 2.0 * amount);
    let center = textureLoad(input_tex, vec2<i32>(gid.xy), 0);
    let reference_longest_edge = max(params.image_space.x, params.image_space.y);
    let resolution_scale = clamp(reference_longest_edge / 2000.0, 0.75, 2.0);
    let radius_ref_px = (1.5 + spread_t * 24.0) * resolution_scale;
    let sigma_ref_px = max(radius_ref_px * 0.55, 1.0);
    let sample_step_ref_px = max(radius_ref_px / 6.0, 0.4);
    let row_step_ref_px = sample_step_ref_px * 0.8660254;
    let output_step = max(params.glow.yz, vec2<f32>(0.0001, 0.0001));
    let p = vec2<f32>(gid.xy);

    var glow_energy = 0.0;
    var weight_sum = 0.0;

    for (var oy: i32 = -6; oy <= 6; oy = oy + 1) {
        let row_shift = select(0.0, 0.5, abs(oy) % 2 == 1);
        for (var ox: i32 = -6; ox <= 6; ox = ox + 1) {
            let offset_ref = vec2<f32>(
                (f32(ox) + row_shift) * sample_step_ref_px,
                f32(oy) * row_step_ref_px,
            );
            let offset_output = offset_ref / output_step;
            let dist2 = dot(offset_ref, offset_ref);
            let weight = exp(-dist2 / (2.0 * sigma_ref_px * sigma_ref_px));
            glow_energy += glow_sample(p, offset_output, dims) * weight;
            weight_sum += weight;
        }
    }

    let blurred = select(0.0, glow_energy / weight_sum, weight_sum > 0.0);
    let halation = vec3<f32>(1.0, 0.55, 0.24) * blurred * strength_t * 1.15;

    textureStore(output_tex, vec2<i32>(gid.xy), vec4<f32>(center.rgb + halation, center.a));
}
