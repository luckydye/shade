/**
 * Unified bridge: uses Tauri IPC when running as a desktop app,
 * falls back to WASM worker when running in the browser.
 */

const IS_TAURI = typeof (window as any).__TAURI__ !== "undefined";

// ── Tauri path ──────────────────────────────────────────────────────────────
let _invoke: ((cmd: string, args?: Record<string, unknown>) => Promise<unknown>) | null = null;

async function getTauriInvoke() {
  if (!_invoke) {
    const { invoke } = await import("@tauri-apps/api/core");
    _invoke = invoke as typeof _invoke;
  }
  return _invoke!;
}

// ── WASM worker path ─────────────────────────────────────────────────────────
let worker: Worker | null = null;
let pendingResolvers: Map<string, (value: unknown) => void> = new Map();
let workerReady = false;
let workerReadyResolve: (() => void) | null = null;
const workerReadyPromise = new Promise<void>((res) => { workerReadyResolve = res; });

function getWorker(): Worker {
  if (!worker) {
    worker = new Worker(new URL("../worker/shade.worker.ts", import.meta.url), { type: "module" });
    worker.onmessage = (e: MessageEvent) => {
      const msg = e.data;
      if (msg.type === "ready") {
        workerReady = true;
        workerReadyResolve?.();
      }
      const resolver = pendingResolvers.get(msg.type);
      if (resolver) {
        pendingResolvers.delete(msg.type);
        resolver(msg);
      }
    };
    worker.postMessage({ type: "init" });
  }
  return worker;
}

function workerCall<T>(message: Record<string, unknown>, responseType: string): Promise<T> {
  return new Promise((resolve) => {
    pendingResolvers.set(responseType, resolve as (v: unknown) => void);
    getWorker().postMessage(message);
  });
}

async function ensureWorkerReady() {
  getWorker();
  await workerReadyPromise;
}

// ── Public API ───────────────────────────────────────────────────────────────

export interface StackInfo {
  layers: Array<{ kind: string; visible: boolean; opacity: number }>;
  canvas_width: number;
  canvas_height: number;
  generation: number;
}

export async function openImage(path: string): Promise<{ layer_count: number; canvas_width: number; canvas_height: number }> {
  if (IS_TAURI) {
    const inv = await getTauriInvoke();
    return inv("open_image", { path }) as Promise<any>;
  }
  // Web: fetch the file, decode to RGBA8, send to worker
  await ensureWorkerReady();
  const response = await fetch(path);
  const blob = await response.blob();
  const bitmap = await createImageBitmap(blob);
  const offscreen = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx2d = offscreen.getContext("2d")!;
  ctx2d.drawImage(bitmap, 0, 0);
  const imageData = ctx2d.getImageData(0, 0, bitmap.width, bitmap.height);
  const result = await workerCall<any>(
    { type: "load_image", pixels: imageData.data, width: bitmap.width, height: bitmap.height },
    "image_loaded"
  );
  return { layer_count: result.layerCount, canvas_width: bitmap.width, canvas_height: bitmap.height };
}

export async function getLayerStack(): Promise<StackInfo> {
  if (IS_TAURI) {
    const inv = await getTauriInvoke();
    return inv("get_layer_stack") as Promise<StackInfo>;
  }
  await ensureWorkerReady();
  const result = await workerCall<{ data: string }>(
    { type: "get_stack" },
    "stack"
  );
  return JSON.parse(result.data) as StackInfo;
}

export async function applyEdit(params: Record<string, unknown>): Promise<void> {
  if (IS_TAURI) {
    const inv = await getTauriInvoke();
    await inv("apply_edit", { params });
    return;
  }
  await ensureWorkerReady();
  const { op, layer_idx, ...rest } = params;
  switch (op) {
    case "tone":
      await workerCall({ type: "apply_tone", layerIdx: layer_idx, ...rest }, "tone_applied");
      break;
    case "color":
      await workerCall({ type: "apply_color", layerIdx: layer_idx, ...rest }, "color_applied");
      break;
  }
}

export async function setLayerVisible(idx: number, visible: boolean): Promise<void> {
  if (IS_TAURI) {
    const inv = await getTauriInvoke();
    await inv("set_layer_visible", { params: { layer_idx: idx, visible } });
    return;
  }
  await ensureWorkerReady();
  await workerCall({ type: "set_layer_visible", layerIdx: idx, visible }, "layer_updated");
}

export async function setLayerOpacity(idx: number, opacity: number): Promise<void> {
  if (IS_TAURI) {
    const inv = await getTauriInvoke();
    await inv("set_layer_opacity", { params: { layer_idx: idx, opacity } });
    return;
  }
  await ensureWorkerReady();
  await workerCall({ type: "set_layer_opacity", layerIdx: idx, opacity }, "layer_updated");
}

export async function addLayer(kind: string): Promise<number> {
  if (IS_TAURI) {
    const inv = await getTauriInvoke();
    return inv("add_layer", { kind }) as Promise<number>;
  }
  // Web: not yet implemented for WASM (layer add would go via worker)
  return 0;
}
