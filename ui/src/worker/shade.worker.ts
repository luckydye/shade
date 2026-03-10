// This worker loads the Shade WASM module and processes commands
// from the main thread. The OffscreenCanvas is transferred here.
// The WASM module is built separately via `scripts/build-wasm.sh` (wasm-pack).

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let wasm: any = null;

// Message protocol:
// { type: "init" } → { type: "ready" }
// { type: "load_image", pixels: Uint8Array, width: number, height: number } → { type: "image_loaded", layerCount: number }
// { type: "apply_tone", layerIdx: number, exposure: number, ... } → { type: "tone_applied" }
// { type: "get_stack" } → { type: "stack", data: string }

self.onmessage = async (e: MessageEvent) => {
  const msg = e.data;

  switch (msg.type) {
    case "init": {
      try {
        // Dynamic import of the WASM module (built via scripts/build-wasm.sh).
        // @vite-ignore suppresses Vite's static resolution — the file is generated at build time.
        wasm = await import(/* @vite-ignore */ "../../wasm/shade_wasm.js");
        await wasm.default?.();
        self.postMessage({ type: "ready" });
      } catch (err) {
        self.postMessage({ type: "error", message: String(err) });
      }
      break;
    }

    case "load_image": {
      if (!wasm) { self.postMessage({ type: "error", message: "WASM not initialised" }); return; }
      const id = wasm.load_image(msg.pixels, msg.width, msg.height);
      const count = wasm.get_layer_count();
      self.postMessage({ type: "image_loaded", textureId: id, layerCount: count });
      break;
    }

    case "apply_tone": {
      if (!wasm) return;
      wasm.apply_tone(msg.layerIdx, msg.exposure, msg.contrast, msg.blacks, msg.highlights, msg.shadows);
      self.postMessage({ type: "tone_applied" });
      break;
    }

    case "apply_color": {
      if (!wasm) return;
      wasm.apply_color(msg.layerIdx, msg.saturation, msg.vibrancy, msg.temperature, msg.tint);
      self.postMessage({ type: "color_applied" });
      break;
    }

    case "set_layer_visible": {
      if (!wasm) return;
      wasm.set_layer_visible(msg.layerIdx, msg.visible);
      self.postMessage({ type: "layer_updated" });
      break;
    }

    case "set_layer_opacity": {
      if (!wasm) return;
      wasm.set_layer_opacity(msg.layerIdx, msg.opacity);
      self.postMessage({ type: "layer_updated" });
      break;
    }

    case "get_stack": {
      if (!wasm) return;
      const json = wasm.get_stack_json();
      self.postMessage({ type: "stack", data: json });
      break;
    }

    default:
      self.postMessage({ type: "error", message: `unknown message type: ${msg.type}` });
  }
};
