/**
 * Unified bridge: uses Tauri IPC when running as a desktop app,
 * falls back to a browser worker when running on the web.
 */

import type { ThumbnailBackend } from "./thumbnail-backend";
import {
  onChannelMessage,
  sendChunkedRead,
  sendMutation,
  sendRead,
} from "./channel";

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
  libraryCache: LibraryCachePlatform;
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
  listenBatchExportProgress(
    listener: (payload: BatchExportProgress) => void,
  ): Promise<() => void>;
}

export interface BrowserPlatform {
  kind: "browser";
  thumbnailBackend: ThumbnailBackend;
  libraryCache: LibraryCachePlatform;
  createWorker(): Worker;
  media: BrowserMediaPlatform;
  // `snapshots` survives on the platform interface because
  // `restoreCurrentBrowserSnapshot` reads it on the main thread to
  // coordinate snapshot-on-open. Editor-state snapshot writes go through
  // the unified `MutationRequest` protocol; this field is read-only in
  // practice.
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
  fingerprint: string | null;
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
  latest_snapshot_created_at?: number | null;
  rating: number | null;
  tags: string[];
}

export interface LibraryImage {
  path: string;
  name: string;
  modified_at: number | null;
  fingerprint: string | null;
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

export async function renderSnapshotThumbnail(
  bytes: ArrayBuffer,
  fileName: string | null,
  layersJson: string,
  targetWidth: number,
  targetHeight: number,
): Promise<{ pixels: Uint8Array; width: number; height: number }> {
  await ensureWorkerReady();
  return workerCall<{ pixels: Uint8Array; width: number; height: number }>(
    { type: "render_snapshot_thumbnail", bytes, fileName, layersJson, targetWidth, targetHeight },
    "snapshot_thumbnail_rendered",
    [bytes],
  );
}

/**
 * Browser-only synchronous preview render. The Tauri runtime uses the
 * push-based preview channel (`bridge/preview.ts` + `update_preview_viewports`)
 * and does not go through this path.
 */
export async function renderPreview(request?: PreviewRequest): Promise<PreviewFrame> {
  if (await isTauriRuntime()) {
    throw new Error(
      "renderPreview is browser-only in this build; tauri uses the push preview channel",
    );
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

async function tauriListen<L>(
  listener: L,
  fn: (platform: TauriPlatform, listener: L) => Promise<() => void>,
): Promise<() => void> {
  if (!(await isTauriRuntime())) return () => {};
  return fn(getTauriPlatform(), listener);
}

export function listenPeerPaired(listener: () => void): Promise<() => void> {
  return tauriListen(listener, (p, l) => p.listenPeerPaired(l));
}

export function listenNativeDragDrop(
  listener: (payload: NativeDragDropPayload) => void,
): Promise<() => void> {
  return tauriListen(listener, (p, l) => p.listenNativeDragDrop(l));
}

export function listenLibrarySyncProgress(
  listener: (payload: LibrarySyncProgress) => void,
): Promise<() => void> {
  return tauriListen(listener, (p, l) => p.listenLibrarySyncProgress(l));
}

export function listenLibraryScanComplete(
  listener: (libraryId: string) => void,
): Promise<() => void> {
  return tauriListen(listener, (p, l) => p.listenLibraryScanComplete(l));
}

export function listenLibraryScanProgress(
  listener: (libraryId: string) => void,
): Promise<() => void> {
  return tauriListen(listener, (p, l) => p.listenLibraryScanProgress(l));
}

export function listenImageOpenPhase(
  listener: (phase: string) => void,
): Promise<() => void> {
  return tauriListen(listener, (p, l) => p.listenImageOpenPhase(l));
}

export function listenBatchExportProgress(
  listener: (payload: BatchExportProgress) => void,
): Promise<() => void> {
  return tauriListen(listener, (p, l) => p.listenBatchExportProgress(l));
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
  return sendRead<LocalPeerDiscoverySnapshot>(
    { type: "get_local_peer_discovery_snapshot" },
    "local_peer_discovery_snapshot",
  );
}

export async function pairPeerDevice(peer_endpoint_id: string): Promise<void> {
  if (!(await isTauriRuntime())) {
    return;
  }
  const inv = await getTauriInvoke();
  await sendMutation({
    type: "pair_peer_device",
    peer_endpoint_id,
  });
}

export async function listPeerPictures(
  peer_endpoint_id: string,
): Promise<SharedPicture[]> {
  if (!(await isTauriRuntime())) {
    return [];
  }
  const inv = await getTauriInvoke();
  return sendRead<SharedPicture[]>(
    { type: "list_peer_pictures", peer_endpoint_id },
    "peer_pictures",
  );
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
    fingerprint: null,
  };
}

/**
 * Browser-only: synchronously fetch the layer stack via the worker. In the
 * Tauri runtime the authoritative stack is pushed reactively over the
 * coordination channel as `LayerStackSnapshot` and read from
 * `editor-store`; calling this on Tauri is a programming error.
 */
export async function getLayerStack(): Promise<StackInfo> {
  if (await isTauriRuntime()) {
    throw new Error(
      "getLayerStack is browser-only — Tauri receives the stack via LayerStackSnapshot",
    );
  }
  await ensureWorkerReady();
  const result = await workerCall<{ data: string }>({ type: "get_stack" }, "stack");
  return JSON.parse(result.data) as StackInfo;
}

export async function applyEdit(params: Record<string, unknown>): Promise<void> {
  await sendMutation({ type: "apply_edit", ...params });
  return;
}

export async function setLayerVisible(idx: number, visible: boolean): Promise<void> {
  await sendMutation({ type: "set_layer_visible", idx, visible });
  return;
}

export async function setLayerOpacity(idx: number, opacity: number): Promise<void> {
  await sendMutation({ type: "set_layer_opacity", idx, opacity });
  return;
}

export async function renameLayer(idx: number, name: string | null): Promise<void> {
  await sendMutation({ type: "rename_layer", idx, name });
  return;
}

export async function deleteLayer(idx: number): Promise<void> {
  await sendMutation({ type: "delete_layer", idx });
  return;
}

export async function moveLayer(fromIdx: number, toIdx: number): Promise<number> {
  await sendMutation({ type: "move_layer", from: fromIdx, to: toIdx });
  // New idx is derivable from from/to; callers use getMovedLayerIndex().
  return toIdx > fromIdx ? toIdx - 1 : toIdx;
}

export async function listPictures(): Promise<string[]> {
  return sendRead<string[]>({ type: "list_pictures" }, "pictures");
}

export type LibraryMode = "browse" | "sync";

export type LibrarySyncProgress = {
  library_id: string;
  total: number;
  completed: number;
  current_name: string | null;
};

export type BatchExportProgress = {
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
  deletePreset(name: string): Promise<void>;
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
  created_at: number;
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
  fingerprint: string;
  rating: number | null;
}

export async function listMediaLibraries(): Promise<MediaLibrary[]> {
  return sendRead<MediaLibrary[]>(
    { type: "list_media_libraries" },
    "media_libraries",
  );
}

interface RawLibraryImage {
  path: string;
  name: string;
  modified_at?: number | null;
  fingerprint?: string | null;
  metadata?: {
    has_snapshots?: boolean;
    latest_snapshot_id?: string | null;
    latest_snapshot_created_at?: number | null;
    rating?: number | null;
    tags?: string[];
  };
}

function normalizeLibraryImage(raw: RawLibraryImage): LibraryImage {
  const meta = raw.metadata ?? {};
  return {
    path: raw.path,
    name: raw.name,
    modified_at: raw.modified_at ?? null,
    fingerprint: raw.fingerprint ?? null,
    metadata: {
      has_snapshots: meta.has_snapshots ?? false,
      latest_snapshot_id: meta.latest_snapshot_id ?? null,
      latest_snapshot_created_at: meta.latest_snapshot_created_at ?? null,
      rating: meta.rating ?? null,
      tags: meta.tags ?? [],
    },
  };
}

export async function listLibraryImages(libraryId: string): Promise<LibraryImageListing> {
  const raws = await sendChunkedRead<RawLibraryImage>(
    { type: "list_library_images", library_id: libraryId },
    "library_images_chunk",
  );
  return { items: raws.map(normalizeLibraryImage), is_complete: true };
}

async function awaitMediaLibraryUpserted(): Promise<MediaLibrary> {
  return new Promise<MediaLibrary>((resolve) => {
    const unsub = onChannelMessage("media_library_upserted", (msg) => {
      unsub();
      resolve(msg.library as MediaLibrary);
    });
  });
}

export async function addMediaLibrary(
  path: string | BrowserDirectoryHandle,
): Promise<MediaLibrary> {
  if (typeof path !== "string") {
    throw new Error("expected a filesystem path in the Tauri runtime");
  }
  const upserted = awaitMediaLibraryUpserted();
  await sendMutation({ type: "add_media_library", path });
  return upserted;
}

export async function addS3MediaLibrary(
  params: S3MediaLibraryInput,
): Promise<MediaLibrary> {
  if (!(await isTauriRuntime())) {
    throw new Error("S3 media libraries are only implemented for Tauri");
  }
  const inv = await getTauriInvoke();
  const upserted = awaitMediaLibraryUpserted();
  await sendMutation({ type: "add_s3_media_library", params });
  return upserted;
}

export async function getS3MediaLibrary(
  libraryId: string,
): Promise<S3MediaLibraryInput> {
  if (!(await isTauriRuntime())) {
    throw new Error("S3 media libraries are only implemented for Tauri");
  }
  const inv = await getTauriInvoke();
  return sendRead<S3MediaLibraryInput>(
    { type: "get_s3_media_library", library_id: libraryId },
    "s3_media_library",
  );
}

export async function updateS3MediaLibrary(
  libraryId: string,
  params: S3MediaLibraryInput,
): Promise<MediaLibrary> {
  if (!(await isTauriRuntime())) {
    throw new Error("S3 media libraries are only implemented for Tauri");
  }
  const inv = await getTauriInvoke();
  const upserted = awaitMediaLibraryUpserted();
  await sendMutation({
    type: "update_s3_media_library",
    library_id: libraryId,
    params,
  });
  return upserted;
}

export async function uploadMediaLibraryUrl(
  libraryId: string,
  url: string,
  fileName: string,
): Promise<void> {
  if (!(await isTauriRuntime())) {
    throw new Error("URL image uploads are only implemented for Tauri");
  }
  const inv = await getTauriInvoke();
  await sendMutation({
    type: "upload_media_library_url",
    library_id: libraryId,
    url,
    file_name: fileName,
  });
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
  await sendMutation({
    type: "upload_media_library_file",
    library_id: libraryId,
    file_name: file.name,
    bytes,
    modified_at: file.lastModified,
    append_timestamp_on_conflict: appendTimestampOnConflict,
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
  await sendMutation({
    type: "upload_media_library_path",
    library_id: libraryId,
    path,
  });
}

export async function deleteMediaLibraryItem(path: string): Promise<void> {
  if (!(await isTauriRuntime())) {
    throw new Error("media item deletion is only implemented for Tauri");
  }
  const inv = await getTauriInvoke();
  await sendMutation({ type: "delete_media_library_item", path });
}

export async function removeMediaLibrary(id: string): Promise<void> {
  await sendMutation({ type: "remove_media_library", id });
  return;
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
  await sendMutation({
    type: "set_library_mode",
    library_id: libraryId,
    mode,
    sync_target: syncTarget ?? null,
  });
}

export async function syncLibrary(libraryId: string): Promise<void> {
  if (!(await isTauriRuntime())) {
    throw new Error("syncLibrary is only implemented for Tauri");
  }
  const inv = await getTauriInvoke();
  await sendMutation({ type: "sync_library", library_id: libraryId });
}

export async function setMediaLibraryOrder(libraryOrder: string[]): Promise<void> {
  await sendMutation({
    type: "set_media_library_order",
    library_order: libraryOrder,
  });
  return;
}

export async function refreshLibraryIndex(libraryId: string): Promise<void> {
  if (!(await isTauriRuntime())) {
    return;
  }
  const inv = await getTauriInvoke();
  await sendMutation({
    type: "refresh_library_index",
    library_id: libraryId,
  });
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
  return sendRead<PresetInfo[]>({ type: "list_presets" }, "presets");
}

export async function savePreset(name: string): Promise<PresetInfo | void> {
  await sendMutation({ type: "save_preset", name });
  // The new preset's metadata is delivered via the PresetListChanged
  // channel notification; callers no longer receive a PresetInfo here.
  return;
}

export async function getSnapshotPresetJson(
  fingerprint: string | null,
  imagePath: string,
): Promise<string | null> {
  if (!fingerprint) return null;
  return sendRead<string | null>(
    { type: "get_snapshot_preset_json", fingerprint },
    "snapshot_preset_json",
  );
}

export async function serializeCurrentPreset(): Promise<string> {
  const tempName = "__clipboard_serialize__";
  await sendMutation({ type: "save_preset", name: tempName });
  const json = await sendRead<string>(
    { type: "get_preset_json", name: tempName },
    "preset_json",
  );
  await sendMutation({ type: "delete_preset", name: tempName });
  return json;
}

export async function savePresetFromJson(name: string, json: string): Promise<void> {
  await sendMutation({ type: "save_preset_from_json", name, json });
  return;
}

export async function renamePreset(oldName: string, newName: string): Promise<PresetInfo | void> {
  await sendMutation({ type: "rename_preset", old_name: oldName, new_name: newName });
  return;
}

export async function deletePreset(name: string): Promise<void> {
  await sendMutation({ type: "delete_preset", name });
  return;
}

export async function loadPreset(name: string): Promise<void> {
  await sendMutation({ type: "load_preset", name });
  return;
}

export async function applyPresetSnapshot(
  name: string,
  imagePath?: string | null,
): Promise<EditSnapshotInfo | void> {
  await sendMutation({ type: "apply_preset_snapshot", name });
  // Snapshot id is no longer returned through invoke; a future
  // `SnapshotSaved` ChannelMessage will surface it for callers that need it.
  return;
}

async function awaitBatchCompleted(kind: string): Promise<number> {
  return new Promise<number>((resolve) => {
    const unsub = onChannelMessage("batch_completed", (msg) => {
      if (msg.kind !== kind) return;
      unsub();
      resolve(msg.count);
    });
  });
}

export async function batchApplyPresetSnapshot(
  items: { path: string; fingerprint: string | null }[],
  name: string,
): Promise<number> {
  const completed = awaitBatchCompleted("apply_preset_snapshot");
  await sendMutation({
    type: "batch_apply_preset_snapshot",
    items,
    name,
  });
  return completed;
}

export async function batchClearEdits(paths: string[]): Promise<number> {
  const completed = awaitBatchCompleted("clear_edits");
  await sendMutation({ type: "batch_clear_edits", paths });
  return completed;
}

export interface BatchExportItem {
  path: string;
  fingerprint: string | null;
  name: string;
}

export async function batchExportImages(
  items: BatchExportItem[],
  targetDir: string,
): Promise<number> {
  const completed = awaitBatchCompleted("export_images");
  await sendMutation({
    type: "batch_export_images",
    items,
    target_dir: targetDir,
  });
  return completed;
}

export async function saveSnapshot(imagePath?: string | null): Promise<EditSnapshotInfo | void> {
  await sendMutation({ type: "save_snapshot" });
  // Snapshot id surfaces through the SnapshotSaved channel notification.
  return;
}

export async function listSnapshots(imagePath?: string | null): Promise<SnapshotInfo[]> {
  return sendRead<SnapshotInfo[]>({ type: "list_snapshots" }, "snapshots");
}

export async function listMediaRatings(
  ids: string[],
): Promise<Record<string, number>> {
  if (ids.length === 0) {
    return {};
  }
  return sendRead<Record<string, number>>(
    { type: "list_media_ratings", fingerprints: ids },
    "media_ratings",
  );
}

export async function setMediaRating(params: MediaRatingParams): Promise<void> {
  await sendMutation({
    type: "set_media_rating",
    fingerprint: params.fingerprint,
    rating: params.rating,
  });
  return;
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
  await sendMutation({ type: "load_snapshot", id });
  return;
}

export async function getStackSnapshot(): Promise<string> {
  return sendRead<string>({ type: "get_stack_snapshot" }, "stack_snapshot");
}

export async function replaceStack(layersJson: string): Promise<void> {
  await sendMutation({ type: "replace_stack", layers_json: layersJson });
  return;
}

export async function addLayer(kind: string): Promise<number> {
  await sendMutation({ type: "add_layer", kind });
  // New layer is always appended; the LayerStackSnapshot will surface the
  // exact index. Callers should use `state.layers.length - 1` after the
  // snapshot has been applied.
  return -1;
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
  await sendMutation({ type: "apply_gradient_mask", ...params });
  return;
}

// ── P2P Awareness & Sync ──────────────────────────────────────────────────────

export interface AwarenessState {
  display_name: string | null;
  active_fingerprint: string | null;
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
  fingerprint: string | null,
  snapshotId: string | null,
): Promise<void> {
  await sendMutation({
    type: "set_local_awareness",
    display_name: displayName,
    fingerprint,
    snapshot_id: snapshotId,
  });
  return;
}

export async function getPeerAwareness(peerEndpointId: string): Promise<AwarenessState> {
  return sendRead<AwarenessState>(
    { type: "get_peer_awareness", peer_endpoint_id: peerEndpointId },
    "peer_awareness",
  );
}

export async function syncPeerSnapshots(
  peerEndpointId: string,
  fingerprint: string,
): Promise<SyncPeerSnapshotsResult> {
  return sendRead<SyncPeerSnapshotsResult>(
    {
      type: "sync_peer_snapshots",
      peer_endpoint_id: peerEndpointId,
      fingerprint,
    },
    "sync_peer_snapshots_result",
  );
}

export async function applyPeerMetadata(
  peerEndpointId: string,
  fingerprints: string[],
): Promise<void> {
  await sendMutation({
    type: "apply_peer_metadata",
    peer_endpoint_id: peerEndpointId,
    fingerprints,
  });
  return;
}

export async function removeMask(idx: number): Promise<void> {
  await sendMutation({ type: "remove_mask", idx });
  return;
}

export async function createBrushMask(layerIdx: number): Promise<void> {
  await sendMutation({ type: "create_brush_mask", idx: layerIdx });
  return;
}

export async function stampBrushMask(
  layerIdx: number,
  cx: number,
  cy: number,
  radius: number,
  softness: number,
  erase: boolean,
): Promise<void> {
  await sendMutation({
    type: "stamp_brush_mask",
    layer_idx: layerIdx,
    cx,
    cy,
    radius,
    softness,
    erase,
  });
  return;
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
  fingerprint: string;
  position: number;
  added_at: number;
}

export function listCollections(libraryId: string): Promise<Collection[]> {
  return sendRead<Collection[]>(
    { type: "list_collections", library_id: libraryId },
    "collections",
  );
}

export async function createCollection(
  libraryId: string,
  name: string,
): Promise<Collection> {
  // The freshly-minted record lands via the `collection_created` channel
  // notification; correlate by library_id + name (the UI never fires
  // concurrent creates with the same name in the same library).
  return new Promise<Collection>((resolve, reject) => {
    let settled = false;
    const unsub = onChannelMessage("collection_created", (msg) => {
      if (settled) return;
      const collection = msg.collection as Collection | undefined;
      if (
        !collection ||
        collection.library_id !== libraryId ||
        collection.name !== name
      ) {
        return;
      }
      settled = true;
      unsub();
      resolve(collection);
    });
    sendMutation({ type: "create_collection", library_id: libraryId, name }).catch(
      (err) => {
        if (settled) return;
        settled = true;
        unsub();
        reject(err);
      },
    );
  });
}

export async function renameCollection(
  collectionId: string,
  name: string,
): Promise<void> {
  await sendMutation({
    type: "rename_collection",
    collection_id: collectionId,
    name,
  });
}

export async function deleteCollection(collectionId: string): Promise<void> {
  await sendMutation({ type: "delete_collection", collection_id: collectionId });
}

export async function reorderCollection(
  collectionId: string,
  newPosition: number,
): Promise<void> {
  await sendMutation({
    type: "reorder_collection",
    collection_id: collectionId,
    new_position: newPosition,
  });
}

export function listCollectionItems(collectionId: string): Promise<CollectionItem[]> {
  return sendRead<CollectionItem[]>(
    { type: "list_collection_items", collection_id: collectionId },
    "collection_items",
  );
}

export async function addToCollection(
  collectionId: string,
  fingerprints: string[],
): Promise<void> {
  await sendMutation({
    type: "add_to_collection",
    collection_id: collectionId,
    fingerprints,
  });
}

export async function removeFromCollection(
  collectionId: string,
  fingerprints: string[],
): Promise<void> {
  await sendMutation({
    type: "remove_from_collection",
    collection_id: collectionId,
    fingerprints,
  });
}
