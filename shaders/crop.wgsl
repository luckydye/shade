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
  let src_x = u32(clamp(floor(params.x + u * params.width), params.x, params.x + params.width - 1.0));
  let src_y = u32(clamp(floor(params.y + v * params.height), params.y, params.y + params.height - 1.0));
  let color = textureLoad(input_tex, vec2<i32>(i32(src_x), i32(src_y)), 0);
  textureStore(output_tex, vec2<i32>(gid.xy), color);
}
