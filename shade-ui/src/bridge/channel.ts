/**
 * Coordination channel — metadata-only IPC plane.
 *
 * Rust → JS: incoming messages dispatched by tagged `type`.
 * JS → Rust: emitted via invoke (`update_preview_viewports` etc.) — see
 *   `bridge/preview.ts` for the JS→Rust send paths.
 *
 * The actual transport is provided by the platform (the Tauri runtime wires
 * `@tauri-apps/api/core` Channel; the browser runtime is a no-op).
 */

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

export interface LibraryImageListingMetadata {
  has_snapshots?: boolean;
  latest_snapshot_id?: string | null;
  latest_snapshot_created_at?: number | null;
  rating?: number | null;
  tags?: string[];
}

export interface LibraryImageListing {
  path: string;
  name: string;
  modified_at?: number | null;
  fingerprint?: string | null;
  metadata?: LibraryImageListingMetadata;
}

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
      type: "library_list_chunk";
      request_id: number;
      items: LibraryImageListing[];
      done: boolean;
    }
  | { type: "thumbnail_ready"; path: string; edit_fingerprint: string }
  | {
      type: "batch_export_progress";
      current: number;
      total: number;
      name: string;
      error?: string | null;
    }
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
  | { type: "media_metadata_changed"; fingerprints: string[] };

type MessageType = ChannelMessage["type"];

type Handler<T extends MessageType> = (
  msg: Extract<ChannelMessage, { type: T }>,
) => void;

type AnyHandler = (msg: ChannelMessage) => void;

const handlers = new Map<MessageType, Set<AnyHandler>>();
let dispatcherInstalled = false;

function dispatch(msg: ChannelMessage) {
  const set = handlers.get(msg.type);
  if (!set) return;
  for (const fn of set) {
    try {
      fn(msg);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`[channel] handler for ${msg.type} threw`, err);
    }
  }
}

/**
 * Subscribe to one variant of `ChannelMessage`. Returns an unsubscribe fn.
 */
export function onChannelMessage<T extends MessageType>(
  type: T,
  handler: Handler<T>,
): () => void {
  let set = handlers.get(type);
  if (!set) {
    set = new Set();
    handlers.set(type, set);
  }
  const wrapped = handler as unknown as AnyHandler;
  set.add(wrapped);
  return () => {
    set!.delete(wrapped);
  };
}

/**
 * Install the platform's coordination channel and route incoming messages
 * into the dispatcher. Idempotent.
 */
export async function installCoordinationChannel(
  register: (handler: (msg: ChannelMessage) => void) => Promise<void>,
): Promise<void> {
  if (dispatcherInstalled) return;
  dispatcherInstalled = true;
  await register(dispatch);
}

/**
 * Build the URL for a thumbnail served by the Rust-side `shade://thumb` custom
 * protocol handler. The `editFingerprint` is part of the cache key — passing
 * a new fingerprint forces the browser image pipeline to re-fetch.
 */
export function shadeThumbnailUrl(
  path: string,
  editFingerprint?: string | null,
): string {
  const encoded = encodeURIComponent(path);
  const base = `shade://thumb/${encoded}`;
  if (!editFingerprint) return base;
  return `${base}?edit=${encodeURIComponent(editFingerprint)}`;
}

export function shadePeerThumbnailUrl(
  peerId: string,
  path: string,
  editFingerprint?: string | null,
): string {
  const encoded = encodeURIComponent(path);
  const base = `shade://thumb/peer/${encodeURIComponent(peerId)}/${encoded}`;
  if (!editFingerprint) return base;
  return `${base}?edit=${encodeURIComponent(editFingerprint)}`;
}

export function shadeCameraThumbnailUrl(host: string, path: string): string {
  return `shade://thumb/camera/${encodeURIComponent(host)}/${encodeURIComponent(path)}`;
}

// ── Mutation protocol ────────────────────────────────────────────────────────
// Editor-state mutations sent from JS to Rust. The Tauri transport is a single
// invoke endpoint (`dispatch_mutation`); a future worker backend can carry the
// same tagged payload over `postMessage`. Results land via channel
// notifications (`LayerStackSnapshot`, and later `SnapshotSaved` etc.) — no
// return value, fire-and-forget on the caller's side.

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
  | { type: "set_media_rating"; fingerprint: string; rating: number | null }
  | { type: "set_media_tags"; fingerprint: string; tags: string[] }
  | {
      type: "apply_peer_metadata";
      peer_endpoint_id: string;
      fingerprints: string[];
    };

/**
 * Send an editor-state mutation. Fire-and-forget: the returned Promise
 * resolves once Rust has acknowledged the dispatch, but state updates land
 * via the `LayerStackSnapshot` channel message.
 */
export async function sendMutation(
  invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>,
  request: MutationRequest,
): Promise<void> {
  await invoke("dispatch_mutation", { request });
}
