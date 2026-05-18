/**
 * Host-thread capabilities that can't be carried over the message transport.
 *
 * Two categories live here:
 *
 *   * DOM APIs that require a user gesture (file pickers, drag/drop) and any
 *     external `BrowserFileHandle`-like resources — they must execute on the
 *     consumer's main thread.
 *   * Library-listing cache + thumbnail-src resolvers. The cache shape is the
 *     same on both consumers but the storage strategy diverges (in-memory
 *     wrappers around Tauri IPC vs IndexedDB-backed offline-capable browser
 *     storage). Thumbnail sources are likewise platform-specific:
 *     `shade://thumb/...` URLs on Tauri vs `URL.createObjectURL(blob)` on
 *     the web.
 *
 * `HostHooks` is the single surface where shade-ui exposes these to the
 * consumer.
 */

import type { HostHooks } from "../types";

let _host: HostHooks | null = null;

export function setHostHooks(hooks: HostHooks): void {
  _host = hooks;
}

export function getHostHooks(): HostHooks {
  if (!_host) {
    throw new Error("host hooks not installed");
  }
  return _host;
}
