struct CompositeParams {
    opacity: f32,
    blend_mode: u32,  // 0=Normal, 1=Multiply, 2=Screen, 3=Overlay, 4=SoftLight, 5=Luminosity
    has_mask: u32,    // 0 or 1
    _pad: f32,
};

@group(0) @binding(0) var base_tex: texture_2d<f32>;
@group(0) @binding(1) var layer_tex: texture_2d<f32>;
@group(0) @binding(2) var mask_tex: texture_2d<f32>;
@group(0) @binding(3) var output_tex: texture_storage_2d<rgba8unorm, write>;
@group(0) @binding(4) var<uniform> params: CompositeParams;

fn blend_normal(base: vec3<f32>, layer: vec3<f32>) -> vec3<f32> { return layer; }
fn blend_multiply(base: vec3<f32>, layer: vec3<f32>) -> vec3<f32> { return base * layer; }
fn blend_screen(base: vec3<f32>, layer: vec3<f32>) -> vec3<f32> { return 1.0 - (1.0 - base) * (1.0 - layer); }
fn blend_overlay(base: vec3<f32>, layer: vec3<f32>) -> vec3<f32> {
    return select(
        2.0 * base * layer,
        1.0 - 2.0 * (1.0 - base) * (1.0 - layer),
        base > vec3<f32>(0.5)
    );
}
fn blend_soft_light(base: vec3<f32>, layer: vec3<f32>) -> vec3<f32> {
    return select(
        base - (1.0 - 2.0 * layer) * base * (1.0 - base),
        base + (2.0 * layer - 1.0) * (sqrt(base) - base),
        layer > vec3<f32>(0.5)
    );
}
fn blend_luminosity(base: vec3<f32>, layer: vec3<f32>) -> vec3<f32> {
    let base_lum = dot(base, vec3<f32>(0.299, 0.587, 0.114));
    let layer_lum = dot(layer, vec3<f32>(0.299, 0.587, 0.114));
    return base + vec3<f32>(layer_lum - base_lum);
}

fn apply_blend(base: vec3<f32>, layer: vec3<f32>, mode: u32) -> vec3<f32> {
    switch(mode) {
        case 1u: { return blend_multiply(base, layer); }
        case 2u: { return blend_screen(base, layer); }
        case 3u: { return blend_overlay(base, layer); }
        case 4u: { return blend_soft_light(base, layer); }
        case 5u: { return blend_luminosity(base, layer); }
        default: { return blend_normal(base, layer); }
    }
}

@compute @workgroup_size(16, 16)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
    let dims = textureDimensions(base_tex);
    if (gid.x >= dims.x || gid.y >= dims.y) { return; }
    let p = vec2<i32>(gid.xy);
    let base = textureLoad(base_tex, p, 0);
    let layer = textureLoad(layer_tex, p, 0);

    var mask_val: f32 = 1.0;
    if (params.has_mask == 1u) {
        mask_val = textureLoad(mask_tex, p, 0).r;
    }

    let blended = apply_blend(base.rgb, layer.rgb, params.blend_mode);
    let alpha = mask_val * params.opacity;
    let result = vec4<f32>(mix(base.rgb, blended, alpha), base.a);
    textureStore(output_tex, p, clamp(result, vec4<f32>(0.0), vec4<f32>(1.0)));
}
