struct GrainParams {
    amount: f32,     // grain intensity (0.0–1.0)
    size: f32,       // grain size factor (1.0 = pixel-level, 4.0 = coarser)
    roughness: f32,  // luminance-based modulation (0.0–1.0)
    seed: f32,       // random seed (use frame counter)
};

@group(0) @binding(0) var input_tex: texture_2d<f32>;
@group(0) @binding(1) var output_tex: texture_storage_2d<rgba16float, write>;
@group(0) @binding(2) var<uniform> params: GrainParams;

// PCG hash — much higher quality than float hash tricks, no visible patterns
fn pcg(v: u32) -> u32 {
    let state = v * 747796405u + 2891336453u;
    let word = ((state >> ((state >> 28u) + 4u)) ^ state) * 277803737u;
    return (word >> 22u) ^ word;
}

fn u32_to_f01(h: u32) -> f32 {
    return f32(h) * (1.0 / 4294967296.0);
}

// Returns a Gaussian sample (mean=0, stddev=1) for the given pixel+channel
fn gaussian_grain(px: vec2<u32>, channel: u32) -> f32 {
    let seed_u = bitcast<u32>(params.seed);
    // Mix all inputs into a single seed, avoiding trivial collisions
    let key = px.x ^ (px.y * 2654435761u) ^ (channel * 1234567891u) ^ (seed_u * 3266489917u);
    let h1 = pcg(key);
    let h2 = pcg(h1 ^ 2891336453u);

    // Box-Muller: two uniform → one Gaussian
    let u1 = max(u32_to_f01(h1), 0.00001);
    let u2 = u32_to_f01(h2);
    return sqrt(-2.0 * log(u1)) * cos(6.28318530718 * u2);
}

@compute @workgroup_size(16, 16)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
    let dims = textureDimensions(input_tex);
    if (gid.x >= dims.x || gid.y >= dims.y) { return; }
    var c = textureLoad(input_tex, vec2<i32>(gid.xy), 0);

    // Grain coordinate: size > 1 groups pixels into blocks (coarser grain)
    let grain_px = vec2<u32>(gid.xy) / u32(max(params.size, 1.0));

    // Independent Gaussian noise per channel — film emulsion layers are independent
    let gr = gaussian_grain(grain_px, 0u);
    let gg = gaussian_grain(grain_px, 1u);
    let gb = gaussian_grain(grain_px, 2u);

    let luma = dot(c.rgb, vec3<f32>(0.2126, 0.7152, 0.0722));

    // Tonal weighting: grain peaks in midtones, rolls off in deep shadows and
    // bright highlights. roughness controls how aggressively it rolls off.
    let shadow_lift    = smoothstep(0.0, 0.25, luma);
    let highlight_drop = smoothstep(1.0, 0.65, luma);
    let tonal_weight   = mix(1.0, shadow_lift * highlight_drop, params.roughness);

    // Stddev ≈ 1 from Gaussian; 0.05 maps amount=1 to strong but realistic grain
    let scale = params.amount * 0.05 * tonal_weight;

    c = vec4<f32>(
        c.r + gr * scale,
        c.g + gg * scale,
        c.b + gb * scale,
        c.a,
    );
    textureStore(output_tex, vec2<i32>(gid.xy), c);
}
