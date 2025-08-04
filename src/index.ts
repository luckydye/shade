import shader from "./web_shader.wgsl?raw";

async function main() {
  const adapter = await navigator.gpu?.requestAdapter();
  const device = await adapter?.requestDevice();
  if (!device) {
    throw new Error("Unable to find a WebGPU d a browser that supports WebGPU");
  }

  // Get a WebGPU context from the canvas and configure it
  const canvas = document.createElement("canvas");
  canvas.width = 1024;
  canvas.height = 1024;

  document.body.appendChild(canvas);

  const context = canvas.getContext("webgpu");
  const presentationFormat = navigator.gpu.getPreferredCanvasFormat();
  context.configure({
    device,
    format: presentationFormat,
  });

  const module = device.createShaderModule({
    label: "our hardcoded textured quad shaders",
    code: shader,
  });

  const pipeline = device.createRenderPipeline({
    label: "hardcoded textured quad pipeline",
    layout: "auto",
    vertex: {
      module,
    },
    fragment: {
      module,
      targets: [{ format: presentationFormat }],
    },
  });

  const kTextureWidth = 5;
  const kTextureHeight = 7;

  const _ = [255, 0, 0, 255]; // red
  const y = [255, 255, 0, 255]; // yellow
  const b = [0, 0, 255, 255]; // blue
  const textureData = new Uint8Array(
    [
      b,
      _,
      _,
      _,
      _,
      _,
      y,
      y,
      y,
      _,
      _,
      y,
      _,
      _,
      _,
      _,
      y,
      y,
      _,
      _,
      _,
      y,
      _,
      _,
      _,
      _,
      y,
      _,
      _,
      _,
      _,
      _,
      _,
      _,
      _,
    ].flat(),
  );

  const texture = device.createTexture({
    label: "yellow F on red",
    size: [kTextureWidth, kTextureHeight],
    format: "rgba8unorm",
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });
  device.queue.writeTexture(
    { texture },
    textureData,
    { bytesPerRow: kTextureWidth * 4 },
    { width: kTextureWidth, height: kTextureHeight },
  );

  const sampler = device.createSampler();

  const bindGroup = device.createBindGroup({
    layout: pipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: sampler },
      { binding: 1, resource: texture.createView() },
    ],
  });

  const renderPassDescriptor = {
    label: "our basic canvas renderPass",
    colorAttachments: [
      {
        // view: <- to be filled out when we render
        clearValue: [1, 0, 1, 0.2],
        loadOp: "clear",
        storeOp: "store",
      },
    ],
  };

  function render() {
    // Get the current texture from the canvas context and
    // set it as the texture to render to.
    renderPassDescriptor.colorAttachments[0].view = context
      .getCurrentTexture()
      .createView();

    const encoder = device.createCommandEncoder({
      label: "render quad encoder",
    });
    const pass = encoder.beginRenderPass(renderPassDescriptor);
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.draw(6); // call our vertex shader 6 times
    pass.end();

    const commandBuffer = encoder.finish();
    device.queue.submit([commandBuffer]);
  }

  render();
}

main();
