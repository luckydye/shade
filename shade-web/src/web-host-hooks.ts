import type {
  HostHooks,
  NativeDragDropPayload,
  PreviewFrame,
  PreviewRequest,
} from "shade-ui/src/types";
import { browserSnapshotsPlatform } from "shade-wasm/worker/snapshots";
import { applyBrowserPresetLayer } from "./browser-preset-apply";
import { browserLibraryCache } from "./library-cache";
import { browserMediaPlatform } from "./media";
import { getSharedWorker } from "./worker-transport";

// ── Legacy workerCall infrastructure ─────────────────────────────────────────
// Pre-unified-protocol JS↔worker request/response messaging. The Tauri side
// has nothing equivalent — these power the lifecycle ops (open, render, etc.)
// on the web until they migrate to the unified MutationRequest protocol.

let nextWorkerRequestId = 1;
let workerReady = false;
let workerReadyResolve: (() => void) | null = null;
const workerReadyPromise = new Promise<void>((res) => {
  workerReadyResolve = res;
});
interface PendingRequest {
  responseType: string;
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
}
const pendingRequests = new Map<number, PendingRequest>();
let legacyHandlerInstalled = false;

function ensureLegacyHandler() {
  if (legacyHandlerInstalled) return;
  legacyHandlerInstalled = true;
  const worker = getSharedWorker();
  worker.onmessage = (e: MessageEvent) => {
    const msg = e.data;
    if (msg?.type === "ready") {
      workerReady = true;
      workerReadyResolve?.();
      return;
    }
    const requestId =
      typeof msg?.requestId === "number" ? (msg.requestId as number) : null;
    if (requestId === null) return;
    const pending = pendingRequests.get(requestId);
    if (!pending) return;
    pendingRequests.delete(requestId);
    if (msg.type === "error") {
      pending.reject(new Error(String(msg.message ?? "worker request failed")));
      return;
    }
    if (msg.type !== pending.responseType) {
      pending.reject(
        new Error(
          `unexpected worker response: expected ${pending.responseType}, got ${msg.type}`,
        ),
      );
      return;
    }
    pending.resolve(msg);
  };
  worker.postMessage({ type: "init" });
}

function workerCall<T>(
  message: Record<string, unknown>,
  responseType: string,
  transfer: Transferable[] = [],
): Promise<T> {
  ensureLegacyHandler();
  return new Promise((resolve, reject) => {
    const requestId = nextWorkerRequestId++;
    pendingRequests.set(requestId, {
      responseType,
      resolve: resolve as (v: unknown) => void,
      reject,
    });
    getSharedWorker().postMessage({ ...message, requestId }, transfer);
  });
}

async function ensureWorkerReady() {
  ensureLegacyHandler();
  await workerReadyPromise;
}

// ── DOM helpers used by exportImage ──────────────────────────────────────────

function previewFrameToImageData(frame: PreviewFrame): ImageData {
  if (frame.kind === "rgba-float16") {
    return new ImageData(frame.pixels as never, frame.width, frame.height, {
      pixelFormat: "rgba-float16",
      colorSpace: frame.colorSpace,
    } as ImageDataSettings);
  }
  return new ImageData(
    new Uint8ClampedArray(
      frame.pixels.buffer as ArrayBuffer,
      frame.pixels.byteOffset,
      frame.pixels.byteLength,
    ),
    frame.width,
    frame.height,
  );
}

async function imageDataToBlob(image: ImageData) {
  const canvas = document.createElement("canvas");
  canvas.width = image.width;
  canvas.height = image.height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("2d canvas context is unavailable");
  context.putImageData(image, 0, 0);
  const blob = await new Promise<Blob | null>((resolve) => {
    canvas.toBlob(resolve, "image/png");
  });
  if (!blob) throw new Error("failed to encode preview as png");
  return blob;
}

