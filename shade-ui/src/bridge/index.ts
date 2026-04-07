/**
 * Unified bridge: uses Tauri IPC when running as a desktop app,
 * falls back to a browser worker when running on the web.
 */

import type { ThumbnailBackend } from "./thumbnail-backend";

export type FileSystemPermissionMode = "read" | "readwrite";
export type FileSystemPermissionState = "granted" | "denied" | "prompt";

export interface BrowserFileSystemHandle {
  kind: "file" | "directory";
  name: string;
  queryPermission(descriptor?: {
    mode?: FileSystemPermissionMode;
  }): Promise<FileSystemPermissionState>;
  requestPermission(descriptor?: {
    mode?: FileSystemPermissionMode;
  }): Promise<FileSystemPermissionState>;
  isSameEntry(other: BrowserFileSystemHandle): Promise<boolean>;
}

export interface BrowserFileHandle extends BrowserFileSystemHandle {
  kind: "file";
  getFile(): Promise<File>;
}

export interface BrowserDirectoryHandle extends BrowserFileSystemHandle {
  kind: "directory";
  values(): AsyncIterable<BrowserFileHandle | BrowserDirectoryHandle>;
}

export interface NativeDragDropPayload {
  type: "enter" | "over" | "drop" | "leave";
  paths: string[];
}

export interface TauriPlatform {
  kind: "tauri";
  thumbnailBackend: ThumbnailBackend;
  libraryCache: LibraryCachePlatform;
  collections: CollectionsPlatform;
  isTauri(): boolean;
  invoke<T = unknown>(cmd: string, args?: Record<string, unknown>): Promise<T>;
  pickDirectory(): Promise<string | null>;
  pickExportTarget(): Promise<string | null>;
  listenPeerPaired(listener: () => void): Promise<() => void>;
  listenNativeDragDrop(
    listener: (payload: NativeDragDropPayload) => void,
  ): Promise<() => void>;
  listenLibrarySyncProgress(
    listener: (payload: LibrarySyncProgress) => void,
  ): Promise<() => void>;
  listenLibraryScanComplete(
    listener: (libraryId: string) => void,
  ): Promise<() => void>;
  listenLibraryScanProgress(
    listener: (libraryId: string) => void,
  ): Promise<() => void>;
  listenImageOpenPhase(
    listener: (phase: string) => void,
  ): Promise<() => void>;
}

export interface BrowserPlatform {
  kind: "browser";
  thumbnailBackend: ThumbnailBackend;
  libraryCache: LibraryCachePlatform;
  collections: CollectionsPlatform;
  createWorker(): Worker;
  media: BrowserMediaPlatform;
  presets: BrowserPresetsPlatform;
  snapshots: BrowserSnapshotsPlatform;
}

export type Platform = BrowserPlatform | TauriPlatform;

export async function isTauriRuntime() {
  return getPlatform().kind === "tauri";
}

