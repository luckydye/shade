import init, * as wasm from "../pkg/shade_wasm.js";

let initPromise: Promise<void> | null = null;
let rendererPromise: Promise<void> | null = null;

function ensureWasmReady() {
  if (!initPromise) {
    initPromise = init()
      .then(() => {
        self.postMessage({ type: "ready" });
      })
      .catch((error) => {
        initPromise = null;
        throw error;
      });
  }
  return initPromise;
}

function ensureRendererReady() {
  if (!rendererPromise) {
    rendererPromise = ensureWasmReady()
      .then(() => wasm.init_renderer())
      .then(() => undefined)
      .catch((error) => {
        rendererPromise = null;
        throw error;
      });
  }
  return rendererPromise;
}

function isRecoverableGpuError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes("async map a buffer") ||
    message.includes("createBuffer failed") ||
    message.includes("device lost") ||
    message.includes("GPUDevice")
  );
}

async function retryWithFreshRenderer(action) {
  try {
    return await action();
  } catch (error) {
    if (!isRecoverableGpuError(error)) {
      throw error;
    }
    rendererPromise = null;
    wasm.reset_renderer();
    await ensureRendererReady();
    return action();
  }
}

self.onmessage = async (event: MessageEvent) => {
  const msg = event.data;
  const requestId = typeof msg.requestId === "number" ? msg.requestId : undefined;

  try {
    switch (msg.type) {
      case "init": {
        await ensureWasmReady();
        break;
      }

      case "load_image_encoded": {
        await ensureWasmReady();
        if (!(msg.bytes instanceof ArrayBuffer)) {
          throw new Error("load_image_encoded expects an ArrayBuffer payload");
        }
        const info = await wasm.load_image_encoded(
          new Uint8Array(msg.bytes),
          msg.fileName ?? null,
        );
        self.postMessage({
          type: "image_loaded",
          requestId,
          layerCount: info.layer_count,
          canvasWidth: info.canvas_width,
          canvasHeight: info.canvas_height,
          source_bit_depth: info.source_bit_depth,
        });
        break;
      }

      case "apply_tone": {
        await ensureWasmReady();
        wasm.apply_tone(
          msg.layerIdx,
          msg.exposure,
          msg.contrast,
          msg.blacks,
          msg.whites ?? 0.0,
          msg.highlights,
          msg.shadows,
          msg.gamma ?? 1.0,
        );
        self.postMessage({ type: "tone_applied", requestId });
        break;
      }

      case "apply_color": {
        await ensureWasmReady();
        wasm.apply_color(
          msg.layerIdx,
          msg.saturation,
          msg.vibrancy,
          msg.temperature,
          msg.tint,
        );
        self.postMessage({ type: "color_applied", requestId });
        break;
      }

      case "apply_hsl": {
        await ensureWasmReady();
        wasm.apply_hsl(
          msg.layerIdx,
          msg.red_hue ?? 0,
          msg.red_sat ?? 0,
          msg.red_lum ?? 0,
          msg.green_hue ?? 0,
          msg.green_sat ?? 0,
          msg.green_lum ?? 0,
          msg.blue_hue ?? 0,
          msg.blue_sat ?? 0,
          msg.blue_lum ?? 0,
        );
        self.postMessage({ type: "hsl_applied", requestId });
        break;
      }

      case "apply_curves": {
        await ensureWasmReady();
        await wasm.apply_curves(msg.layerIdx, msg.curve_points ?? []);
        self.postMessage({ type: "curves_applied", requestId });
        break;
      }

      case "apply_ls_curve": {
        await ensureWasmReady();
        await wasm.apply_ls_curve(msg.layerIdx, msg.curve_points ?? []);
        self.postMessage({ type: "ls_curve_applied", requestId });
        break;
      }

      case "apply_vignette": {
        await ensureWasmReady();
        wasm.apply_vignette(msg.layerIdx, msg.vignette_amount ?? 0);
        self.postMessage({ type: "vignette_applied", requestId });
        break;
      }

      case "apply_sharpen": {
        await ensureWasmReady();
        wasm.apply_sharpen(msg.layerIdx, msg.sharpen_amount ?? 0);
        self.postMessage({ type: "sharpen_applied", requestId });
        break;
      }

      case "apply_grain": {
        await ensureWasmReady();
        wasm.apply_grain(msg.layerIdx, msg.grain_amount ?? 0, msg.grain_size ?? 1);
        self.postMessage({ type: "grain_applied", requestId });
        break;
      }

      case "apply_glow": {
        await ensureWasmReady();
        wasm.apply_glow(msg.layerIdx, msg.glow_amount ?? 0);
        self.postMessage({ type: "glow_applied", requestId });
        break;
      }

      case "apply_denoise": {
        await ensureWasmReady();
        wasm.apply_denoise(
          msg.layerIdx,
          msg.denoise_luma_strength ?? 0,
          msg.denoise_chroma_strength ?? 0,
          msg.denoise_mode ?? 0,
        );
        self.postMessage({ type: "denoise_applied", requestId });
        break;
      }

      case "set_layer_visible": {
        await ensureWasmReady();
        wasm.set_layer_visible(msg.layerIdx, msg.visible);
        self.postMessage({ type: "layer_updated", requestId });
        break;
      }

      case "set_layer_opacity": {
        await ensureWasmReady();
        wasm.set_layer_opacity(msg.layerIdx, msg.opacity);
        self.postMessage({ type: "layer_updated", requestId });
        break;
      }

      case "move_layer": {
        await ensureWasmReady();
        const layerIdx = wasm.move_layer(msg.fromIdx, msg.toIdx);
        self.postMessage({ type: "layer_moved", requestId, layerIdx });
        break;
      }

      case "add_layer": {
        await ensureWasmReady();
        const layerIdx = wasm.add_layer(msg.kind);
        self.postMessage({ type: "layer_added", requestId, layerIdx });
        break;
      }

      case "delete_layer": {
        await ensureWasmReady();
        wasm.delete_layer(msg.layerIdx);
        self.postMessage({ type: "layer_deleted", requestId });
        break;
      }

      case "rename_layer": {
        await ensureWasmReady();
        wasm.rename_layer(msg.layerIdx, msg.name ?? null);
        self.postMessage({ type: "layer_renamed", requestId });
        break;
      }

      case "apply_linear_mask": {
        await ensureWasmReady();
        wasm.apply_linear_gradient_mask(msg.layerIdx, msg.x1, msg.y1, msg.x2, msg.y2);
        self.postMessage({ type: "mask_applied", requestId });
        break;
      }

      case "apply_radial_mask": {
        await ensureWasmReady();
        wasm.apply_radial_gradient_mask(msg.layerIdx, msg.cx, msg.cy, msg.radius);
        self.postMessage({ type: "mask_applied", requestId });
        break;
      }

      case "remove_mask": {
        await ensureWasmReady();
        wasm.remove_mask(msg.layerIdx);
        self.postMessage({ type: "mask_removed", requestId });
        break;
      }

      case "create_brush_mask": {
        await ensureWasmReady();
        wasm.create_brush_mask(msg.layerIdx);
        self.postMessage({ type: "mask_applied", requestId });
        break;
      }

      case "stamp_brush_mask": {
        await ensureWasmReady();
        wasm.stamp_brush_mask(
          msg.layerIdx,
          msg.cx,
          msg.cy,
          msg.radius,
          msg.softness,
          msg.erase,
        );
        self.postMessage({ type: "mask_applied", requestId });
        break;
      }

      case "replace_stack": {
        await ensureWasmReady();
        wasm.replace_stack_json(msg.data);
        self.postMessage({ type: "stack_replaced", requestId });
        break;
      }

      case "get_stack_snapshot": {
        await ensureWasmReady();
        const json = wasm.get_stack_snapshot_json();
        self.postMessage({ type: "stack_snapshot", requestId, data: json });
        break;
      }

      case "get_stack": {
        await ensureWasmReady();
        const json = wasm.get_stack_json();
        self.postMessage({ type: "stack", requestId, data: json });
        break;
      }

      case "apply_crop": {
        await ensureWasmReady();
        wasm.apply_crop(
          msg.layerIdx,
          msg.crop_x,
          msg.crop_y,
          msg.crop_width,
          msg.crop_height,
          msg.crop_rotation ?? 0,
        );
        self.postMessage({ type: "crop_applied", requestId });
        break;
      }

      case "render_preview": {
        const frame = await retryWithFreshRenderer(async () => {
          await ensureRendererReady();
          return wasm.render_preview_rgba(msg.request ?? null);
        });
        const pixels =
          frame.pixels instanceof Uint8Array
            ? frame.pixels
            : Uint8Array.from(frame.pixels);
        self.postMessage(
          {
            type: "preview_rendered",
            requestId,
            pixels,
            width: frame.width,
            height: frame.height,
          },
          { transfer: [pixels.buffer as ArrayBuffer] },
        );
        break;
      }

      default: {
        throw new Error(`unsupported worker message: ${String(msg.type)}`);
      }
    }
  } catch (error) {
    self.postMessage({
      type: "error",
      requestId,
      message: error instanceof Error ? error.message : String(error),
    });
  }
};
