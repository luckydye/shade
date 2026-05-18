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
  text?: TextLayerValues | null;
}

export interface CropValues {
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
}

export type TextAlignName = "left" | "center" | "right" | "justify";
export type TextAnchorName =
  | "top-left"
  | "top-center"
  | "top-right"
  | "center-left"
  | "center"
  | "center-right"
  | "bottom-left"
  | "bottom-center"
  | "bottom-right"
  | "baseline-left"
  | "baseline-center"
  | "baseline-right";

export interface TextStyleValues {
  /** Font ID into the LayerStack font registry (decoded `u64` as JS number). */
  font_id: number;
  size_px: number;
  line_height: number;
  letter_spacing: number;
  /** `null` disables wrapping. */
  max_width: number | null;
  align: TextAlignName;
  anchor: TextAnchorName;
  /** OpenType weight (100..=900). */
  weight: number;
  italic: boolean;
  /** Linear sRGB straight alpha - `[r, g, b, a]`. */
  color: [number, number, number, number];
}

export interface TextTransformValues {
  tx: number;
  ty: number;
  scale_x: number;
  scale_y: number;
  rotation: number;
}

export interface TextLayerValues {
  content: string;
  style: TextStyleValues;
  transform: TextTransformValues;
  /** Layout-derived AABB in canvas pixels (translation applied). `null` when
   *  the layer is empty or no font is registered. */
  bounds?: TextBoundsValues | null;
}

