struct Params {
    input_black: f32,
    input_white: f32,
    output_black: f32,
    output_white: f32,
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

    // Apply levels adjustment
    // First, map input range to 0-1
    let input_range = params.input_white - params.input_black;
    let normalized_color = vec3<f32>(
        (input_color.r - params.input_black) / input_range,
        (input_color.g - params.input_black) / input_range,
        (input_color.b - params.input_black) / input_range
    );

    // Clamp to [0.0, 1.0] range after input mapping
    let clamped_color = clamp(normalized_color, vec3<f32>(0.0), vec3<f32>(1.0));

    // Then, map to output range
    let output_range = params.output_white - params.output_black;
    let adjusted_color = vec4<f32>(
        clamped_color.r * output_range + params.output_black,
        clamped_color.g * output_range + params.output_black,
        clamped_color.b * output_range + params.output_black,
        input_color.a
    );

    // Final clamp to [0.0, 1.0] range
    let final_color = clamp(adjusted_color, vec4<f32>(0.0), vec4<f32>(1.0));

    textureStore(output_texture, coords, final_color);
}
