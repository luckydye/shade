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
  | { type: "media_metadata_changed"; fingerprints: string[] }
  | { type: "collection_list_changed" }
  | { type: "collection_created"; collection: unknown }
  | { type: "snapshot_saved"; fingerprint: string | null; id: string }
  | { type: "media_libraries_changed" }
  | {
      type: "read_response";
      read_id: number;
      kind: string;
      value: unknown;
      done: boolean;
    }
  | { type: "read_failed"; read_id: number; message: string };

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

// ── Read protocol ────────────────────────────────────────────────────────────
// Reads (list_*/get_*) ride the same bidirectional channel concept as
// mutations: the consumer sends a request through `dispatch_read` and the
// producer pushes the typed result back as a `read_response` channel message
// keyed by `read_id`. Worker-portable: a future backend can ferry the same
// request/result envelopes over `postMessage`.

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
  | {
      type: "sync_peer_snapshots";
      peer_endpoint_id: string;
      fingerprint: string;
    };

let nextReadId = 1;

/**
 * Send a read request and resolve with the typed payload value. Caller
 * supplies the expected `kind` discriminant — if Rust returns a different
 * kind the Promise rejects.
 */
export async function sendRead<T>(
  invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>,
  request: ReadRequest,
  expectedKind: string,
): Promise<T> {
  const readId = nextReadId++;
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const unsubResponse = onChannelMessage("read_response", (msg) => {
      if (msg.read_id !== readId || settled) return;
      if (!msg.done) return; // ignore intermediate chunks
      settled = true;
      unsubResponse();
      unsubFailed();
      if (msg.kind !== expectedKind) {
        reject(
          new Error(
            `read_response kind mismatch: expected ${expectedKind}, got ${msg.kind}`,
          ),
        );
        return;
      }
      resolve(msg.value as T);
    });
    const unsubFailed = onChannelMessage("read_failed", (msg) => {
      if (msg.read_id !== readId || settled) return;
      settled = true;
      unsubResponse();
      unsubFailed();
      reject(new Error(msg.message));
    });
    invoke("dispatch_read", { readId, request }).catch((err) => {
      if (settled) return;
      settled = true;
      unsubResponse();
      unsubFailed();
      reject(err);
    });
  });
}

/**
 * Send a streaming read request. The producer emits one or more
 * `read_response` messages with the same `read_id`; each carries a chunk of
 * `TItem[]` in `value`. The final message carries `done: true`. The promise
 * resolves with the accumulated items.
 *
 * `onChunk` (optional) fires per chunk for progressive UI updates.
 */
export async function sendChunkedRead<TItem>(
  invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>,
  request: ReadRequest,
  expectedKind: string,
  onChunk?: (chunk: TItem[]) => void,
): Promise<TItem[]> {
  const readId = nextReadId++;
  const items: TItem[] = [];
  return new Promise<TItem[]>((resolve, reject) => {
    let settled = false;
    const unsubResponse = onChannelMessage("read_response", (msg) => {
      if (msg.read_id !== readId || settled) return;
      if (msg.kind !== expectedKind) {
        settled = true;
        unsubResponse();
        unsubFailed();
        reject(
          new Error(
            `read_response kind mismatch: expected ${expectedKind}, got ${msg.kind}`,
          ),
        );
        return;
      }
      const chunk = (msg.value as TItem[]) ?? [];
      items.push(...chunk);
      onChunk?.(chunk);
      if (msg.done) {
        settled = true;
        unsubResponse();
        unsubFailed();
        resolve(items);
      }
    });
    const unsubFailed = onChannelMessage("read_failed", (msg) => {
      if (msg.read_id !== readId || settled) return;
      settled = true;
      unsubResponse();
      unsubFailed();
      reject(new Error(msg.message));
    });
    invoke("dispatch_read", { readId, request }).catch((err) => {
      if (settled) return;
      settled = true;
      unsubResponse();
      unsubFailed();
      reject(err);
    });
  });
}
