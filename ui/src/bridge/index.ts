/**
 * Unified bridge: uses Tauri IPC when running as a desktop app,
 * falls back to WASM worker when running in the browser.
 */

import {
  addBrowserMediaLibrary,
  getBrowserMountedThumbnailBytes,
  isBrowserMountedLibrary,
  isBrowserMountedPath,
  listBrowserLibraryImages,
  listBrowserMediaLibraries,
  openBrowserMountedImage,
  pickBrowserDirectory,
  removeBrowserMediaLibrary,
} from "../browser-media-library";
import type { BrowserDirectoryHandle } from "../browser-media-library";

// ── Tauri path ──────────────────────────────────────────────────────────────
type InvokeFn = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
type IsTauriFn = () => boolean;
let _invoke: InvokeFn | null = null;
let _isTauri: IsTauriFn | null = null;

export async function isTauriRuntime() {
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
let nextWorkerRequestId = 1;
let pendingRequests = new Map<
  number,
  {
    responseType: string;
    resolve: (value: unknown) => void;
    reject: (reason: unknown) => void;
  }
>();
let workerReady = false;
let workerReadyResolve: (() => void) | null = null;
const workerReadyPromise = new Promise<void>((res) => {
  workerReadyResolve = res;
});

function getWorker(): Worker {
  if (!worker) {
    worker = new Worker(new URL("../worker/shade.worker.ts", import.meta.url), {
      type: "module",
    });
    worker.onmessage = (e: MessageEvent) => {
      const msg = e.data;
      if (msg.type === "ready") {
        workerReady = true;
        workerReadyResolve?.();
        return;
      }
      const requestId =
        typeof msg.requestId === "number" ? (msg.requestId as number) : null;
      if (requestId === null) {
        return;
      }
      const pending = pendingRequests.get(requestId);
      if (!pending) {
        return;
      }
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
  return worker;
}

function workerCall<T>(
  message: Record<string, unknown>,
  responseType: string,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const requestId = nextWorkerRequestId;
    nextWorkerRequestId += 1;
    pendingRequests.set(requestId, {
      responseType,
      resolve: resolve as (v: unknown) => void,
      reject,
    });
    getWorker().postMessage({ ...message, requestId });
  });
}

async function ensureWorkerReady() {
  getWorker();
  await workerReadyPromise;
}

function previewFrameToImageData(frame: PreviewFrame) {
  if (frame.kind === "rgba-float16") {
    return new ImageData(frame.pixels as any, frame.width, frame.height, {
      pixelFormat: "rgba-float16",
      colorSpace: frame.colorSpace,
    } as any);
  }
  return new ImageData(
    new Uint8ClampedArray(
      frame.pixels.buffer,
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
  if (!context) {
    throw new Error("2d canvas context is unavailable");
  }
  context.putImageData(image, 0, 0);
  const blob = await new Promise<Blob | null>((resolve) => {
    canvas.toBlob(resolve, "image/png");
  });
  if (!blob) {
    throw new Error("failed to encode preview as png");
  }
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

export interface LocalPeer {
  endpoint_id: string;
  direct_addresses: string[];
  last_updated: number | null;
}

export interface LocalPeerDiscoverySnapshot {
  local_endpoint_id: string;
  local_direct_addresses: string[];
  peers: LocalPeer[];
}

export interface SharedPicture {
  id: string;
  name: string;
  modified_at: number | null;
}

export interface LibraryImageMetadata {
  has_snapshots: boolean;
}

export interface LibraryImage {
  path: string;
  name: string;
  modified_at: number | null;
  metadata: LibraryImageMetadata;
}

export interface LibraryImageListing {
  items: LibraryImage[];
  is_complete: boolean;
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
  vibrancy: number;
  temperature: number;
  tint: number;
}

export interface HslValues {
  red_hue: number;
  red_sat: number;
  red_lum: number;
  green_hue: number;
  green_sat: number;
  green_lum: number;
  blue_hue: number;
  blue_sat: number;
  blue_lum: number;
}

export interface CurveControlPoint {
  x: number;
  y: number;
}

export interface AdjustmentValues {
  tone: ToneValues | null;
  curves: CurvesValues | null;
  color: ColorValues | null;
  vignette: { amount: number } | null;
  sharpen: { amount: number } | null;
  grain: { amount: number; size: number } | null;
  hsl: HslValues | null;
  denoise: { luma_strength: number; chroma_strength: number; mode: number } | null;
}

export interface CurvesValues {
  lut_r: number[];
  lut_g: number[];
  lut_b: number[];
  lut_master: number[];
  per_channel: boolean;
  control_points?: CurveControlPoint[] | null;
}

export interface MaskParamsInfo {
  kind: "linear" | "radial";
  x1?: number | null;
  y1?: number | null;
  x2?: number | null;
  y2?: number | null;
  cx?: number | null;
  cy?: number | null;
  radius?: number | null;
}

export interface LayerInfo {
  kind: string;
  visible: boolean;
  opacity: number;
  blend_mode?: string;
  has_mask?: boolean;
  mask_params?: MaskParamsInfo | null;
  adjustments?: AdjustmentValues | null;
  crop?: CropValues | null;
}

export interface CropValues {
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
}

export type PreviewFrame =
  | { kind: "rgba"; pixels: Uint8Array; width: number; height: number }
  | {
      kind: "rgba-float16";
      pixels: unknown;
      width: number;
      height: number;
      colorSpace: "display-p3";
    };

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
  ignore_crop_layers?: boolean;
}

type Float16ArrayCtor = new (
  buffer: ArrayBufferLike,
  byteOffset?: number,
  length?: number,
) => unknown;

let float16PreviewSupport: boolean | null = null;

function supportsFloat16Preview() {
  if (float16PreviewSupport !== null) return float16PreviewSupport;
  if (typeof navigator !== "undefined" && /\bAndroid\b/i.test(navigator.userAgent)) {
    float16PreviewSupport = false;
    return false;
  }
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

interface ByteView {
  buffer: ArrayBufferLike;
  byteOffset: number;
  byteLength: number;
}

function readPreviewHeader(view: ByteView) {
  const header = new DataView(view.buffer, view.byteOffset, 8);
  return {
    width: header.getUint32(0, true),
    height: header.getUint32(4, true),
  };
}

function toByteView(value: ArrayBuffer | Uint8Array): ByteView {
  return value instanceof Uint8Array
    ? {
        buffer: value.buffer,
        byteOffset: value.byteOffset,
        byteLength: value.byteLength,
      }
    : {
        buffer: value,
        byteOffset: 0,
        byteLength: value.byteLength,
      };
}

export async function renderPreview(request?: PreviewRequest): Promise<PreviewFrame> {
  if (await isTauriRuntime()) {
    const inv = await getTauriInvoke();
    if (supportsFloat16Preview()) {
      const Float16 = (globalThis as any).Float16Array as Float16ArrayCtor;
      const result = toByteView(
        (await inv("render_preview_float16", { request })) as ArrayBuffer | Uint8Array,
      );
      const { width, height } = readPreviewHeader(result);
      return {
        kind: "rgba-float16",
        pixels: new Float16(
          result.buffer,
          result.byteOffset + 8,
          (result.byteLength - 8) / 2,
        ),
        width,
        height,
        colorSpace: "display-p3",
      };
    }
    const result = toByteView(
      (await inv("render_preview", { request })) as ArrayBuffer | Uint8Array,
    );
    const { width, height } = readPreviewHeader(result);
    const pixels = new Uint8Array(
      result.buffer,
      result.byteOffset + 8,
      result.byteLength - 8,
    );
    return {
      kind: "rgba",
      pixels,
      width,
      height,
    };
  }
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
}

export async function openImage(path: string): Promise<OpenImageInfo> {
  if (await isTauriRuntime()) {
    const inv = await getTauriInvoke();
    return inv("open_image", { path }) as Promise<any>;
  }
  if (await isBrowserMountedPath(path)) {
    return _loadEncodedBytes(await openBrowserMountedImage(path), path);
  }
  await ensureWorkerReady();
  const response = await fetch(path);
  return _loadEncodedBytes(new Uint8Array(await response.arrayBuffer()), path);
}

export async function exportImage(path: string): Promise<void> {
  if (await isTauriRuntime()) {
    const inv = await getTauriInvoke();
    await inv("export_image", { path });
    return;
  }
  const stack = await getLayerStack();
  const cropLayer = stack.layers.find(
    (layer) => layer.kind === "crop" && layer.visible && layer.crop,
  );
  const crop = cropLayer?.crop;
  const frame = await renderPreview({
    target_width: crop?.width ?? stack.canvas_width,
    target_height: crop?.height ?? stack.canvas_height,
    crop: crop
      ? {
          x: crop.x,
          y: crop.y,
          width: crop.width,
          height: crop.height,
        }
      : undefined,
  });
  const blob = await imageDataToBlob(previewFrameToImageData(frame));
  downloadBlob(blob, path || "shade-export.png");
}

export async function pickDirectory(): Promise<string | BrowserDirectoryHandle | null> {
  if (!(await isTauriRuntime())) {
    return pickBrowserDirectory();
  }
  const { open } = await import("@tauri-apps/plugin-dialog");
  const selectedPath = await open({
    directory: true,
    multiple: false,
  });
  if (selectedPath === null) {
    return null;
  }
  if (Array.isArray(selectedPath)) {
    throw new Error("expected a single directory path");
  }
  return selectedPath;
}

export async function pickExportTarget(): Promise<string | null> {
  if (!(await isTauriRuntime())) {
    return "shade-export.png";
  }
  const { save } = await import("@tauri-apps/plugin-dialog");
  return save({
    title: "Export Render",
    filters: [
      { name: "PNG Image", extensions: ["png"] },
      { name: "JPEG Image", extensions: ["jpg", "jpeg"] },
    ],
  });
}

export async function getLocalPeerDiscoverySnapshot(): Promise<LocalPeerDiscoverySnapshot> {
  if (!(await isTauriRuntime())) {
    return {
      local_endpoint_id: "browser-runtime",
      local_direct_addresses: [],
      peers: [],
    };
  }
  const inv = await getTauriInvoke();
  return inv("get_local_peer_discovery_snapshot") as Promise<LocalPeerDiscoverySnapshot>;
}

export async function listPeerPictures(
  peer_endpoint_id: string,
): Promise<SharedPicture[]> {
  if (!(await isTauriRuntime())) {
    return [];
  }
  const inv = await getTauriInvoke();
  return inv("list_peer_pictures", {
    peerEndpointId: peer_endpoint_id,
  }) as Promise<SharedPicture[]>;
}

export async function getPeerThumbnailBytes(
  peer_endpoint_id: string,
  picture_id: string,
): Promise<Uint8Array> {
  if (!(await isTauriRuntime())) {
    return new Uint8Array();
  }
  const inv = await getTauriInvoke();
  const result = (await inv("get_peer_thumbnail", {
    peerEndpointId: peer_endpoint_id,
    pictureId: picture_id,
  })) as number[] | Uint8Array | ArrayBuffer;
  return result instanceof Uint8Array
    ? result
    : result instanceof ArrayBuffer
      ? new Uint8Array(result)
      : Uint8Array.from(result as number[]);
}

export async function getPeerThumbnail(
  peer_endpoint_id: string,
  picture_id: string,
): Promise<string> {
  const bytes = await getPeerThumbnailBytes(peer_endpoint_id, picture_id);
  const blobBytes = Uint8Array.from(bytes);
  return URL.createObjectURL(new Blob([blobBytes.buffer], { type: "image/jpeg" }));
}

export async function openPeerImage(
  peer_endpoint_id: string,
  picture: SharedPicture,
): Promise<OpenImageInfo> {
  if (!(await isTauriRuntime())) {
    throw new Error("peer image loading requires the Tauri runtime");
  }
  const inv = await getTauriInvoke();
  return inv("open_peer_image", {
    peerEndpointId: peer_endpoint_id,
    pictureId: picture.id,
    file_name: picture.name,
  }) as Promise<OpenImageInfo>;
}

/** Open an image from a File object — works for both file picker and drag-and-drop. */
export async function openImageFile(file: File): Promise<OpenImageInfo> {
  if (await isTauriRuntime()) {
    const inv = await getTauriInvoke();
    const bytes = Array.from(new Uint8Array(await file.arrayBuffer()));
    return inv("open_image_encoded_bytes", {
      bytes,
      file_name: file.name,
    }) as Promise<any>;
  }
  return _loadEncodedBytes(new Uint8Array(await file.arrayBuffer()), file.name);
}

async function _loadEncodedBytes(
  bytes: Uint8Array,
  fileName?: string,
): Promise<OpenImageInfo> {
  const result = await workerCall<{
    layerCount: number;
    canvasWidth: number;
    canvasHeight: number;
    source_bit_depth: string;
  }>({ type: "load_image_encoded", bytes, fileName }, "image_loaded");
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
  const result = await workerCall<{ data: string }>({ type: "get_stack" }, "stack");
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
    case "crop":
      await workerCall(
        { type: "apply_crop", layerIdx: layer_idx, ...rest },
        "crop_applied",
      );
      break;
    case "tone":
      await workerCall(
        { type: "apply_tone", layerIdx: layer_idx, ...rest },
        "tone_applied",
      );
      break;
    case "color":
      await workerCall(
        { type: "apply_color", layerIdx: layer_idx, ...rest },
        "color_applied",
      );
      break;
    case "hsl":
      await workerCall(
        { type: "apply_hsl", layerIdx: layer_idx, ...rest },
        "hsl_applied",
      );
      break;
    case "curves":
      await workerCall(
        { type: "apply_curves", layerIdx: layer_idx, ...rest },
        "curves_applied",
      );
      break;
    case "vignette":
      await workerCall(
        { type: "apply_vignette", layerIdx: layer_idx, ...rest },
        "vignette_applied",
      );
      break;
    case "sharpen":
      await workerCall(
        { type: "apply_sharpen", layerIdx: layer_idx, ...rest },
        "sharpen_applied",
      );
      break;
    case "grain":
      await workerCall(
        { type: "apply_grain", layerIdx: layer_idx, ...rest },
        "grain_applied",
      );
      break;
    case "denoise":
      await workerCall(
        { type: "apply_denoise", layerIdx: layer_idx, ...rest },
        "denoise_applied",
      );
      break;
    default:
      throw new Error(`unsupported web edit op: ${String(op)}`);
  }
}

export async function setLayerVisible(idx: number, visible: boolean): Promise<void> {
  if (await isTauriRuntime()) {
    const inv = await getTauriInvoke();
    await inv("set_layer_visible", { params: { layer_idx: idx, visible } });
    return;
  }
  await ensureWorkerReady();
  await workerCall(
    { type: "set_layer_visible", layerIdx: idx, visible },
    "layer_updated",
  );
}

export async function setLayerOpacity(idx: number, opacity: number): Promise<void> {
  if (await isTauriRuntime()) {
    const inv = await getTauriInvoke();
    await inv("set_layer_opacity", { params: { layer_idx: idx, opacity } });
    return;
  }
  await ensureWorkerReady();
  await workerCall(
    { type: "set_layer_opacity", layerIdx: idx, opacity },
    "layer_updated",
  );
}

export async function deleteLayer(idx: number): Promise<void> {
  if (await isTauriRuntime()) {
    const inv = await getTauriInvoke();
    await inv("delete_layer", { params: { layer_idx: idx } });
    return;
  }
  await ensureWorkerReady();
  await workerCall({ type: "delete_layer", layerIdx: idx }, "layer_deleted");
}

export async function moveLayer(fromIdx: number, toIdx: number): Promise<number> {
  if (await isTauriRuntime()) {
    const inv = await getTauriInvoke();
    return inv("move_layer", {
      params: { from_idx: fromIdx, to_idx: toIdx },
    }) as Promise<number>;
  }
  await ensureWorkerReady();
  const result = await workerCall<{ layerIdx: number }>(
    { type: "move_layer", fromIdx, toIdx },
    "layer_moved",
  );
  return result.layerIdx;
}

/** Returns a JPEG blob URL for any image format including EXR and RAW. Caller owns the URL (call URL.revokeObjectURL when done). */
export async function getThumbnailBytes(path: string): Promise<Uint8Array> {
  if (await isTauriRuntime()) {
    const inv = await getTauriInvoke();
    const result = (await inv("get_thumbnail", { path })) as
      | number[]
      | Uint8Array
      | ArrayBuffer;
    const bytes =
      result instanceof Uint8Array
        ? result
        : result instanceof ArrayBuffer
          ? new Uint8Array(result)
          : Uint8Array.from(result as number[]);
    return Uint8Array.from(bytes);
  }
  if (await isBrowserMountedPath(path)) {
    return getBrowserMountedThumbnailBytes(path);
  }
  const response = await fetch(path);
  return new Uint8Array(await response.arrayBuffer());
}

/** Returns a JPEG blob URL for any image format including EXR and RAW. Caller owns the URL (call URL.revokeObjectURL when done). */
export async function getThumbnail(path: string): Promise<string> {
  const bytes = await getThumbnailBytes(path);
  const blobBytes = Uint8Array.from(bytes);
  return URL.createObjectURL(new Blob([blobBytes.buffer], { type: "image/jpeg" }));
}

export async function listPictures(): Promise<string[]> {
  if (await isTauriRuntime()) {
    const inv = await getTauriInvoke();
    return inv("list_pictures") as Promise<string[]>;
  }
  return [];
}

export interface MediaLibrary {
  id: string;
  name: string;
  kind: "directory" | "camera";
  path?: string | null;
  removable: boolean;
  is_online?: boolean | null;
}

export interface PresetInfo {
  name: string;
}

export interface EditSnapshotInfo {
  version: number;
}

export interface SnapshotInfo {
  version: number;
  created_at: number;
  is_current: boolean;
}

export async function listMediaLibraries(): Promise<MediaLibrary[]> {
  if (await isTauriRuntime()) {
    const inv = await getTauriInvoke();
    return inv("list_media_libraries") as Promise<MediaLibrary[]>;
  }
  return listBrowserMediaLibraries();
}

export async function listLibraryImages(libraryId: string): Promise<LibraryImageListing> {
  if (await isTauriRuntime()) {
    const inv = await getTauriInvoke();
    return inv("list_library_images", {
      libraryId,
    }) as Promise<LibraryImageListing>;
  }
  if (!(await isBrowserMountedLibrary(libraryId))) {
    throw new Error(`browser media library not found: ${libraryId}`);
  }
  return listBrowserLibraryImages(libraryId);
}

export async function addMediaLibrary(
  path: string | BrowserDirectoryHandle,
): Promise<MediaLibrary> {
  if (await isTauriRuntime()) {
    if (typeof path !== "string") {
      throw new Error("expected a filesystem path in the Tauri runtime");
    }
    const inv = await getTauriInvoke();
    return inv("add_media_library", { path }) as Promise<MediaLibrary>;
  }
  if (typeof path === "string") {
    throw new Error("expected a directory handle in the browser runtime");
  }
  return addBrowserMediaLibrary(path);
}

export async function removeMediaLibrary(id: string): Promise<void> {
  if (await isTauriRuntime()) {
    const inv = await getTauriInvoke();
    await inv("remove_media_library", { id });
    return;
  }
  await removeBrowserMediaLibrary(id);
}

export async function listPresets(): Promise<PresetInfo[]> {
  if (await isTauriRuntime()) {
    const inv = await getTauriInvoke();
    return inv("list_presets") as Promise<PresetInfo[]>;
  }
  throw new Error("listPresets is only implemented for Tauri");
}

export async function savePreset(name: string): Promise<PresetInfo> {
  if (await isTauriRuntime()) {
    const inv = await getTauriInvoke();
    return inv("save_preset", { name }) as Promise<PresetInfo>;
  }
  throw new Error("savePreset is only implemented for Tauri");
}

export async function loadPreset(name: string): Promise<void> {
  if (await isTauriRuntime()) {
    const inv = await getTauriInvoke();
    await inv("load_preset", { name });
    return;
  }
  throw new Error("loadPreset is only implemented for Tauri");
}

export async function saveSnapshot(): Promise<EditSnapshotInfo> {
  if (await isTauriRuntime()) {
    const inv = await getTauriInvoke();
    return inv("save_snapshot") as Promise<EditSnapshotInfo>;
  }
  throw new Error("saveSnapshot is only implemented for Tauri");
}

export async function listSnapshots(): Promise<SnapshotInfo[]> {
  if (await isTauriRuntime()) {
    const inv = await getTauriInvoke();
    return inv("list_snapshots") as Promise<SnapshotInfo[]>;
  }
  throw new Error("listSnapshots is only implemented for Tauri");
}

export async function loadSnapshot(version: number): Promise<void> {
  if (await isTauriRuntime()) {
    const inv = await getTauriInvoke();
    await inv("load_snapshot", { params: { version } });
    return;
  }
  throw new Error("loadSnapshot is only implemented for Tauri");
}

export async function addLayer(kind: string): Promise<number> {
  if (await isTauriRuntime()) {
    const inv = await getTauriInvoke();
    return inv("add_layer", { kind }) as Promise<number>;
  }
  await ensureWorkerReady();
  const result = await workerCall<{ layerIdx: number }>(
    { type: "add_layer", kind },
    "layer_added",
  );
  return result.layerIdx;
}

export interface LinearGradientMask {
  kind: "linear";
  layer_idx: number;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface RadialGradientMask {
  kind: "radial";
  layer_idx: number;
  cx: number;
  cy: number;
  radius: number;
}

export type GradientMaskParams = LinearGradientMask | RadialGradientMask;

export async function applyGradientMask(params: GradientMaskParams): Promise<void> {
  if (await isTauriRuntime()) {
    const inv = await getTauriInvoke();
    await inv("apply_gradient_mask", { params });
    return;
  }
  throw new Error("applyGradientMask is not implemented for WASM");
}

export async function removeMask(idx: number): Promise<void> {
  if (await isTauriRuntime()) {
    const inv = await getTauriInvoke();
    await inv("remove_mask", { params: { layer_idx: idx } });
    return;
  }
  throw new Error("removeMask is not implemented for WASM");
}
