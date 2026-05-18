/**
 * Unified bridge: uses Tauri IPC when running as a desktop app,
 * falls back to a browser worker when running on the web.
 */

import type {
  AwarenessState,
  BatchExportItem,
  BatchExportProgress,
  BrowserDirectoryHandle,
  Collection,
  CollectionItem,
  EditSnapshotInfo,
  FontInfo,
  GradientMaskParams,
  LibraryImage,
  LibraryImageListing,
  LibraryMode,
  LibrarySyncProgress,
  LocalPeerDiscoverySnapshot,
  MaskThumbnail,
  MediaLibrary,
  MediaRatingParams,
  NativeDragDropPayload,
  OpenImageInfo,
  PresetInfo,
  PreviewFrame,
  PreviewRequest,
  S3MediaLibraryInput,
  SharedPicture,
  SnapshotInfo,
  StackInfo,
  SyncPeerSnapshotsResult,
  TextStylePatch,
  TextTransformValues,
} from "../types";
import { isTauriRuntime } from "../utils";
import { onChannelMessage, sendChunkedRead, sendMutation, sendRead } from "./channel";
import { getHostHooks } from "./host";
// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Browser-only synchronous preview render. The Tauri runtime uses the
 * push-based preview channel (`bridge/preview.ts` + `update_preview_viewports`)
 * and does not go through this path.
 */
export async function renderPreview(request?: PreviewRequest): Promise<PreviewFrame> {
  const { getHostHooks } = await import("./host");
  return getHostHooks().renderPreview(request);
}

export async function openImage(path: string): Promise<OpenImageInfo> {
  const { getHostHooks } = await import("./host");
  return getHostHooks().openImage(path);
}

export async function prepareImageOpen(path: string): Promise<void> {
  const { getHostHooks } = await import("./host");
  return getHostHooks().prepareImageOpen(path);
}

export async function exportImage(path: string): Promise<void> {
  const { getHostHooks } = await import("./host");
  return getHostHooks().exportImage(path);
}

export async function pickDirectory(): Promise<string | null> {
  const { getHostHooks } = await import("./host");
  return getHostHooks().pickDirectory();
}

export async function pickExportTarget(): Promise<string | null> {
  const { getHostHooks } = await import("./host");
  return getHostHooks().pickExportTarget();
}

export async function listenNativeDragDrop(
  listener: (payload: NativeDragDropPayload) => void,
): Promise<() => void> {
  const { getHostHooks } = await import("./host");
  return getHostHooks().listenNativeDragDrop(listener);
}

export function listenPeerPaired(listener: () => void): () => void {
  return onChannelMessage("peer_paired", () => listener());
}

export function listenLibraryScanComplete(
  listener: (libraryId: string) => void,
): () => void {
  return onChannelMessage("library_scan_complete", (msg) => {
    listener(msg.library_id);
  });
}

export function listenLibraryScanProgress(
  listener: (libraryId: string) => void,
): () => void {
  return onChannelMessage("library_scan_progress", (msg) => {
    listener(msg.library_id);
  });
}

export function listenBatchExportProgress(
  listener: (payload: BatchExportProgress) => void,
): () => void {
  return onChannelMessage("batch_export_progress", (msg) => {
    listener({
      total: msg.total,
      completed: msg.current,
      current_name: msg.name || null,
    });
  });
}

export function listenLibrarySyncProgress(
  listener: (payload: LibrarySyncProgress) => void,
): () => void {
  return onChannelMessage("library_sync_progress", (msg) => {
    listener({
      library_id: msg.library_id,
      total: msg.total,
      completed: msg.completed,
      current_name: msg.current_name ?? null,
    });
  });
}

export async function getLocalPeerDiscoverySnapshot(): Promise<LocalPeerDiscoverySnapshot> {
  if (!isTauriRuntime()) {
    return {
      local_endpoint_id: "browser-runtime",
      local_direct_addresses: [],
      peers: [],
    };
  }
  return sendRead<LocalPeerDiscoverySnapshot>(
    { type: "get_local_peer_discovery_snapshot" },
    "local_peer_discovery_snapshot",
  );
}

export async function pairPeerDevice(peer_endpoint_id: string): Promise<void> {
  if (!isTauriRuntime()) {
    return;
  }
  await sendMutation({
    type: "pair_peer_device",
    peer_endpoint_id,
  });
}

export async function listPeerPictures(
  peer_endpoint_id: string,
): Promise<SharedPicture[]> {
  if (!isTauriRuntime()) {
    return [];
  }
  return sendRead<SharedPicture[]>(
    { type: "list_peer_pictures", peer_endpoint_id },
    "peer_pictures",
  );
}

export async function openPeerImage(
  peer_endpoint_id: string,
  picture: SharedPicture,
): Promise<OpenImageInfo> {
  const { getHostHooks } = await import("./host");
  return getHostHooks().openPeerImage(peer_endpoint_id, picture);
}

