struct GrainParams {
    grain: vec4<f32>,
    image_space0: vec4<f32>,
    image_space1: vec4<f32>,
};

@group(0) @binding(0) var input_tex: texture_2d<f32>;
@group(0) @binding(1) var output_tex: texture_storage_2d<rgba16float, write>;
@group(0) @binding(2) var<uniform> params: GrainParams;

fn pcg(v: u32) -> u32 {
    let state = v * 747796405u + 2891336453u;
    let word = ((state >> ((state >> 28u) + 4u)) ^ state) * 277803737u;
    return (word >> 22u) ^ word;
}

// Random unit gradient vector for a lattice point.
// Full 360° continuous rotation — no directional bias from a discrete set.
fn grad(ix: i32, iy: i32, channel: u32) -> vec2<f32> {
    let seed_u = bitcast<u32>(params.grain.w);
    let key = u32(ix) ^ (u32(iy) * 2654435761u) ^ (channel * 1234567891u) ^ (seed_u * 3266489917u);
    let h = pcg(pcg(key));
    let angle = f32(h) * (6.28318530718 / 4294967296.0);
    return vec2<f32>(cos(angle), sin(angle));
}

// Perlin gradient noise — no blob-grid artifacts, naturally zero-mean.
fn perlin(p: vec2<f32>, channel: u32) -> f32 {
    let i = vec2<i32>(floor(p));
    let f = fract(p);
    // Quintic smoothstep (C2): eliminates the faint grid visible with cubic
    let u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);

    let n00 = dot(grad(i.x,     i.y,     channel), f - vec2<f32>(0.0, 0.0));
    let n10 = dot(grad(i.x + 1, i.y,     channel), f - vec2<f32>(1.0, 0.0));
    let n01 = dot(grad(i.x,     i.y + 1, channel), f - vec2<f32>(0.0, 1.0));
    let n11 = dot(grad(i.x + 1, i.y + 1, channel), f - vec2<f32>(1.0, 1.0));

    return mix(mix(n00, n10, u.x), mix(n01, n11, u.x), u.y);
}

@compute @workgroup_size(16, 16)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
    let dims = textureDimensions(input_tex);
    if (gid.x >= dims.x || gid.y >= dims.y) { return; }
    var c = textureLoad(input_tex, vec2<i32>(gid.xy), 0);

    let luma = dot(c.rgb, vec3<f32>(0.2126, 0.7152, 0.0722));

    // +0.5 shifts pixel centers to sit between lattice points.
    // Perlin is always 0 at integer coords, so without this offset size=1
    // would sample only zero-crossings and produce no visible grain.
    let image_pos =
        params.image_space0.xy + (vec2<f32>(gid.xy) + vec2<f32>(0.5, 0.5)) * params.image_space0.zw;
    let p = image_pos / max(params.grain.y, 1.0) + 0.5;

    // Independent grain per channel (R/G/B film emulsion layers)
    let gr = perlin(p, 0u);
    let gg = perlin(p, 1u);
    let gb = perlin(p, 2u);

    // Tonal weighting: grain peaks in midtones, rolls off toward deep shadows and highlights
    let shadow_lift    = smoothstep(0.0, 0.25, luma);
    let highlight_drop = smoothstep(1.0, 0.65, luma);
    let tonal_weight = mix(1.0, shadow_lift * highlight_drop, params.grain.z);

    // Perlin output range ≈ [-0.7, 0.7]; 0.15 maps amount=1 to strong visible grain
    let scale = params.grain.x * 0.15 * tonal_weight;

    c = vec4<f32>(
        c.r + gr * scale,
        c.g + gg * scale,
        c.b + gb * scale,
        c.a,
    );
    textureStore(output_tex, vec2<i32>(gid.xy), c);
}
