struct GrainParams {
    amount: f32,     // grain intensity (0.0–1.0)
    size: f32,       // grain size factor (1.0 = pixel-level, 4.0 = coarser)
    roughness: f32,  // luminance-based modulation (0.0–1.0)
    seed: f32,       // random seed (use frame counter)
};

@group(0) @binding(0) var input_tex: texture_2d<f32>;
@group(0) @binding(1) var output_tex: texture_storage_2d<rgba16float, write>;
@group(0) @binding(2) var<uniform> params: GrainParams;

// High-quality hash returning a value in [0, 1)
fn hash2(p: vec2<f32>) -> f32 {
    var q = fract(p * vec2<f32>(127.1, 311.7));
    q += dot(q, q.yx + 19.19);
    return fract((q.x + q.y) * q.x);
}

// Box-Muller transform: two uniform samples → Gaussian sample (mean=0, stddev=1)
fn gaussian(u1: f32, u2: f32) -> f32 {
    let eps = 0.0001;
    let safe_u1 = max(u1, eps);
    return sqrt(-2.0 * log(safe_u1)) * cos(6.28318530718 * u2);
}

// Sample one Gaussian noise value for a given pixel coordinate + channel offset
fn film_grain(coord: vec2<f32>, channel_offset: f32) -> f32 {
    let base = coord + vec2<f32>(params.seed * 13.7 + channel_offset, params.seed * 7.3 + channel_offset * 1.7);

    // Two independent uniform samples for Box-Muller
    let u1 = hash2(base);
    let u2 = hash2(base + vec2<f32>(53.1, 91.7));

    // Mix in a second coarser octave (2x scale) to simulate crystal clustering
    let coarse_base = floor(coord * 0.5) + vec2<f32>(params.seed * 13.7 + channel_offset, params.seed * 7.3);
    let u3 = hash2(coarse_base);
    let u4 = hash2(coarse_base + vec2<f32>(37.3, 61.1));

    let fine   = gaussian(u1, u2);
    let coarse = gaussian(u3, u4);

    // 70% fine, 30% coarse — mimics silver halide crystal structure
    return fine * 0.7 + coarse * 0.3;
}

@compute @workgroup_size(16, 16)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
    let dims = textureDimensions(input_tex);
    if (gid.x >= dims.x || gid.y >= dims.y) { return; }
    var c = textureLoad(input_tex, vec2<i32>(gid.xy), 0);

    let luma = dot(c.rgb, vec3<f32>(0.2126, 0.7152, 0.0722));

    // Grain coordinate respects the size param (larger size = blockier grain)
    let grain_coord = floor(vec2<f32>(gid.xy) / params.size);

    // Separate grain per channel — each film emulsion layer has independent grain
    let gr = film_grain(grain_coord, 0.0);
    let gg = film_grain(grain_coord, 100.0);
    let gb = film_grain(grain_coord, 200.0);

    // Luminance weighting: film grain peaks in midtones (~0.4 luma), rolls off
    // in deep shadows (underexposed = less grain) and in bright highlights.
    // roughness controls how strongly grain avoids the extremes.
    let shadow_rolloff    = smoothstep(0.0, 0.2, luma);
    let highlight_rolloff = smoothstep(1.0, 0.7, luma);
    let tonal_weight = mix(1.0, shadow_rolloff * highlight_rolloff, params.roughness);

    // Gaussian noise has stddev ≈ 1; scale so amount=1 gives visible but not
    // overwhelming grain (0.08 is roughly equivalent to ISO 3200 film).
    let scale = params.amount * 0.08 * tonal_weight;

    c = vec4<f32>(
        c.r + gr * scale,
        c.g + gg * scale,
        c.b + gb * scale,
        c.a,
    );
    textureStore(output_tex, vec2<i32>(gid.xy), c);
}
