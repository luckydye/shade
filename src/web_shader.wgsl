struct OurVertexShaderOutput {
  @builtin(position) position: vec4f,
  @location(0) texcoord: vec2f,
};

@vertex fn vs(
  @builtin(vertex_index) vertexIndex : u32
) -> OurVertexShaderOutput {
  let pos = array(
    // 1st triangle
    vec2f(0.0, 0.0), // center
    vec2f(1.0, 0.0), // right, center
    vec2f(0.0, 1.0), // center, top

    // 2st triangl
    vec2f(0.0, 1.0), // center, top
    vec2f(1.0, 0.0), // right, center
    vec2f(1.0, 1.0), // right, top
  );

  var vsOutput: OurVertexShaderOutput;
  let xy = pos[vertexIndex];
  vsOutput.position = vec4f(xy, 0.0, 1.0);
  vsOutput.texcoord = xy;
  return vsOutput;
}

@group(0) @binding(0) var ourSampler: sampler;
@group(0) @binding(1) var ourTexture: texture_2d<f32>;

@fragment fn fs(fsInput: OurVertexShaderOutput) -> @location(0) vec4f {
  var color = textureSample(ourTexture, ourSampler, fsInput.texcoord);

  color *= 0.2;

  return color;
}
