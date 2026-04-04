struct CropParams {
  out_x: f32,
  out_y: f32,
  out_width: f32,
  out_height: f32,
  pivot_x: f32,
  pivot_y: f32,
  in_x: f32,
  in_y: f32,
  in_width: f32,
  in_height: f32,
  cos_r: f32,
  sin_r: f32,
}

@group(0) @binding(0) var input_tex: texture_2d<f32>;
@group(0) @binding(1) var output_tex: texture_storage_2d<rgba16float, write>;
@group(0) @binding(2) var<uniform> params: CropParams;

@compute @workgroup_size(16, 16, 1)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let out_size = textureDimensions(output_tex);
  if (gid.x >= out_size.x || gid.y >= out_size.y) {
    return;
  }

  let in_size = textureDimensions(input_tex);

  // Output pixel → normalised UV → canvas position.
  let u = (f32(gid.x) + 0.5) / f32(out_size.x);
  let v = (f32(gid.y) + 0.5) / f32(out_size.y);
  let canvas_x = params.out_x + u * params.out_width;
  let canvas_y = params.out_y + v * params.out_height;

  // Rotate around crop pivot in canvas space.
  let dx = canvas_x - params.pivot_x;
  let dy = canvas_y - params.pivot_y;
  let rot_x = params.pivot_x + dx * params.cos_r + dy * params.sin_r;
  let rot_y = params.pivot_y - dx * params.sin_r + dy * params.cos_r;

  // Canvas position → input texture pixel coordinate.
  let src_x = clamp(
    (rot_x - params.in_x) / params.in_width * f32(in_size.x) - 0.5,
    0.0, f32(in_size.x) - 1.0,
  );
  let src_y = clamp(
    (rot_y - params.in_y) / params.in_height * f32(in_size.y) - 0.5,
    0.0, f32(in_size.y) - 1.0,
  );

  // Bilinear interpolation.
  let x0 = u32(floor(src_x));
  let y0 = u32(floor(src_y));
  let x1 = min(x0 + 1u, u32(in_size.x) - 1u);
  let y1 = min(y0 + 1u, u32(in_size.y) - 1u);
  let wx = src_x - f32(x0);
  let wy = src_y - f32(y0);
  let top_left = textureLoad(input_tex, vec2<i32>(i32(x0), i32(y0)), 0);
  let top_right = textureLoad(input_tex, vec2<i32>(i32(x1), i32(y0)), 0);
  let bottom_left = textureLoad(input_tex, vec2<i32>(i32(x0), i32(y1)), 0);
  let bottom_right = textureLoad(input_tex, vec2<i32>(i32(x1), i32(y1)), 0);
  let top = top_left * (1.0 - wx) + top_right * wx;
  let bottom = bottom_left * (1.0 - wx) + bottom_right * wx;
  let color = top * (1.0 - wy) + bottom * wy;
  textureStore(output_tex, vec2<i32>(gid.xy), color);
}