export interface TextBoundsValues {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface FontInfo {
  font_id: number;
  family: string;
  /** Decimal-encoded `u64` content hash (FNV-1a over the blob). */
  blob_hash: string;
}

/** Partial style update - undefined fields leave the corresponding style
 * field unchanged. To clear `max_width`, set it to `null` explicitly. */
export interface TextStylePatch {
  font_id?: number;
  size_px?: number;
  line_height?: number;
  letter_spacing?: number;
  max_width?: number | null;
  align?: TextAlignName;
  anchor?: TextAnchorName;
  weight?: number;
  italic?: boolean;
  color?: [number, number, number, number];
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
  getImageSource(path: string): Promise<{ bytes: ArrayBuffer; fileName: string | null }>;
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

export interface BatchExportItem {
  path: string;
  fingerprint: string | null;
  name: string;
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

export interface MaskThumbnail {
  pixels: number[];
  width: number;
  height: number;
}

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

export interface PreviewCropMessage {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ArtboardViewport {
  artboard_id: string;
  crop: PreviewCropMessage;
  target_width: number;
  target_height: number;
  priority?: number;
  ignore_crop_layers?: boolean;
}

export type PreviewQuality = "interactive" | "final";

export interface AwarenessStateMessage {
  cursor?: [number, number] | null;
  selection?: string | null;
}

export type ChannelMessage =
  | {
      type: "update_preview_viewports";
      generation: number;
      quality: PreviewQuality;
      viewports: ArtboardViewport[];
    }
  | {
      type: "library_scan_progress";
      library_id: string;
      scanned: number;
      total: number;
    }
  | { type: "library_scan_complete"; library_id: string }
  | {
      type: "library_sync_progress";
      library_id: string;
      total: number;
      completed: number;
      current_name?: string | null;
    }
  | { type: "image_open_phase"; phase: string }
  | { type: "thumbnail_ready"; path: string; edit_fingerprint: string }
  | {
      type: "batch_export_progress";
      current: number;
      total: number;
      name: string;
      error?: string | null;
    }
  | { type: "batch_completed"; kind: string; count: number }
  | { type: "peer_paired"; peer_id: string; name: string }
  | {
      type: "peer_awareness_update";
      peer_id: string;
      state: AwarenessStateMessage;
    }
  | { type: "collection_changed"; collection_id: string }
  | { type: "preset_list_changed" }
  | { type: "camera_hosts_changed"; hosts: string[] }
  | { type: "layer_stack_snapshot"; stack: unknown }
  | { type: "media_metadata_changed"; fingerprints: string[] }
  | { type: "collection_list_changed" }
  | { type: "collection_created"; collection: unknown }
  | { type: "snapshot_saved"; fingerprint: string | null; id: string }
  | { type: "media_libraries_changed" }
  | { type: "media_library_upserted"; library: unknown }
  | {
      type: "read_response";
      read_id: number;
      kind: string;
      value: unknown;
      done: boolean;
    }
  | { type: "read_failed"; read_id: number; message: string };

export type ApplyEditPayload = Record<string, unknown>;
export type ApplyGradientMaskPayload = Record<string, unknown>;
export type StampBrushMaskPayload = Record<string, unknown>;

export type MutationRequest =
  | { type: "add_layer"; kind: string }
  | { type: "delete_layer"; idx: number }
  | { type: "move_layer"; from: number; to: number }
  | { type: "set_layer_visible"; idx: number; visible: boolean }
  | { type: "set_layer_opacity"; idx: number; opacity: number }
  | { type: "rename_layer"; idx: number; name: string | null }
  | { type: "replace_stack"; layers_json: string }
  | ({ type: "apply_edit" } & ApplyEditPayload)
  | ({ type: "apply_gradient_mask" } & ApplyGradientMaskPayload)
  | { type: "remove_mask"; idx: number }
  | { type: "create_brush_mask"; idx: number }
  | ({ type: "stamp_brush_mask" } & StampBrushMaskPayload)
  | { type: "load_snapshot"; id: string }
  | { type: "load_preset"; name: string }
  | { type: "apply_preset_snapshot"; name: string }
  | { type: "add_text_layer"; content: string; font_id: number; size_px: number }
  | { type: "update_text_content"; layer_idx: number; content: string }
  | ({ type: "update_text_style" } & Record<string, unknown>)
  | {
      type: "set_text_transform";
      layer_idx: number;
      tx: number;
      ty: number;
      scale_x: number;
      scale_y: number;
      rotation: number;
    }
  | { type: "add_font"; family: string; bytes: number[] }
  | { type: "prune_unused_fonts" }
  | { type: "set_media_rating"; fingerprint: string; rating: number | null }
  | { type: "set_media_tags"; fingerprint: string; tags: string[] }
  | {
      type: "apply_peer_metadata";
      peer_endpoint_id: string;
      fingerprints: string[];
    }
  | { type: "save_preset"; name: string }
  | { type: "save_preset_from_json"; name: string; json: string }
  | { type: "rename_preset"; old_name: string; new_name: string }
  | { type: "delete_preset"; name: string }
  | { type: "create_collection"; library_id: string; name: string }
  | { type: "rename_collection"; collection_id: string; name: string }
  | { type: "delete_collection"; collection_id: string }
  | { type: "reorder_collection"; collection_id: string; new_position: number }
  | { type: "add_to_collection"; collection_id: string; fingerprints: string[] }
  | {
      type: "remove_from_collection";
      collection_id: string;
      fingerprints: string[];
    }
  | { type: "save_snapshot" }
  | {
      type: "batch_apply_preset_snapshot";
      items: { path: string; fingerprint: string | null }[];
      name: string;
    }
  | { type: "batch_clear_edits"; paths: string[] }
  | {
      type: "batch_export_images";
      items: { path: string; fingerprint: string | null; name: string }[];
      target_dir: string;
    }
  | { type: "add_media_library"; path: string }
  | { type: "add_s3_media_library"; params: unknown }
  | { type: "update_s3_media_library"; library_id: string; params: unknown }
  | { type: "set_media_library_order"; library_order: string[] }
  | {
      type: "set_library_mode";
      library_id: string;
      mode: string;
      sync_target: string | null;
    }
  | { type: "sync_library"; library_id: string }
  | { type: "refresh_library_index"; library_id: string }
  | { type: "delete_media_library_item"; path: string }
  | { type: "remove_media_library"; id: string }
  | {
      type: "upload_media_library_url";
      library_id: string;
      url: string;
      file_name: string;
    }
  | {
      type: "upload_media_library_file";
      library_id: string;
      file_name: string;
      bytes: number[];
      modified_at: number | null;
      append_timestamp_on_conflict: boolean;
    }
  | { type: "upload_media_library_path"; library_id: string; path: string }
  | { type: "pair_peer_device"; peer_endpoint_id: string }
  | {
      type: "set_local_awareness";
      display_name: string | null;
      fingerprint: string | null;
      snapshot_id: string | null;
    };

export type ReadRequest =
  | { type: "list_pictures" }
  | { type: "list_media_libraries" }
  | { type: "list_library_images"; library_id: string }
  | { type: "list_media_ratings"; fingerprints: string[] }
  | { type: "list_presets" }
  | { type: "list_snapshots" }
  | { type: "list_collections"; library_id: string }
  | { type: "list_collection_items"; collection_id: string }
  | { type: "list_peer_pictures"; peer_endpoint_id: string }
  | { type: "get_local_peer_discovery_snapshot" }
  | { type: "get_s3_media_library"; library_id: string }
  | { type: "get_preset_json"; name: string }
  | { type: "get_snapshot_preset_json"; fingerprint: string }
  | { type: "get_peer_awareness"; peer_endpoint_id: string }
  | { type: "get_stack_snapshot" }
  | { type: "list_fonts" }
  | {
      type: "sync_peer_snapshots";
      peer_endpoint_id: string;
      fingerprint: string;
    };

export interface UpdatePreviewViewportsArgs {
  generation: number;
  quality: PreviewQuality;
  viewports: ArtboardViewport[];
  use_float16?: boolean;
}

export interface Transport {
  /** Send a fire-and-forget mutation. Results flow back via `onMessage`. */
  sendMutation(request: MutationRequest): Promise<void>;
  /** Send a read request. Results flow back via `onMessage` as ReadResponse. */
  sendRead(readId: number, request: ReadRequest): Promise<void>;
  /** Subscribe to incoming ChannelMessages. Returns an unsubscribe fn. */
  onMessage(handler: (msg: ChannelMessage) => void): () => void;
  /**
   * Send a viewport-state update for the preview scheduler. Fire-and-forget;
   * resulting frames are pushed back via the preview channel. The web
   * implementation may no-op - its preview pipeline doesn't route through
   * `update_preview_viewports`.
   */
  sendPreviewViewports(args: UpdatePreviewViewportsArgs): void;
}

export interface HostHooks {
  // ── DOM-gated host APIs ─────────────────────────────────────────────
  pickDirectory(): Promise<string | null>;
  pickExportTarget(): Promise<string | null>;
  listenNativeDragDrop(
    listener: (payload: NativeDragDropPayload) => void,
  ): Promise<() => void>;

