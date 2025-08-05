struct Params {
    value: f32,
}

@group(0) @binding(0)
var input_texture: texture_2d<f32>;

@group(0) @binding(1)
var output_texture: texture_storage_2d<rgba32float, write>;

@group(0) @binding(2)
var<uniform> params: Params;

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) global_id: vec3<u32>) {
    let dimensions = textureDimensions(input_texture);
    let coords = vec2<i32>(i32(global_id.x), i32(global_id.y));

    if (global_id.x >= dimensions.x || global_id.y >= dimensions.y) {
        return;
    }

    let input_color = textureLoad(input_texture, coords, 0);

    // Apply gamma correction
    // Gamma formula: color^(1/gamma)
    let gamma_value = max(params.value, 0.01); // Prevent division by zero
    let inv_gamma = 1.0 / gamma_value;

    let adjusted_color = vec4<f32>(
        pow(input_color.r, inv_gamma),
        pow(input_color.g, inv_gamma),
        pow(input_color.b, inv_gamma),
        input_color.a
    );

    // Clamp to [0.0, 1.0] range
    let final_color = clamp(adjusted_color, vec4<f32>(0.0), vec4<f32>(1.0));

    textureStore(output_texture, coords, final_color);
}
