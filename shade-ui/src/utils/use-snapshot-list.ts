import { createResource, createRoot, type InitializedResource } from "solid-js";
import { onChannelMessage } from "../bridge/channel";
import * as bridge from "../bridge/index";
import { getSelectedArtboard } from "./editor-store";
import type { SnapshotInfo } from "../types";

function currentImagePath(): string | null {
  const artboard = getSelectedArtboard();
  return artboard?.source.kind === "path" ? artboard.source.path : null;
}

const { snapshots, refetch } = createRoot(() => {
  const [resource, { refetch }] = createResource(
    currentImagePath,
    (imagePath) => bridge.listSnapshots(imagePath),
    { initialValue: [] as SnapshotInfo[] },
  );
  onChannelMessage("snapshot_saved", () => {
    void refetch();
  });
  return { snapshots: resource, refetch };
});

export function useSnapshotList(): {
  snapshots: InitializedResource<SnapshotInfo[]>;
  refetch: () => Promise<void>;
  saveSnapshot: () => Promise<unknown>;
} {
  return {
    snapshots,
    refetch: async () => {
      await refetch();
    },
    saveSnapshot,
  };
}

// ── Mutations ───────────────────────────────────────────────────────────────
// Snapshot writes funnel through this module. Rust emits `snapshot_saved` after
// each save, which triggers the auto-refetch wired above.

function saveSnapshot(): Promise<unknown> {
  return bridge.saveSnapshot(currentImagePath());
}
