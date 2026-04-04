struct BrushParams {
    center_x: f32,
    center_y: f32,
    radius: f32,
    hardness: f32,   // 0.0 = fully soft, 1.0 = hard edge
    pressure: f32,   // 0.0–1.0 pen pressure
    erase: u32,      // 0 = paint (add), 1 = erase (subtract)
    _pad0: f32,
    _pad1: f32,
};

// Using rgba8unorm for compatibility; mask is stored in R channel only.
@group(0) @binding(0) var mask_tex: texture_storage_2d<rgba8unorm, read_write>;
@group(0) @binding(1) var<uniform> params: BrushParams;

@compute @workgroup_size(16, 16)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
    let dims = textureDimensions(mask_tex);
    if (gid.x >= dims.x || gid.y >= dims.y) { return; }
    let p = vec2<f32>(f32(gid.x), f32(gid.y));
    let dist = length(p - vec2<f32>(params.center_x, params.center_y));
    if (dist > params.radius) { return; }

    let inner = params.radius * params.hardness;
    let brush_alpha = smoothstep(params.radius, inner, dist) * params.pressure;

    let current = textureLoad(mask_tex, vec2<i32>(gid.xy)).r;
    var new_val: f32;
    if (params.erase == 1u) {
        new_val = max(0.0, current - brush_alpha);
    } else {
        new_val = min(1.0, current + brush_alpha);
    }
    textureStore(mask_tex, vec2<i32>(gid.xy), vec4<f32>(new_val, 0.0, 0.0, 1.0));
}
