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

import type { LibraryImage, LibraryImageListing, SharedPicture } from "./index";

export type DragDropPayloadType = "enter" | "over" | "drop" | "leave";

export interface NativeDragDropPayload {
  type: DragDropPayloadType;
  paths: string[];
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
  loadLocalLibraryItemsCachedOrRemote(
    libraryId: string,
  ): Promise<LibraryImageListing>;
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
}

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