// ── Browser worker path ──────────────────────────────────────────────────────
let worker: Worker | null = null;
let nextWorkerRequestId = 1;
const pendingRequests = new Map<
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
    worker = getBrowserPlatform().createWorker();
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
  transfer: Transferable[] = [],
): Promise<T> {
  return new Promise((resolve, reject) => {
    const requestId = nextWorkerRequestId;
    nextWorkerRequestId += 1;
    pendingRequests.set(requestId, {
      responseType,
      resolve: resolve as (v: unknown) => void,
      reject,
    });
    getWorker().postMessage({ ...message, requestId }, transfer);
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
  file_hash: string | null;
}

export interface LocalPeer {
  endpoint_id: string;
  name: string;
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
  has_snapshots: boolean;
  latest_snapshot_id: string | null;
}

export interface LibraryImageMetadata {
  has_snapshots: boolean;
  latest_snapshot_id: string | null;
  rating: number | null;
  tags: string[];
}

export interface LibraryImage {
  path: string;
  name: string;
  modified_at: number | null;
  file_hash: string | null;
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
  ls_curve: LsCurveValues | null;
  color: ColorValues | null;
  vignette: { amount: number } | null;
  sharpen: { amount: number } | null;
  grain: { amount: number; size: number } | null;
  glow: { amount: number } | null;
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

export interface LsCurveValues {
  lut: number[];
  control_points?: CurveControlPoint[] | null;
}

export interface MaskParamsInfo {
  kind: "linear" | "radial" | "brush";
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
  name?: string | null;
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
  const source = await getBrowserPlatform().media.getImageSource(path);
  return _loadEncodedBytes(source.bytes, source.fileName ?? path);
}

export function prepareImageOpen(path: string): Promise<void> {
  return isTauriRuntime().then((isTauri) => {
    if (isTauri) {
      return;
    }
    return getBrowserPlatform().media.prepareImageOpen(path);
  });
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
    return getBrowserPlatform().media.pickDirectory();
  }
  return getTauriPlatform().pickDirectory();
}

export async function pickExportTarget(): Promise<string | null> {
  if (!(await isTauriRuntime())) {
    return "shade-export.png";
  }
  return getTauriPlatform().pickExportTarget();
}

export async function listenPeerPaired(
  listener: () => void,
): Promise<() => void> {
  if (!(await isTauriRuntime())) {
    return () => {};
  }
  return getTauriPlatform().listenPeerPaired(listener);
}

export async function listenNativeDragDrop(
  listener: (payload: NativeDragDropPayload) => void,
): Promise<() => void> {
  if (!(await isTauriRuntime())) {
    return () => {};
  }
  return getTauriPlatform().listenNativeDragDrop(listener);
}

export async function listenLibrarySyncProgress(
  listener: (payload: LibrarySyncProgress) => void,
): Promise<() => void> {
  if (!(await isTauriRuntime())) {
    return () => {};
  }
  return getTauriPlatform().listenLibrarySyncProgress(listener);
}

export async function listenLibraryScanComplete(
  listener: (libraryId: string) => void,
): Promise<() => void> {
  if (!(await isTauriRuntime())) {
    return () => {};
  }
  return getTauriPlatform().listenLibraryScanComplete(listener);
}

export async function listenLibraryScanProgress(
  listener: (libraryId: string) => void,
): Promise<() => void> {
  if (!(await isTauriRuntime())) {
    return () => {};
  }
  return getTauriPlatform().listenLibraryScanProgress(listener);
}

export async function listenImageOpenPhase(
  listener: (phase: string) => void,
): Promise<() => void> {
  if (!(await isTauriRuntime())) {
    return () => {};
  }
  return getTauriPlatform().listenImageOpenPhase(listener);
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

export async function pairPeerDevice(peer_endpoint_id: string): Promise<void> {
  if (!(await isTauriRuntime())) {
    return;
  }
  const inv = await getTauriInvoke();
  await inv("pair_peer_device", {
    peerEndpointId: peer_endpoint_id,
  });
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
  return getPlatform().thumbnailBackend.getPeerThumbnailBytes(
    peer_endpoint_id,
    picture_id,
  );
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
  const source = await getBrowserPlatform().media.getImageFileSource(file, file.name);
  return _loadEncodedBytes(source.bytes, source.fileName ?? file.name);
}

async function _loadEncodedBytes(
  bytes: ArrayBuffer,
  fileName?: string,
): Promise<OpenImageInfo> {
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
    file_hash: null,
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
    case "ls_curve":
      await workerCall(
        { type: "apply_ls_curve", layerIdx: layer_idx, ...rest },
        "ls_curve_applied",
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
    case "glow":
      await workerCall(
        { type: "apply_glow", layerIdx: layer_idx, ...rest },
        "glow_applied",
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

export async function renameLayer(idx: number, name: string | null): Promise<void> {
  if (await isTauriRuntime()) {
    const inv = await getTauriInvoke();
    await inv("rename_layer", { params: { layer_idx: idx, name } });
    return;
  }
  await ensureWorkerReady();
  await workerCall({ type: "rename_layer", layerIdx: idx, name }, "layer_renamed");
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
  return getPlatform().thumbnailBackend.getThumbnailBytes(path);
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

export type LibraryMode = "browse" | "sync";

export type LibrarySyncProgress = {
  library_id: string;
  total: number;
  completed: number;
  current_name: string | null;
};

export interface MediaLibrary {
  id: string;
  name: string;
  kind: "directory" | "camera" | "s3" | "peer";
  mode: LibraryMode;
  sync_target?: string | null;
  path?: string | null;
  removable: boolean;
  readonly: boolean;
  is_online?: boolean | null;
  is_refreshing?: boolean | null;
}

export interface BrowserPresetLayer {
  kind: "adjustment" | "crop";
  name: string | null;
  visible: boolean;
  opacity: number;
  adjustments: AdjustmentValues | null;
  crop: CropValues | null;
  mask_params: MaskParamsInfo | null;
}

export interface BrowserPresetFile {
  version: number;
  layers: BrowserPresetLayer[];
}

export interface BrowserMediaPlatform {
  pickDirectory(): Promise<BrowserDirectoryHandle | null>;
  listMediaLibraries(): Promise<MediaLibrary[]>;
  listLibraryImages(libraryId: string): Promise<LibraryImageListing>;
  addMediaLibrary(handle: BrowserDirectoryHandle): Promise<MediaLibrary>;
  removeMediaLibrary(id: string): Promise<void>;
  prepareImageOpen(path: string): Promise<void>;
  getImageSource(
    path: string,
  ): Promise<{ bytes: ArrayBuffer; fileName: string | null }>;
  getImageFileSource(
    file: Blob,
    fileName: string,
  ): Promise<{ bytes: ArrayBuffer; fileName: string | null }>;
}

export interface BrowserPresetsPlatform {
  listPresets(): Promise<PresetInfo[]>;
  savePreset(name: string, file: BrowserPresetFile): Promise<PresetInfo>;
  renamePreset(oldName: string, newName: string): Promise<PresetInfo>;
  loadPreset(name: string): Promise<BrowserPresetFile>;
}

export interface BrowserSnapshotRecord {
  id: string;
  image_path: string | null;
  display_index: number;
  created_at: number;
  is_current: boolean;
  layers: BrowserPresetLayer[];
}

export interface BrowserSnapshotsPlatform {
  listSnapshots(imagePath: string | null): Promise<SnapshotInfo[]>;
  getSnapshotPathMap(): Promise<Map<string, string>>;
  getSnapshot(id: string): Promise<BrowserSnapshotRecord>;
  getCurrentSnapshot(
    imagePath: string | null,
  ): Promise<{ id: string; layers: BrowserPresetLayer[] } | null>;
  saveSnapshot(
    layers: BrowserPresetLayer[],
    imagePath: string | null,
  ): Promise<EditSnapshotInfo>;
  markSnapshotCurrent(id: string): Promise<void>;
}

export interface LibraryCachePlatform {
  getCachedLocalLibraryItems(libraryId: string): Promise<LibraryImage[]>;
  loadLocalLibraryItemsCachedOrRemote(
    libraryId: string,
  ): Promise<LibraryImageListing>;
  getCachedCameraLibraryItems(host: string): Promise<LibraryImage[]>;
  loadCameraLibraryItemsCachedOrRemote(host: string): Promise<LibraryImage[]>;
  getCachedPeerLibraryItems(peerId: string): Promise<SharedPicture[]>;
  loadPeerLibraryItemsCachedOrRemote(peerId: string): Promise<SharedPicture[]>;
  removePeerLibrary(peerId: string): Promise<void>;
  resolveLocalThumbnailSrc(
    path: string,
    latestSnapshotId: string | null,
    signal: AbortSignal,
  ): Promise<string>;
  resolveCameraThumbnailSrc(
    path: string,
    latestSnapshotId: string | null,
    signal: AbortSignal,
  ): Promise<string>;
  resolvePeerThumbnailSrc(
    peerId: string,
    pictureId: string,
    signal: AbortSignal,
  ): Promise<string>;
  resetLocalThumbnailFailure(path: string): void;
  resetCameraThumbnailFailure(path: string): void;
}

let _platform: Platform | null = null;

async function getTauriInvoke() {
  const platform = getTauriPlatform();
  return platform.invoke.bind(platform);
}

export function setPlatform(platform: Platform): void {
  _platform = platform;
}

export function getPlatform(): Platform {
  if (!_platform) {
    throw new Error("platform not initialized");
  }
  return _platform;
}

export function getBrowserPlatform(): BrowserPlatform {
  const platform = getPlatform();
  if (platform.kind !== "browser") {
    throw new Error("browser platform not initialized");
  }
  return platform;
}

export function getTauriPlatform(): TauriPlatform {
  const platform = getPlatform();
  if (platform.kind !== "tauri") {
    throw new Error("tauri platform not initialized");
  }
  return platform;
}

export interface S3MediaLibraryInput {
  name?: string | null;
  endpoint: string;
  bucket: string;
  region: string;
  access_key_id: string;
  secret_access_key: string;
  prefix?: string | null;
}

export interface PresetInfo {
  name: string;
}

export interface EditSnapshotInfo {
  id: string;
}

export interface SnapshotInfo {
  id: string;
  display_index: number;
  created_at: number;
  is_current: boolean;
  peer_origin: string | null;
}

export interface MediaRatingParams {
  file_hash: string;
  rating: number | null;
}

export async function listMediaLibraries(): Promise<MediaLibrary[]> {
  if (await isTauriRuntime()) {
    const inv = await getTauriInvoke();
    return inv("list_media_libraries") as Promise<MediaLibrary[]>;
  }
  return getBrowserPlatform().media.listMediaLibraries();
}

export async function listLibraryImages(libraryId: string): Promise<LibraryImageListing> {
  if (await isTauriRuntime()) {
    const inv = await getTauriInvoke();
    return inv("list_library_images", {
      libraryId,
    }) as Promise<LibraryImageListing>;
  }
  return getBrowserPlatform().media.listLibraryImages(libraryId);
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
  return getBrowserPlatform().media.addMediaLibrary(path);
}

export async function addS3MediaLibrary(
  params: S3MediaLibraryInput,
): Promise<MediaLibrary> {
  if (!(await isTauriRuntime())) {
    throw new Error("S3 media libraries are only implemented for Tauri");
  }
  const inv = await getTauriInvoke();
  return inv("add_s3_media_library", { params }) as Promise<MediaLibrary>;
}

export async function uploadMediaLibraryFile(
  libraryId: string,
  file: File,
  appendTimestampOnConflict = false,
): Promise<void> {
  if (!(await isTauriRuntime())) {
    throw new Error("library uploads are only implemented for Tauri");
  }
  const inv = await getTauriInvoke();
  const bytes = Array.from(new Uint8Array(await file.arrayBuffer()));
  await inv("upload_media_library_file", {
    libraryId,
    fileName: file.name,
    bytes,
    appendTimestampOnConflict,
  });
}

export async function uploadMediaLibraryPath(
  libraryId: string,
  path: string,
): Promise<void> {
  if (!(await isTauriRuntime())) {
    throw new Error("library uploads from paths are only implemented for Tauri");
  }
  const inv = await getTauriInvoke();
  await inv("upload_media_library_path", {
    libraryId,
    path,
  });
}

export async function deleteMediaLibraryItem(path: string): Promise<void> {
  if (!(await isTauriRuntime())) {
    throw new Error("media item deletion is only implemented for Tauri");
  }
  const inv = await getTauriInvoke();
  await inv("delete_media_library_item", {
    path,
  });
}

export async function removeMediaLibrary(id: string): Promise<void> {
  if (await isTauriRuntime()) {
    const inv = await getTauriInvoke();
    await inv("remove_media_library", { id });
    return;
  }
  await getBrowserPlatform().media.removeMediaLibrary(id);
}

export function getCachedLocalLibraryItems(libraryId: string): Promise<LibraryImage[]> {
  return getPlatform().libraryCache.getCachedLocalLibraryItems(libraryId);
}

export function loadLocalLibraryItemsCachedOrRemote(
  libraryId: string,
): Promise<LibraryImageListing> {
  return getPlatform().libraryCache.loadLocalLibraryItemsCachedOrRemote(libraryId);
}

export function getCachedCameraLibraryItems(host: string): Promise<LibraryImage[]> {
  return getPlatform().libraryCache.getCachedCameraLibraryItems(host);
}

export function loadCameraLibraryItemsCachedOrRemote(
  host: string,
): Promise<LibraryImage[]> {
  return getPlatform().libraryCache.loadCameraLibraryItemsCachedOrRemote(host);
}

export function getCachedPeerLibraryItems(peerId: string): Promise<SharedPicture[]> {
  return getPlatform().libraryCache.getCachedPeerLibraryItems(peerId);
}

export function loadPeerLibraryItemsCachedOrRemote(
  peerId: string,
): Promise<SharedPicture[]> {
  return getPlatform().libraryCache.loadPeerLibraryItemsCachedOrRemote(peerId);
}

export function removePeerLibrary(peerId: string): Promise<void> {
  return getPlatform().libraryCache.removePeerLibrary(peerId);
}

export function resolveLocalThumbnailSrc(
  path: string,
  latestSnapshotId: string | null,
  signal: AbortSignal,
): Promise<string> {
  return getPlatform().libraryCache.resolveLocalThumbnailSrc(
    path,
    latestSnapshotId,
    signal,
  );
}

export function resolveCameraThumbnailSrc(
  path: string,
  latestSnapshotId: string | null,
  signal: AbortSignal,
): Promise<string> {
  return getPlatform().libraryCache.resolveCameraThumbnailSrc(
    path,
    latestSnapshotId,
    signal,
  );
}

export function resolvePeerThumbnailSrc(
  peerId: string,
  pictureId: string,
  signal: AbortSignal,
): Promise<string> {
  return getPlatform().libraryCache.resolvePeerThumbnailSrc(
    peerId,
    pictureId,
    signal,
  );
}

export function resetLocalThumbnailFailure(path: string): void {
  getPlatform().libraryCache.resetLocalThumbnailFailure(path);
}

export function resetCameraThumbnailFailure(path: string): void {
  getPlatform().libraryCache.resetCameraThumbnailFailure(path);
}

export async function setLibraryMode(libraryId: string, mode: LibraryMode, syncTarget?: string | null): Promise<void> {
  if (!(await isTauriRuntime())) {
    throw new Error("setLibraryMode is only implemented for Tauri");
  }
  const inv = await getTauriInvoke();
  await inv("set_library_mode", { libraryId, mode, syncTarget: syncTarget ?? null });
}

export async function syncLibrary(libraryId: string): Promise<void> {
  if (!(await isTauriRuntime())) {
    throw new Error("syncLibrary is only implemented for Tauri");
  }
  const inv = await getTauriInvoke();
  await inv("sync_library", { libraryId });
}

export async function setMediaLibraryOrder(libraryOrder: string[]): Promise<void> {
  if (await isTauriRuntime()) {
    const inv = await getTauriInvoke();
    await inv("set_media_library_order", {
      libraryOrder,
    });
    return;
  }
  throw new Error("setMediaLibraryOrder is only implemented for Tauri");
}

export async function refreshLibraryIndex(libraryId: string): Promise<void> {
  if (!(await isTauriRuntime())) {
    return;
  }
  const inv = await getTauriInvoke();
  await inv("refresh_library_index", { libraryId });
}

function serializeBrowserPresetLayers(layers: LayerInfo[]): BrowserPresetLayer[] {
  return layers
    .filter((layer) => layer.kind !== "image")
    .map((layer) => {
      if (layer.kind !== "adjustment" && layer.kind !== "crop") {
        throw new Error(`unsupported preset layer kind: ${layer.kind}`);
      }
      if (layer.has_mask && !layer.mask_params) {
        throw new Error("browser presets only support gradient masks");
      }
      if (layer.kind === "crop" && !layer.crop) {
        throw new Error("crop layer is missing crop values");
      }
      return {
        kind: layer.kind,
        name: layer.name ?? null,
        visible: layer.visible,
        opacity: layer.opacity,
        adjustments: layer.adjustments ?? null,
        crop: layer.crop ?? null,
        mask_params: layer.mask_params ?? null,
      };
    });
}

function requiredNumber(value: number | null | undefined, label: string) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`preset mask is missing ${label}`);
  }
  return value;
}

async function applyBrowserPresetAdjustment(
  layerIdx: number,
  adjustments: AdjustmentValues,
) {
  if (adjustments.tone) {
    await applyEdit({
      layer_idx: layerIdx,
      op: "tone",
      exposure: adjustments.tone.exposure,
      contrast: adjustments.tone.contrast,
      blacks: adjustments.tone.blacks,
      whites: adjustments.tone.whites,
      highlights: adjustments.tone.highlights,
      shadows: adjustments.tone.shadows,
      gamma: adjustments.tone.gamma,
    });
  }
  if (adjustments.color) {
    await applyEdit({
      layer_idx: layerIdx,
      op: "color",
      saturation: adjustments.color.saturation,
      vibrancy: adjustments.color.vibrancy,
      temperature: adjustments.color.temperature,
      tint: adjustments.color.tint,
    });
  }
  if (adjustments.curves) {
    if (!adjustments.curves.control_points) {
      throw new Error("preset curves are missing control points");
    }
    await applyEdit({
      layer_idx: layerIdx,
      op: "curves",
      curve_points: adjustments.curves.control_points,
    });
  }
  if (adjustments.ls_curve) {
    if (!adjustments.ls_curve.control_points) {
      throw new Error("preset ls_curve are missing control points");
    }
    await applyEdit({
      layer_idx: layerIdx,
      op: "ls_curve",
      curve_points: adjustments.ls_curve.control_points,
    });
  }
  if (adjustments.vignette) {
    await applyEdit({
      layer_idx: layerIdx,
      op: "vignette",
      vignette_amount: adjustments.vignette.amount,
    });
  }
  if (adjustments.sharpen) {
    await applyEdit({
      layer_idx: layerIdx,
      op: "sharpen",
      sharpen_amount: adjustments.sharpen.amount,
    });
  }
  if (adjustments.grain) {
    await applyEdit({
      layer_idx: layerIdx,
      op: "grain",
      grain_amount: adjustments.grain.amount,
      grain_size: adjustments.grain.size,
    });
  }
  if (adjustments.glow) {
    await applyEdit({
      layer_idx: layerIdx,
      op: "glow",
      glow_amount: adjustments.glow.amount,
    });
  }
  if (adjustments.hsl) {
    await applyEdit({
      layer_idx: layerIdx,
      op: "hsl",
      red_hue: adjustments.hsl.red_hue,
      red_sat: adjustments.hsl.red_sat,
      red_lum: adjustments.hsl.red_lum,
      green_hue: adjustments.hsl.green_hue,
      green_sat: adjustments.hsl.green_sat,
      green_lum: adjustments.hsl.green_lum,
      blue_hue: adjustments.hsl.blue_hue,
      blue_sat: adjustments.hsl.blue_sat,
      blue_lum: adjustments.hsl.blue_lum,
    });
  }
  if (adjustments.denoise) {
    await applyEdit({
      layer_idx: layerIdx,
      op: "denoise",
      denoise_luma_strength: adjustments.denoise.luma_strength,
      denoise_chroma_strength: adjustments.denoise.chroma_strength,
      denoise_mode: adjustments.denoise.mode,
    });
  }
}

async function applyBrowserPresetLayer(layer: BrowserPresetLayer) {
  const layerIdx = await addLayer(layer.kind);
  if (layer.kind === "crop") {
    if (!layer.crop) {
      throw new Error("crop layer is missing crop values");
    }
    await applyEdit({
      layer_idx: layerIdx,
      op: "crop",
      crop_x: layer.crop.x,
      crop_y: layer.crop.y,
      crop_width: layer.crop.width,
      crop_height: layer.crop.height,
      crop_rotation: layer.crop.rotation,
    });
  } else if (layer.adjustments) {
    await applyBrowserPresetAdjustment(layerIdx, layer.adjustments);
  }
  if (layer.mask_params) {
    if (layer.mask_params.kind === "linear") {
      await applyGradientMask({
        kind: "linear",
        layer_idx: layerIdx,
        x1: requiredNumber(layer.mask_params.x1, "x1"),
        y1: requiredNumber(layer.mask_params.y1, "y1"),
        x2: requiredNumber(layer.mask_params.x2, "x2"),
        y2: requiredNumber(layer.mask_params.y2, "y2"),
      });
    } else if (layer.mask_params.kind === "radial") {
      await applyGradientMask({
        kind: "radial",
        layer_idx: layerIdx,
        cx: requiredNumber(layer.mask_params.cx, "cx"),
        cy: requiredNumber(layer.mask_params.cy, "cy"),
        radius: requiredNumber(layer.mask_params.radius, "radius"),
      });
    } else {
      throw new Error("browser presets do not support brush masks");
    }
  }
  if (layer.name !== null) {
    await renameLayer(layerIdx, layer.name);
  }
  if (layer.opacity !== 1) {
    await setLayerOpacity(layerIdx, layer.opacity);
  }
  if (!layer.visible) {
    await setLayerVisible(layerIdx, false);
  }
}

export async function listPresets(): Promise<PresetInfo[]> {
  if (await isTauriRuntime()) {
    const inv = await getTauriInvoke();
    return inv("list_presets") as Promise<PresetInfo[]>;
  }
  return getBrowserPlatform().presets.listPresets();
}

export async function savePreset(name: string): Promise<PresetInfo> {
  if (await isTauriRuntime()) {
    const inv = await getTauriInvoke();
    return inv("save_preset", { name }) as Promise<PresetInfo>;
  }
  const stack = await getLayerStack();
  return getBrowserPlatform().presets.savePreset(name, {
    version: 1,
    layers: serializeBrowserPresetLayers(stack.layers),
  } satisfies BrowserPresetFile);
}

export async function renamePreset(oldName: string, newName: string): Promise<PresetInfo> {
  if (await isTauriRuntime()) {
    const inv = await getTauriInvoke();
    return inv("rename_preset", { oldName, newName }) as Promise<PresetInfo>;
  }
  return getBrowserPlatform().presets.renamePreset(oldName, newName);
}

export async function loadPreset(name: string): Promise<void> {
  if (await isTauriRuntime()) {
    const inv = await getTauriInvoke();
    await inv("load_preset", { name });
    return;
  }
  const preset = await getBrowserPlatform().presets.loadPreset(name);
  const stack = await getLayerStack();
  if (!stack.layers.some((layer) => layer.kind === "image")) {
    throw new Error("cannot load a preset without a loaded image");
  }
  for (let idx = stack.layers.length - 1; idx >= 0; idx -= 1) {
    if (stack.layers[idx]?.kind !== "image") {
      await deleteLayer(idx);
    }
  }
  for (const layer of preset.layers) {
    await applyBrowserPresetLayer(layer);
  }
}

export async function saveSnapshot(imagePath?: string | null): Promise<EditSnapshotInfo> {
  if (await isTauriRuntime()) {
    const inv = await getTauriInvoke();
    return inv("save_snapshot") as Promise<EditSnapshotInfo>;
  }
  const stack = await getLayerStack();
  if (!stack.layers.some((layer) => layer.kind === "image")) {
    throw new Error("cannot save a snapshot without a loaded image");
  }
  return getBrowserPlatform().snapshots.saveSnapshot(
    serializeBrowserPresetLayers(stack.layers),
    imagePath ?? null,
  );
}

export async function listSnapshots(imagePath?: string | null): Promise<SnapshotInfo[]> {
  if (await isTauriRuntime()) {
    const inv = await getTauriInvoke();
    return inv("list_snapshots") as Promise<SnapshotInfo[]>;
  }
  return getBrowserPlatform().snapshots.listSnapshots(imagePath ?? null);
}

export async function listMediaRatings(
  fileHashes: string[],
): Promise<Record<string, number>> {
  if (fileHashes.length === 0) {
    return {};
  }
  if (await isTauriRuntime()) {
    const inv = await getTauriInvoke();
    return inv("list_media_ratings", {
      fileHashes,
    }) as Promise<Record<string, number>>;
  }
  return {};
}

export async function setMediaRating(params: MediaRatingParams): Promise<void> {
  if (await isTauriRuntime()) {
    const inv = await getTauriInvoke();
    await inv("set_media_rating", { params });
    return;
  }
  throw new Error("setMediaRating is only implemented for Tauri");
}

/**
 * Applies the current snapshot for the given image path to the already-loaded image.
 * Returns true if a snapshot was applied, false if there was nothing to restore.
 * No-op on Tauri (the native runtime restores edit state automatically).
 */
export async function restoreCurrentBrowserSnapshot(imagePath: string): Promise<boolean> {
  if (await isTauriRuntime()) {
    return false;
  }
  const snapshot = await getBrowserPlatform().snapshots.getCurrentSnapshot(imagePath);
  if (!snapshot) {
    return false;
  }
  for (const layer of snapshot.layers) {
    await applyBrowserPresetLayer(layer);
  }
  return true;
}

export async function loadSnapshot(id: string): Promise<void> {
  if (await isTauriRuntime()) {
    const inv = await getTauriInvoke();
    await inv("load_snapshot", { params: { id } });
    return;
  }
  const record = await getBrowserPlatform().snapshots.getSnapshot(id);
  const stack = await getLayerStack();
  if (!stack.layers.some((layer) => layer.kind === "image")) {
    throw new Error("cannot load a snapshot without a loaded image");
  }
  for (let idx = stack.layers.length - 1; idx >= 0; idx -= 1) {
    if (stack.layers[idx]?.kind !== "image") {
      await deleteLayer(idx);
    }
  }
  for (const layer of record.layers) {
    await applyBrowserPresetLayer(layer);
  }
  await getBrowserPlatform().snapshots.markSnapshotCurrent(id);
}

export async function getStackSnapshot(): Promise<string> {
  if (await isTauriRuntime()) {
    const inv = await getTauriInvoke();
    return inv("get_stack_snapshot") as Promise<string>;
  }
  await ensureWorkerReady();
  const result = await workerCall<{ data: string }>(
    { type: "get_stack_snapshot" },
    "stack_snapshot",
  );
  return result.data;
}

export async function replaceStack(layersJson: string): Promise<void> {
  if (await isTauriRuntime()) {
    const inv = await getTauriInvoke();
    await inv("replace_stack", { layersJson });
    return;
  }
  await ensureWorkerReady();
  await workerCall({ type: "replace_stack", data: layersJson }, "stack_replaced");
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
  await ensureWorkerReady();
  if (params.kind === "linear") {
    await workerCall(
      { type: "apply_linear_mask", layerIdx: params.layer_idx, ...params },
      "mask_applied",
    );
    return;
  }
  await workerCall(
    { type: "apply_radial_mask", layerIdx: params.layer_idx, ...params },
    "mask_applied",
  );
}

// ── P2P Awareness & Sync ──────────────────────────────────────────────────────

export interface AwarenessState {
  display_name: string | null;
  active_file_hash: string | null;
  active_snapshot_id: string | null;
}

export interface SyncPeerSnapshotsResult {
  synced_ids: string[];
}

export interface ApplyPeerMetadataResult {
  ratings_updated: number;
  tags_added: number;
}

export async function setLocalAwareness(
  displayName: string | null,
  fileHash: string | null,
  snapshotId: string | null,
): Promise<void> {
  if (await isTauriRuntime()) {
    const inv = await getTauriInvoke();
    await inv("set_local_awareness", {
      displayName: displayName ?? null,
      fileHash: fileHash ?? null,
      snapshotId: snapshotId ?? null,
    });
    return;
  }
  throw new Error("setLocalAwareness is only implemented for Tauri");
}

export async function getPeerAwareness(peerEndpointId: string): Promise<AwarenessState> {
  if (await isTauriRuntime()) {
    const inv = await getTauriInvoke();
    return inv("get_peer_awareness", { peerEndpointId }) as Promise<AwarenessState>;
  }
  throw new Error("getPeerAwareness is only implemented for Tauri");
}

export async function syncPeerSnapshots(
  peerEndpointId: string,
  fileHash: string,
): Promise<SyncPeerSnapshotsResult> {
  if (await isTauriRuntime()) {
    const inv = await getTauriInvoke();
    return inv("sync_peer_snapshots", {
      peerEndpointId,
      fileHash,
    }) as Promise<SyncPeerSnapshotsResult>;
  }
  throw new Error("syncPeerSnapshots is only implemented for Tauri");
}

export async function applyPeerMetadata(
  peerEndpointId: string,
  fileHashes: string[],
): Promise<ApplyPeerMetadataResult> {
  if (await isTauriRuntime()) {
    const inv = await getTauriInvoke();
    return inv("apply_peer_metadata", {
      peerEndpointId,
      fileHashes,
    }) as Promise<ApplyPeerMetadataResult>;
  }
  throw new Error("applyPeerMetadata is only implemented for Tauri");
}

export async function removeMask(idx: number): Promise<void> {
  if (await isTauriRuntime()) {
    const inv = await getTauriInvoke();
    await inv("remove_mask", { params: { layer_idx: idx } });
    return;
  }
  await ensureWorkerReady();
  await workerCall({ type: "remove_mask", layerIdx: idx }, "mask_removed");
}

export async function createBrushMask(layerIdx: number): Promise<void> {
  if (await isTauriRuntime()) {
    const inv = await getTauriInvoke();
    await inv("create_brush_mask", { params: { layer_idx: layerIdx } });
    return;
  }
  await ensureWorkerReady();
  await workerCall({ type: "create_brush_mask", layerIdx }, "mask_applied");
}

export async function stampBrushMask(
  layerIdx: number,
  cx: number,
  cy: number,
  radius: number,
  softness: number,
  erase: boolean,
): Promise<void> {
  if (await isTauriRuntime()) {
    const inv = await getTauriInvoke();
    await inv("stamp_brush_mask", {
      params: { layer_idx: layerIdx, cx, cy, radius, softness, erase },
    });
    return;
  }
  await ensureWorkerReady();
  await workerCall(
    { type: "stamp_brush_mask", layerIdx, cx, cy, radius, softness, erase },
    "mask_applied",
  );
}

export interface MaskThumbnail {
  pixels: number[];
  width: number;
  height: number;
}

export async function getMaskThumbnail(
  layerIdx: number,
  maxW: number,
  maxH: number,
): Promise<MaskThumbnail> {
  if (await isTauriRuntime()) {
    const inv = await getTauriInvoke();
    return inv("get_mask_thumbnail", {
      params: { layer_idx: layerIdx, max_w: maxW, max_h: maxH },
    }) as Promise<MaskThumbnail>;
  }
  throw new Error("getMaskThumbnail is only implemented for Tauri");
}

// ── Collections ──────────────────────────────────────────────────────────────

export interface Collection {
  id: string;
  library_id: string;
  name: string;
  position: number;
  created_at: number;
  item_count: number;
}

export interface CollectionItem {
  file_hash: string;
  position: number;
  added_at: number;
}

export interface CollectionsPlatform {
  listCollections(libraryId: string): Promise<Collection[]>;
  createCollection(libraryId: string, name: string): Promise<Collection>;
  renameCollection(collectionId: string, name: string): Promise<void>;
  deleteCollection(collectionId: string): Promise<void>;
  reorderCollection(collectionId: string, newPosition: number): Promise<void>;
  listCollectionItems(collectionId: string): Promise<CollectionItem[]>;
  addToCollection(collectionId: string, fileHashes: string[]): Promise<void>;
  removeFromCollection(collectionId: string, fileHashes: string[]): Promise<void>;
}

export function listCollections(libraryId: string): Promise<Collection[]> {
  return getPlatform().collections.listCollections(libraryId);
}

export function createCollection(libraryId: string, name: string): Promise<Collection> {
  return getPlatform().collections.createCollection(libraryId, name);
}

export function renameCollection(collectionId: string, name: string): Promise<void> {
  return getPlatform().collections.renameCollection(collectionId, name);
}

export function deleteCollection(collectionId: string): Promise<void> {
  return getPlatform().collections.deleteCollection(collectionId);
}

export function reorderCollection(collectionId: string, newPosition: number): Promise<void> {
  return getPlatform().collections.reorderCollection(collectionId, newPosition);
}

export function listCollectionItems(collectionId: string): Promise<CollectionItem[]> {
  return getPlatform().collections.listCollectionItems(collectionId);
}

export function addToCollection(collectionId: string, fileHashes: string[]): Promise<void> {
  return getPlatform().collections.addToCollection(collectionId, fileHashes);
}

export function removeFromCollection(collectionId: string, fileHashes: string[]): Promise<void> {
  return getPlatform().collections.removeFromCollection(collectionId, fileHashes);
}
