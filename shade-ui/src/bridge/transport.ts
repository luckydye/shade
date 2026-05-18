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

import type { Transport } from "../types";

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
