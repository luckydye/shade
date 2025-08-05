struct Params {
    angle: f32,
}

@group(0) @binding(0)
var input_texture: texture_2d<f32>;

@group(0) @binding(1)
var output_texture: texture_storage_2d<rgba32float, write>;

@group(0) @binding(2)
var<uniform> params: Params;

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) global_id: vec3<u32>) {
    let output_dimensions = textureDimensions(output_texture);
    let input_dimensions = textureDimensions(input_texture);
    let coords = vec2<i32>(i32(global_id.x), i32(global_id.y));

    if (global_id.x >= output_dimensions.x || global_id.y >= output_dimensions.y) {
        return;
    }

    // Calculate normalized coordinates [0, 1] centered at (0.5, 0.5)
    let normalized_coords = vec2<f32>(f32(global_id.x), f32(global_id.y)) / vec2<f32>(f32(output_dimensions.x), f32(output_dimensions.y));
    let centered_coords = normalized_coords - vec2<f32>(0.5, 0.5);

    // Convert angle from degrees to radians
    let angle_rad = params.angle * 3.14159265359 / 180.0;
    let cos_angle = cos(angle_rad);
    let sin_angle = sin(angle_rad);

    // Apply rotation matrix (inverse rotation to find source pixel)
    let rotated_coords = vec2<f32>(
        centered_coords.x * cos_angle + centered_coords.y * sin_angle,
        -centered_coords.x * sin_angle + centered_coords.y * cos_angle
    );

    // Convert back to texture coordinates
    let source_normalized = rotated_coords + vec2<f32>(0.5, 0.5);
    let source_coords = source_normalized * vec2<f32>(f32(input_dimensions.x), f32(input_dimensions.y));
    let source_int_coords = vec2<i32>(i32(source_coords.x), i32(source_coords.y));

    var final_color = vec4<f32>(0.0, 0.0, 0.0, 0.0); // Default to transparent black

    // Check if source coordinates are within bounds
    if (source_int_coords.x >= 0 && source_int_coords.x < i32(input_dimensions.x) &&
        source_int_coords.y >= 0 && source_int_coords.y < i32(input_dimensions.y)) {

        // Simple nearest neighbor sampling
        final_color = textureLoad(input_texture, source_int_coords, 0);

        // Optional: Bilinear interpolation for better quality
        let frac_coords = fract(source_coords);
        if (source_int_coords.x + 1 < i32(input_dimensions.x) && source_int_coords.y + 1 < i32(input_dimensions.y)) {
            let tl = textureLoad(input_texture, source_int_coords, 0);
            let tr = textureLoad(input_texture, source_int_coords + vec2<i32>(1, 0), 0);
            let bl = textureLoad(input_texture, source_int_coords + vec2<i32>(0, 1), 0);
            let br = textureLoad(input_texture, source_int_coords + vec2<i32>(1, 1), 0);

            let top = mix(tl, tr, frac_coords.x);
            let bottom = mix(bl, br, frac_coords.x);
            final_color = mix(top, bottom, frac_coords.y);
        }
    }

    textureStore(output_texture, coords, final_color);
}
