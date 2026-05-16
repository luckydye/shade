import { createResource, createRoot, type InitializedResource } from "solid-js";
import { onChannelMessage } from "../bridge/channel";
import {
  listMediaLibraries as fetchMediaLibraries,
  type MediaLibrary,
} from "../bridge/index";

const { libraries, refetch } = createRoot(() => {
  const [resource, { refetch }] = createResource(fetchMediaLibraries, {
    initialValue: [] as MediaLibrary[],
  });
  onChannelMessage("media_libraries_changed", () => {
    void refetch();
  });
  onChannelMessage("media_library_upserted", () => {
    void refetch();
  });
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