/** Open an image from a File object — works for both file picker and drag-and-drop. */
export async function openImageFile(file: File): Promise<OpenImageInfo> {
  const { getHostHooks } = await import("./host");
  return getHostHooks().openImageFile(file);
}

export async function getLayerStack(): Promise<StackInfo> {
  const { getHostHooks } = await import("./host");
  return getHostHooks().getLayerStack();
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

export async function listMediaLibraries(): Promise<MediaLibrary[]> {
  return sendRead<MediaLibrary[]>({ type: "list_media_libraries" }, "media_libraries");
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
  if (!isTauriRuntime()) {
    throw new Error("S3 media libraries are only implemented for Tauri");
  }
  const upserted = awaitMediaLibraryUpserted();
  await sendMutation({ type: "add_s3_media_library", params });
  return upserted;
}

export async function getS3MediaLibrary(libraryId: string): Promise<S3MediaLibraryInput> {
  if (!isTauriRuntime()) {
    throw new Error("S3 media libraries are only implemented for Tauri");
  }
  return sendRead<S3MediaLibraryInput>(
    { type: "get_s3_media_library", library_id: libraryId },
    "s3_media_library",
  );
}

export async function updateS3MediaLibrary(
  libraryId: string,
  params: S3MediaLibraryInput,
): Promise<MediaLibrary> {
  if (!isTauriRuntime()) {
    throw new Error("S3 media libraries are only implemented for Tauri");
  }
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
  if (!isTauriRuntime()) {
    throw new Error("URL image uploads are only implemented for Tauri");
  }
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
  if (!isTauriRuntime()) {
    throw new Error("library uploads are only implemented for Tauri");
  }
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
  if (!isTauriRuntime()) {
    throw new Error("library uploads from paths are only implemented for Tauri");
  }
  await sendMutation({
    type: "upload_media_library_path",
    library_id: libraryId,
    path,
  });
}

export async function deleteMediaLibraryItem(path: string): Promise<void> {
  if (!isTauriRuntime()) {
    throw new Error("media item deletion is only implemented for Tauri");
  }
  await sendMutation({ type: "delete_media_library_item", path });
}

export async function removeMediaLibrary(id: string): Promise<void> {
  await sendMutation({ type: "remove_media_library", id });
  return;
}

export function getCachedLocalLibraryItems(libraryId: string): Promise<LibraryImage[]> {
  return getHostHooks().getCachedLocalLibraryItems(libraryId);
}

export function loadLocalLibraryItemsCachedOrRemote(
  libraryId: string,
): Promise<LibraryImageListing> {
  return getHostHooks().loadLocalLibraryItemsCachedOrRemote(libraryId);
}

export function getCachedCameraLibraryItems(host: string): Promise<LibraryImage[]> {
  return getHostHooks().getCachedCameraLibraryItems(host);
}

export function loadCameraLibraryItemsCachedOrRemote(
  host: string,
): Promise<LibraryImage[]> {
  return getHostHooks().loadCameraLibraryItemsCachedOrRemote(host);
}

export function getCachedPeerLibraryItems(peerId: string): Promise<SharedPicture[]> {
  return getHostHooks().getCachedPeerLibraryItems(peerId);
}

export function loadPeerLibraryItemsCachedOrRemote(
  peerId: string,
): Promise<SharedPicture[]> {
  return getHostHooks().loadPeerLibraryItemsCachedOrRemote(peerId);
}

export function removePeerLibrary(peerId: string): Promise<void> {
  return getHostHooks().removePeerLibrary(peerId);
}

export function resolveLocalThumbnailSrc(
  path: string,
  latestSnapshotId: string | null,
  signal: AbortSignal,
): Promise<string> {
  return getHostHooks().resolveLocalThumbnailSrc(path, latestSnapshotId, signal);
}

export function resolveCameraThumbnailSrc(
  path: string,
  latestSnapshotId: string | null,
  signal: AbortSignal,
): Promise<string> {
  return getHostHooks().resolveCameraThumbnailSrc(path, latestSnapshotId, signal);
}

export function resolvePeerThumbnailSrc(
  peerId: string,
  pictureId: string,
  signal: AbortSignal,
): Promise<string> {
  return getHostHooks().resolvePeerThumbnailSrc(peerId, pictureId, signal);
}

export function resetLocalThumbnailFailure(path: string): void {
  getHostHooks().resetLocalThumbnailFailure(path);
}

export function resetCameraThumbnailFailure(path: string): void {
  getHostHooks().resetCameraThumbnailFailure(path);
}

export async function setLibraryMode(
  libraryId: string,
  mode: LibraryMode,
  syncTarget?: string | null,
): Promise<void> {
  if (!isTauriRuntime()) {
    throw new Error("setLibraryMode is only implemented for Tauri");
  }
  await sendMutation({
    type: "set_library_mode",
    library_id: libraryId,
    mode,
    sync_target: syncTarget ?? null,
  });
}

export async function syncLibrary(libraryId: string): Promise<void> {
  if (!isTauriRuntime()) {
    throw new Error("syncLibrary is only implemented for Tauri");
  }
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
  if (!isTauriRuntime()) {
    return;
  }
  await sendMutation({
    type: "refresh_library_index",
    library_id: libraryId,
  });
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

export async function renamePreset(
  oldName: string,
  newName: string,
): Promise<PresetInfo | void> {
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

export async function saveSnapshot(
  imagePath?: string | null,
): Promise<EditSnapshotInfo | void> {
  await sendMutation({ type: "save_snapshot" });
  // Snapshot id surfaces through the SnapshotSaved channel notification.
  return;
}

export async function listSnapshots(imagePath?: string | null): Promise<SnapshotInfo[]> {
  return sendRead<SnapshotInfo[]>({ type: "list_snapshots" }, "snapshots");
}

export async function listMediaRatings(ids: string[]): Promise<Record<string, number>> {
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
  const { getHostHooks } = await import("./host");
  return getHostHooks().restoreCurrentBrowserSnapshot(imagePath);
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

// ── Text layers & fonts ────────────────────────────────────────────────

/** FNV-1a 64-bit — mirrors `shade_lib::text::fnv1a_64`. Used to correlate the
 *  font_id returned by the AddFont mutation with the entry in the subsequent
 *  ListFonts read (which is keyed by content hash on the Rust side). */
function fnv1a64Hex(bytes: Uint8Array): string {
  // BigInt literals with the `n` suffix are blocked by the configured build
  // target; use the `BigInt(...)` constructor instead.
  let h = BigInt("0xcbf29ce484222325");
  const mul = BigInt("0x00000100000001b3");
  const mask = BigInt("0xffffffffffffffff");
  for (let i = 0; i < bytes.length; i++) {
    h = (h ^ BigInt(bytes[i])) & mask;
    h = (h * mul) & mask;
  }
  return h.toString();
}

export async function addTextLayer(
  content: string,
  fontId: number,
  sizePx: number,
): Promise<number> {
  await sendMutation({
    type: "add_text_layer",
    content,
    font_id: fontId,
    size_px: sizePx,
  });
  // Always appended; LayerStackSnapshot lands before the mutation resolves,
  // so callers derive the idx from `state.layers.length - 1`.
  return -1;
}

export async function updateTextContent(
  layerIdx: number,
  content: string,
): Promise<void> {
  await sendMutation({
    type: "update_text_content",
    layer_idx: layerIdx,
    content,
  });
}

export async function updateTextStyle(
  layerIdx: number,
  patch: TextStylePatch,
): Promise<void> {
  await sendMutation({
    type: "update_text_style",
    layer_idx: layerIdx,
    ...patch,
  } as Parameters<typeof sendMutation>[0]);
}

export async function setTextTransform(
  layerIdx: number,
  transform: TextTransformValues,
): Promise<void> {
  await sendMutation({
    type: "set_text_transform",
    layer_idx: layerIdx,
    tx: transform.tx,
    ty: transform.ty,
    scale_x: transform.scale_x,
    scale_y: transform.scale_y,
    rotation: transform.rotation,
  });
}

/** Register a font blob with the LayerStack and return its `font_id`.
 *  Idempotent on contents — the same bytes return the existing id.
 *  Rust dedups by content hash; the wrapper recovers the canonical id from
 *  the registry via `list_fonts` rather than threading the `AddFont` return
 *  value through the mutation dispatcher. */
export async function addFont(family: string, bytes: Uint8Array): Promise<number> {
  const blobHash = fnv1a64Hex(bytes);
  await sendMutation({
    type: "add_font",
    family,
    bytes: Array.from(bytes),
  });
  const fonts = await sendRead<FontInfo[]>({ type: "list_fonts" }, "fonts");
  const match = fonts.find((f) => f.blob_hash === blobHash);
  if (!match) {
    throw new Error("add_font: registered font not found in list_fonts");
  }
  return match.font_id;
}

export async function listFonts(): Promise<FontInfo[]> {
  return sendRead<FontInfo[]>({ type: "list_fonts" }, "fonts");
}

/** Drop fonts that no text layer references. The dispatched mutation
 *  discards Rust's removed-count return; callers that need it can diff
 *  `listFonts` before/after. */
export async function pruneUnusedFonts(): Promise<void> {
  await sendMutation({ type: "prune_unused_fonts" });
}

export async function applyGradientMask(params: GradientMaskParams): Promise<void> {
  await sendMutation({ type: "apply_gradient_mask", ...params });
  return;
}

// ── P2P Awareness & Sync ──────────────────────────────────────────────────────

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
export async function getMaskThumbnail(
  layerIdx: number,
  maxW: number,
  maxH: number,
): Promise<MaskThumbnail> {
  const { getHostHooks } = await import("./host");
  return getHostHooks().getMaskThumbnail(layerIdx, maxW, maxH);
}

// ── Collections ──────────────────────────────────────────────────────────────

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
