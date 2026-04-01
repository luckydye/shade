// This worker loads the Shade WASM module and processes commands
// from the main thread. The OffscreenCanvas is transferred here.
// The WASM module is built separately via `scripts/build-wasm.sh` (wasm-pack).

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let wasm: any = null;

let offscreenCanvas: OffscreenCanvas | null = null;
let offscreenCtx: OffscreenCanvasRenderingContext2D | null = null;
let initPromise: Promise<void> | null = null;
let rendererPromise: Promise<void> | null = null;

function ensureWasmReady() {
  if (wasm) {
    return Promise.resolve();
  }
  if (!initPromise) {
    initPromise = (async () => {
      // Dynamic import of the WASM module (built via scripts/build-wasm.sh).
      // @vite-ignore suppresses Vite's static resolution — the file is generated at build time.
      wasm = await import(/* @vite-ignore */ "../../wasm/shade_wasm.js");
      await wasm.default?.();
      self.postMessage({ type: "ready" });
    })().catch((error) => {
      initPromise = null;
      wasm = null;
      throw error;
    });
  }
  return initPromise;
}

function ensureRendererReady() {
  if (rendererPromise) {
    return rendererPromise;
  }
  rendererPromise = ensureWasmReady()
    .then(() => wasm.init_renderer())
    .then(() => undefined)
    .catch((error) => {
      rendererPromise = null;
      throw error;
    });
  return rendererPromise;
}

// Message protocol:
// { type: "init" } → { type: "ready" }
// { type: "load_image_encoded", bytes: Uint8Array, fileName?: string } → { type: "image_loaded", layerCount: number, canvasWidth: number, canvasHeight: number }
// { type: "apply_tone", layerIdx: number, exposure: number, ... } → { type: "tone_applied" }
// { type: "get_stack" } → { type: "stack", data: string }

self.onmessage = async (e: MessageEvent) => {
  const msg = e.data;
  const requestId = typeof msg.requestId === "number" ? msg.requestId : undefined;

  try {
    switch (msg.type) {
      case "init": {
        await ensureWasmReady();
        break;
      }

      case "set_canvas": {
        offscreenCanvas = msg.canvas as OffscreenCanvas;
        offscreenCtx = offscreenCanvas.getContext("2d") as OffscreenCanvasRenderingContext2D;
        break;
      }

      case "load_image_encoded": {
        await ensureWasmReady();
        const info = await wasm.load_image_encoded(msg.bytes, msg.fileName ?? null);
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
        await ensureRendererReady();
        const frame = await wasm.render_preview_rgba(msg.request ?? null);
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

      case "render_frame": {
        await ensureRendererReady();
        if (!offscreenCanvas || !offscreenCtx) {
          throw new Error("offscreen canvas not initialised — call set_canvas first");
        }
        const dpr = (msg.devicePixelRatio as number) || 1;
        const canvasPixelWidth = msg.canvasPixelWidth as number;
        const canvasPixelHeight = msg.canvasPixelHeight as number;

        if (offscreenCanvas.width !== canvasPixelWidth) {
          offscreenCanvas.width = canvasPixelWidth;
        }
        if (offscreenCanvas.height !== canvasPixelHeight) {
          offscreenCanvas.height = canvasPixelHeight;
        }

        // Reset to identity and clear
        offscreenCtx.setTransform(1, 0, 0, 1, 0, 0);
        offscreenCtx.clearRect(0, 0, canvasPixelWidth, canvasPixelHeight);

        // Scale context so we can draw in CSS pixel coordinates
        offscreenCtx.setTransform(dpr, 0, 0, dpr, 0, 0);

        offscreenCtx.save();

        // Apply committed-crop clip (axis-aligned clip + optional counter-rotation)
        const clip = msg.clip as {
          x: number; y: number; w: number; h: number; rotation: number;
        } | null;
        if (clip) {
          const clipPath = new Path2D();
          clipPath.rect(clip.x, clip.y, clip.w, clip.h);
          offscreenCtx.clip(clipPath);
          if (clip.rotation !== 0) {
            const scx = clip.x + clip.w / 2;
            const scy = clip.y + clip.h / 2;
            offscreenCtx.translate(scx, scy);
            offscreenCtx.rotate(-clip.rotation);
            offscreenCtx.translate(-scx, -scy);
          }
        }

        // Renders one WASM tile and blits it onto offscreenCtx at the given CSS-pixel destination.
        const renderTile = async (tile: {
          request: unknown;
          destX: number;
          destY: number;
          destW: number;
          destH: number;
        }) => {
          const frame = await wasm.render_preview_rgba(tile.request ?? null);
          const pixels: Uint8Array =
            frame.pixels instanceof Uint8Array
              ? frame.pixels
              : Uint8Array.from(frame.pixels);
          const clamped = new Uint8ClampedArray(
            pixels.buffer,
            pixels.byteOffset,
            pixels.byteLength,
          );
          const imageData = new ImageData(clamped, frame.width, frame.height);
          const tmp = new OffscreenCanvas(frame.width, frame.height);
          const tmpCtx = tmp.getContext("2d")!;
          tmpCtx.putImageData(imageData, 0, 0);
          offscreenCtx!.imageSmoothingEnabled = true;
          offscreenCtx!.imageSmoothingQuality = "high";
          offscreenCtx!.drawImage(tmp, tile.destX, tile.destY, tile.destW, tile.destH);
        };

        if (msg.backdrop) await renderTile(msg.backdrop as Parameters<typeof renderTile>[0]);
        if (msg.preview) await renderTile(msg.preview as Parameters<typeof renderTile>[0]);

        offscreenCtx.restore();
        self.postMessage({ type: "frame_rendered", requestId });
        break;
      }

      default:
        throw new Error(`unknown message type: ${msg.type}`);
    }
  } catch (error) {
    self.postMessage({
      type: "error",
      requestId,
      message: error instanceof Error ? error.message : String(error),
    });
  }
};
