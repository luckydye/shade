import { createResource, createRoot, type InitializedResource } from "solid-js";
import * as bridge from "../bridge/index";
import type { FontInfo } from "../types";
import { useLayerStack } from "./use-layer-stack";

const { fonts, refetch } = createRoot(() => {
  const [resource, { refetch }] = createResource(bridge.listFonts, {
    initialValue: [] as FontInfo[],
  });
  return { fonts: resource, refetch };
});

export function useFontList(): {
  fonts: InitializedResource<FontInfo[]>;
  refetch: () => Promise<void>;
  addFont: (family: string, bytes: Uint8Array) => Promise<number>;
  pruneUnusedFonts: () => Promise<void>;
} {
  return {
    fonts,
    refetch: async () => {
      await refetch();
    },
    addFont,
    pruneUnusedFonts,
  };
}

// ── Mutations ───────────────────────────────────────────────────────────────
// No Rust channel for font changes — mutations explicitly refetch.

async function addFont(family: string, bytes: Uint8Array): Promise<number> {
  const id = await bridge.addFont(family, bytes);
  await refetch();
  return id;
}

async function pruneUnusedFonts(): Promise<void> {
  await bridge.pruneUnusedFonts();
  // The dispatched mutation discards Rust's count; refresh unconditionally
  // (cheap) and snapshot history so an undoable point exists if anything
  // actually changed. A no-op prune just costs one extra list_fonts read.
  await refetch();
  useLayerStack().queueHistorySnapshot();
}
