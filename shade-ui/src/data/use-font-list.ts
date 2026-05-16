import { createResource, createRoot, type InitializedResource } from "solid-js";
import { type FontInfo, listFonts as fetchFonts } from "../bridge/index";

const { fonts, refetch } = createRoot(() => {
  const [resource, { refetch }] = createResource(fetchFonts, {
    initialValue: [] as FontInfo[],
  });
  return { fonts: resource, refetch };
});

export function useFontList(): {
  fonts: InitializedResource<FontInfo[]>;
  refetch: () => Promise<void>;
} {
  return {
    fonts,
    refetch: async () => {
      await refetch();
    },
  };
}
