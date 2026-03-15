struct CropParams {
  x: f32,
  y: f32,
  width: f32,
  height: f32,
  target_width: f32,
  target_height: f32,
  _pad0: f32,
  _pad1: f32,
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

  let u = (f32(gid.x) + 0.5) / params.target_width;
  let v = (f32(gid.y) + 0.5) / params.target_height;
  let src_x = clamp(params.x + u * params.width - 0.5, params.x, params.x + params.width - 1.0);
  let src_y = clamp(params.y + v * params.height - 0.5, params.y, params.y + params.height - 1.0);
  let x0 = u32(floor(src_x));
  let y0 = u32(floor(src_y));
  let x1 = min(x0 + 1u, u32(params.x + params.width - 1.0));
  let y1 = min(y0 + 1u, u32(params.y + params.height - 1.0));
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
