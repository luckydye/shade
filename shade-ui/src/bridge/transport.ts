/**
 * Bridge transport abstraction.
 *
 * The consumer of shade-ui (currently `shade-tauri/ui-src/main.tsx` and
 * `shade-web/src/main.tsx`) installs a `Transport` that carries the unified
 * message protocol — `MutationRequest`, `ReadRequest`, and `ChannelMessage`.
 *
 * On Tauri the transport wraps `invoke` + `@tauri-apps/api/core` Channel.
 * On the web it wraps a `Worker` + `postMessage` (or, initially, an in-process
 * adapter that delegates to the legacy `BrowserPlatform` code).
 *
 * shade-ui itself never knows which one is in use.
 */

import type { ChannelMessage, MutationRequest, ReadRequest } from "./channel";
import type { UpdatePreviewViewportsArgs } from "./preview";

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
   * implementation may no-op — its preview pipeline doesn't route through
   * `update_preview_viewports`.
   */
  sendPreviewViewports(args: UpdatePreviewViewportsArgs): void;
}

let _transport: Transport | null = null;

export function setTransport(transport: Transport): void {
  _transport = transport;
}

export function getTransport(): Transport {
  if (!_transport) {
    throw new Error("bridge transport not installed");
  }
  return _transport;
}

export function hasTransport(): boolean {
  return _transport !== null;
}
