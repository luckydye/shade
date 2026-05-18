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

import type { ChannelMessage, MutationRequest, ReadRequest } from "../types";

type MessageType = ChannelMessage["type"];

type Handler<T extends MessageType> = (msg: Extract<ChannelMessage, { type: T }>) => void;

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
export function shadeThumbnailUrl(path: string, editFingerprint?: string | null): string {
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

/**
 * Send an editor-state mutation. Fire-and-forget: the returned Promise
 * resolves once the transport has acknowledged the dispatch, but state
 * updates land via the `LayerStackSnapshot` channel message.
 */
export async function sendMutation(request: MutationRequest): Promise<void> {
  const { getTransport } = await import("./transport");
  await getTransport().sendMutation(request);
}

// ── Read protocol ────────────────────────────────────────────────────────────
// Reads (list_*/get_*) ride the same bidirectional channel concept as
// mutations: the consumer sends a request through `dispatch_read` and the
// producer pushes the typed result back as a `read_response` channel message
// keyed by `read_id`. Worker-portable: a future backend can ferry the same
// request/result envelopes over `postMessage`.

let nextReadId = 1;

/**
 * Send a read request and resolve with the typed payload value. Caller
 * supplies the expected `kind` discriminant — if Rust returns a different
 * kind the Promise rejects.
 */
export async function sendRead<T>(
  request: ReadRequest,
  expectedKind: string,
): Promise<T> {
  const { getTransport } = await import("./transport");
  const transport = getTransport();
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
    transport.sendRead(readId, request).catch((err) => {
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
  request: ReadRequest,
  expectedKind: string,
  onChunk?: (chunk: TItem[]) => void,
): Promise<TItem[]> {
  const { getTransport } = await import("./transport");
  const transport = getTransport();
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
    transport.sendRead(readId, request).catch((err) => {
      if (settled) return;
      settled = true;
      unsubResponse();
      unsubFailed();
      reject(err);
    });
  });
}

/**
 * Install the transport's coordination-channel handler. Idempotent — only
 * the first call registers; subsequent calls are no-ops.
 */
export async function installCoordinationChannelFromTransport(): Promise<void> {
  if (dispatcherInstalled) return;
  dispatcherInstalled = true;
  const { getTransport } = await import("./transport");
  getTransport().onMessage(dispatch);
}