  // ── Library listing cache ───────────────────────────────────────────
  getCachedLocalLibraryItems(libraryId: string): Promise<LibraryImage[]>;
  loadLocalLibraryItemsCachedOrRemote(libraryId: string): Promise<LibraryImageListing>;
  getCachedCameraLibraryItems(host: string): Promise<LibraryImage[]>;
  loadCameraLibraryItemsCachedOrRemote(host: string): Promise<LibraryImage[]>;
  getCachedPeerLibraryItems(peerId: string): Promise<SharedPicture[]>;
  loadPeerLibraryItemsCachedOrRemote(peerId: string): Promise<SharedPicture[]>;
  removePeerLibrary(peerId: string): Promise<void>;

  // ── Thumbnail-src resolution ────────────────────────────────────────
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

  // ── Image lifecycle (open/export/preview/mask thumbnail) ────────────
  // Truly platform-specific: Tauri uses direct invoke, web uses a worker
  // pipeline backed by OPFS files + wasm decode.
  openImage(path: string): Promise<OpenImageInfo>;
  openImageFile(file: File): Promise<OpenImageInfo>;
  openPeerImage(peerEndpointId: string, picture: SharedPicture): Promise<OpenImageInfo>;
  prepareImageOpen(path: string): Promise<void>;
  exportImage(path: string): Promise<void>;
  renderPreview(request?: PreviewRequest): Promise<PreviewFrame>;
  getLayerStack(): Promise<StackInfo>;
  getMaskThumbnail(layerIdx: number, maxW: number, maxH: number): Promise<MaskThumbnail>;
  restoreCurrentBrowserSnapshot(imagePath: string): Promise<boolean>;
}
