/**
 * Unified bridge: uses Tauri IPC when running as a desktop app,
 * falls back to WASM worker when running in the browser.
 */

// ── Tauri path ──────────────────────────────────────────────────────────────
type InvokeFn = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
type IsTauriFn = () => boolean;
let _invoke: InvokeFn | null = null;
let _isTauri: IsTauriFn | null = null;

async function isTauriRuntime() {
  if (_isTauri) return _isTauri();
  const { isTauri } = await import("@tauri-apps/api/core");
  _isTauri = isTauri as IsTauriFn;
  return _isTauri();
}

async function getTauriInvoke() {
  if (!_invoke) {
    const { invoke } = await import("@tauri-apps/api/core");
    _invoke = invoke as unknown as InvokeFn;
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
  layers: LayerInfo[];
  canvas_width: number;
  canvas_height: number;
  generation: number;
}

export interface OpenImageInfo {
  layer_count: number;
  canvas_width: number;
  canvas_height: number;
  source_bit_depth: string;
}

export interface ToneValues {
  exposure: number;
  contrast: number;
  blacks: number;
  whites: number;
  highlights: number;
  shadows: number;
  gamma: number;
}

export interface ColorValues {
  saturation: number;
  temperature: number;
  tint: number;
}

export interface HslValues {
  red_hue: number; red_sat: number; red_lum: number;
  green_hue: number; green_sat: number; green_lum: number;
  blue_hue: number; blue_sat: number; blue_lum: number;
}

export interface AdjustmentValues {
  tone: ToneValues | null;
  curves: CurvesValues | null;
  color: ColorValues | null;
  vignette: { amount: number } | null;
  sharpen: { amount: number } | null;
  grain: { amount: number } | null;
  hsl: HslValues | null;
}

export interface CurvesValues {
  lut_r: number[];
  lut_g: number[];
  lut_b: number[];
  lut_master: number[];
  per_channel: boolean;
}

export interface LayerInfo {
  kind: string;
  visible: boolean;
  opacity: number;
  blend_mode?: string;
  adjustments?: AdjustmentValues | null;
  crop?: CropValues | null;
}

export interface CropValues {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type PreviewFrame =
  | { kind: "rgba"; pixels: Uint8Array; width: number; height: number }
  | { kind: "rgba-float16"; pixels: unknown; width: number; height: number; colorSpace: "display-p3" };

export interface PreviewCrop {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PreviewRequest {
  target_width: number;
  target_height: number;
  crop?: PreviewCrop;
}

type Float16ArrayCtor = new (buffer: ArrayBufferLike) => unknown;

let float16PreviewSupport: boolean | null = null;

function supportsFloat16Preview() {
  if (float16PreviewSupport !== null) return float16PreviewSupport;
  const Float16 = (globalThis as any).Float16Array as Float16ArrayCtor | undefined;
  if (typeof ImageData === "undefined" || !Float16) {
    float16PreviewSupport = false;
    return false;
  }
  try {
    const probe = new Float16(new Uint16Array(4).buffer);
    new ImageData(probe as any, 1, 1, {
      pixelFormat: "rgba-float16",
      colorSpace: "display-p3",
    } as any);
    float16PreviewSupport = true;
  } catch {
    float16PreviewSupport = false;
  }
  return float16PreviewSupport;
}

export async function renderPreview(request?: PreviewRequest): Promise<PreviewFrame> {
  if (await isTauriRuntime()) {
    const inv = await getTauriInvoke();
    if (supportsFloat16Preview()) {
      const Float16 = (globalThis as any).Float16Array as Float16ArrayCtor;
      const result = await inv("render_preview_float16", { request }) as {
        pixels: number[] | Uint16Array | ArrayBuffer;
        width: number;
        height: number;
      };
      const words = result.pixels instanceof Uint16Array
        ? result.pixels
        : result.pixels instanceof ArrayBuffer
          ? new Uint16Array(result.pixels)
          : Uint16Array.from(result.pixels);
      return {
        kind: "rgba-float16",
        pixels: new Float16(words.buffer.slice(0)),
        width: result.width,
        height: result.height,
        colorSpace: "display-p3",
      };
    }
    const result = await inv("render_preview", { request }) as {
      pixels: number[] | Uint8Array | ArrayBuffer;
      width: number;
      height: number;
    };
    const pixels = result.pixels instanceof Uint8Array
      ? result.pixels
      : result.pixels instanceof ArrayBuffer
        ? new Uint8Array(result.pixels)
        : Uint8Array.from(result.pixels);
    return {
      kind: "rgba",
      pixels,
      width: result.width,
      height: result.height,
    };
  }
  await ensureWorkerReady();
  const result = await workerCall<{ pixels: Uint8Array | number[]; width: number; height: number }>(
    { type: "render_preview", request },
    "preview_rendered"
  );
  return {
    kind: "rgba",
    pixels: result.pixels instanceof Uint8Array ? result.pixels : Uint8Array.from(result.pixels),
    width: result.width,
    height: result.height,
  };
}

export async function openImage(path: string): Promise<OpenImageInfo> {
  if (await isTauriRuntime()) {
    const inv = await getTauriInvoke();
    return inv("open_image", { path }) as Promise<any>;
  }
  await ensureWorkerReady();
  const response = await fetch(path);
  return _loadEncodedBytes(new Uint8Array(await response.arrayBuffer()), path);
}

/** Open an image from a File object — works for both file picker and drag-and-drop. */
export async function openImageFile(file: File): Promise<OpenImageInfo> {
  if (await isTauriRuntime()) {
    const inv = await getTauriInvoke();
    const bytes = Array.from(new Uint8Array(await file.arrayBuffer()));
    return inv("open_image_encoded_bytes", { bytes, file_name: file.name }) as Promise<any>;
  }
  return _loadEncodedBytes(new Uint8Array(await file.arrayBuffer()), file.name);
}

async function _loadEncodedBytes(
  bytes: Uint8Array,
  fileName?: string,
): Promise<OpenImageInfo> {
  const result = await workerCall<{ layerCount: number; canvasWidth: number; canvasHeight: number; source_bit_depth: string }>(
    { type: "load_image_encoded", bytes, fileName },
    "image_loaded"
  );
  return {
    layer_count: result.layerCount,
    canvas_width: result.canvasWidth,
    canvas_height: result.canvasHeight,
    source_bit_depth: result.source_bit_depth,
  };
}

export async function getLayerStack(): Promise<StackInfo> {
  if (await isTauriRuntime()) {
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
  if (await isTauriRuntime()) {
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
    case "hsl":
      await workerCall({ type: "apply_hsl", layerIdx: layer_idx, ...rest }, "hsl_applied");
      break;
  }
}

export async function setLayerVisible(idx: number, visible: boolean): Promise<void> {
  if (await isTauriRuntime()) {
    const inv = await getTauriInvoke();
    await inv("set_layer_visible", { params: { layer_idx: idx, visible } });
    return;
  }
  await ensureWorkerReady();
  await workerCall({ type: "set_layer_visible", layerIdx: idx, visible }, "layer_updated");
}

export async function setLayerOpacity(idx: number, opacity: number): Promise<void> {
  if (await isTauriRuntime()) {
    const inv = await getTauriInvoke();
    await inv("set_layer_opacity", { params: { layer_idx: idx, opacity } });
    return;
  }
  await ensureWorkerReady();
  await workerCall({ type: "set_layer_opacity", layerIdx: idx, opacity }, "layer_updated");
}

/** Returns a JPEG blob URL for any image format including EXR and RAW. Caller owns the URL (call URL.revokeObjectURL when done). */
export async function getThumbnail(path: string): Promise<string> {
  if (await isTauriRuntime()) {
    const inv = await getTauriInvoke();
    const result = await inv("get_thumbnail", { path }) as number[] | Uint8Array | ArrayBuffer;
    const bytes = result instanceof Uint8Array
      ? result
      : result instanceof ArrayBuffer
        ? new Uint8Array(result)
        : Uint8Array.from(result as number[]);
    return URL.createObjectURL(new Blob([bytes], { type: "image/jpeg" }));
  }
  return "";
}

export async function listPictures(): Promise<string[]> {
  if (await isTauriRuntime()) {
    const inv = await getTauriInvoke();
    return inv("list_pictures") as Promise<string[]>;
  }
  return [];
}

export async function addLayer(kind: string): Promise<number> {
  if (await isTauriRuntime()) {
    const inv = await getTauriInvoke();
    return inv("add_layer", { kind }) as Promise<number>;
  }
  // Web: not yet implemented for WASM (layer add would go via worker)
  return 0;
}
