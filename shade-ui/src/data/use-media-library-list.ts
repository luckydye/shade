import { createResource, createRoot, type InitializedResource } from "solid-js";
import { onChannelMessage } from "../bridge/channel";
import * as bridge from "../bridge/index";
import {
  type BrowserDirectoryHandle,
  type LibraryMode,
  type MediaLibrary,
  type S3MediaLibraryInput,
} from "../bridge/types";
import { isTauriRuntime } from "../utils";

const { libraries, refetch } = createRoot(() => {
  const [resource, { refetch }] = createResource(bridge.listMediaLibraries, {
    initialValue: [] as MediaLibrary[],
  });
  onChannelMessage("media_libraries_changed", () => {
    void refetch();
  });
  onChannelMessage("media_library_upserted", () => {
    void refetch();
  });
  // Pairing with a new peer adds their library; auto-refresh.
  if (isTauriRuntime()) {
    bridge.listenPeerPaired(() => {
      void refetch();
    });
  }
  return { libraries: resource, refetch };
});

export function useMediaLibraryList(): {
  libraries: InitializedResource<MediaLibrary[]>;
  refetch: () => Promise<void>;
} {
  return {
    libraries,
    refetch: async () => {
      await refetch();
    },
  };
}

// ── Mutations ───────────────────────────────────────────────────────────────
// All media-library writes funnel through this module. Rust emits
// `media_libraries_changed` / `media_library_upserted` after each mutation,
// which triggers the auto-refetch wired above.

export function addMediaLibrary(
  path: string | BrowserDirectoryHandle,
): Promise<MediaLibrary> {
  return bridge.addMediaLibrary(path);
}

export function addS3MediaLibrary(params: S3MediaLibraryInput): Promise<MediaLibrary> {
  return bridge.addS3MediaLibrary(params);
}

export function getS3MediaLibrary(libraryId: string): Promise<S3MediaLibraryInput> {
  return bridge.getS3MediaLibrary(libraryId);
}

export function updateS3MediaLibrary(
  libraryId: string,
  params: S3MediaLibraryInput,
): Promise<MediaLibrary> {
  return bridge.updateS3MediaLibrary(libraryId, params);
}

export function removeMediaLibrary(id: string): Promise<void> {
  return bridge.removeMediaLibrary(id);
}

export function removePeerLibrary(peerId: string): Promise<void> {
  return bridge.removePeerLibrary(peerId);
}

export function setLibraryMode(
  libraryId: string,
  mode: LibraryMode,
  syncTarget?: string | null,
): Promise<void> {
  return bridge.setLibraryMode(libraryId, mode, syncTarget);
}

export function syncLibrary(libraryId: string): Promise<void> {
  return bridge.syncLibrary(libraryId);
}

export function setMediaLibraryOrder(libraryOrder: string[]): Promise<void> {
  return bridge.setMediaLibraryOrder(libraryOrder);
}

export function refreshLibraryIndex(libraryId: string): Promise<void> {
  return bridge.refreshLibraryIndex(libraryId);
}

export function pickDirectory(): Promise<string | null> {
  return bridge.pickDirectory();
}