function downloadBlob(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

async function loadEncodedBytes(bytes: ArrayBuffer, fileName?: string) {
  await ensureWorkerReady();
  const result = await workerCall<{
    layerCount: number;
    canvasWidth: number;
    canvasHeight: number;
    source_bit_depth: string;
  }>({ type: "load_image_encoded", bytes, fileName }, "image_loaded", [bytes]);
  return {
    layer_count: result.layerCount,
    canvas_width: result.canvasWidth,
    canvas_height: result.canvasHeight,
    source_bit_depth: result.source_bit_depth,
    fingerprint: null,
  };
}

export const webHostHooks: HostHooks = {
  ...browserLibraryCache,

  async pickDirectory() {
    const win = window as unknown as {
      showDirectoryPicker?: () => Promise<{ name: string }>;
    };
    if (!win.showDirectoryPicker) {
      throw new Error("directory picker is unavailable in this browser");
    }
    const handle = await win.showDirectoryPicker();
    return handle.name;
  },
  async pickExportTarget() {
    const win = window as unknown as {
      showSaveFilePicker?: (opts: Record<string, unknown>) => Promise<{ name: string }>;
    };
    if (!win.showSaveFilePicker) {
      throw new Error("save dialog is unavailable in this browser");
    }
    const handle = await win.showSaveFilePicker({
      types: [
        { description: "PNG Image", accept: { "image/png": [".png"] } },
        { description: "JPEG Image", accept: { "image/jpeg": [".jpg", ".jpeg"] } },
      ],
    });
    return handle.name;
  },
  async listenNativeDragDrop(listener) {
    const drag = (type: NativeDragDropPayload["type"]) => (event: DragEvent) => {
      event.preventDefault();
      const paths: string[] = [];
      if (event.dataTransfer) {
        for (const item of Array.from(event.dataTransfer.files)) {
          paths.push(item.name);
        }
      }
      listener({ type, paths });
    };
    const onEnter = drag("enter");
    const onOver = drag("over");
    const onDrop = drag("drop");
    const onLeave = drag("leave");
    window.addEventListener("dragenter", onEnter);
    window.addEventListener("dragover", onOver);
    window.addEventListener("drop", onDrop);
    window.addEventListener("dragleave", onLeave);
    return () => {
      window.removeEventListener("dragenter", onEnter);
      window.removeEventListener("dragover", onOver);
      window.removeEventListener("drop", onDrop);
      window.removeEventListener("dragleave", onLeave);
    };
  },

  // ── Image lifecycle ─────────────────────────────────────────────────
  async openImage(path) {
    const source = await browserMediaPlatform.getImageSource(path);
    return loadEncodedBytes(source.bytes, source.fileName ?? path);
  },
  async openImageFile(file) {
    const source = await browserMediaPlatform.getImageFileSource(file, file.name);
    return loadEncodedBytes(source.bytes, source.fileName ?? file.name);
  },
  async openPeerImage() {
    throw new Error("peer image loading requires the Tauri runtime");
  },
  async prepareImageOpen(path) {
    return browserMediaPlatform.prepareImageOpen(path);
  },
  async exportImage(path) {
    const stack = await this.getLayerStack();
    const cropLayer = stack.layers.find(
      (layer) => layer.kind === "crop" && layer.visible && layer.crop,
    );
    const crop = cropLayer?.crop;
    const frame = await this.renderPreview({
      target_width: crop?.width ?? stack.canvas_width,
      target_height: crop?.height ?? stack.canvas_height,
      crop: crop
        ? { x: crop.x, y: crop.y, width: crop.width, height: crop.height }
        : undefined,
    });
    const blob = await imageDataToBlob(previewFrameToImageData(frame));
    downloadBlob(blob, path || "shade-export.png");
  },
  async renderPreview(request?: PreviewRequest) {
    await ensureWorkerReady();
    const result = await workerCall<{
      pixels: Uint8Array;
      width: number;
      height: number;
    }>({ type: "render_preview", request }, "preview_rendered");
    if (!(result.pixels instanceof Uint8Array)) {
      throw new Error("preview worker returned pixels in an unexpected format");
    }
    return {
      kind: "rgba",
      pixels: result.pixels,
      width: result.width,
      height: result.height,
    };
  },
  async getLayerStack() {
    await ensureWorkerReady();
    const result = await workerCall<{ data: string }>({ type: "get_stack" }, "stack");
    return JSON.parse(result.data);
  },
  async getMaskThumbnail() {
    throw new Error("getMaskThumbnail is only implemented for Tauri");
  },
  async restoreCurrentBrowserSnapshot(imagePath) {
    const snapshot = await browserSnapshotsPlatform.getCurrentSnapshot(imagePath);
    if (!snapshot) return false;
    for (const layer of snapshot.layers) {
      await applyBrowserPresetLayer(layer);
    }
    return true;
  },
};
