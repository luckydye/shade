import { createResource, createRoot, type InitializedResource } from "solid-js";
import { onChannelMessage } from "../bridge/channel";
import { listSnapshots as fetchSnapshots, type SnapshotInfo } from "../bridge/index";
import { getSelectedArtboard } from "../store/editor-store";

function currentImagePath(): string | null {
  const artboard = getSelectedArtboard();
  return artboard?.source.kind === "path" ? artboard.source.path : null;
}

const { snapshots, refetch } = createRoot(() => {
  const [resource, { refetch }] = createResource(
    currentImagePath,
    (imagePath) => fetchSnapshots(imagePath),
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
} {
  return {
    snapshots,
    refetch: async () => {
      await refetch();
    },
  };
}
