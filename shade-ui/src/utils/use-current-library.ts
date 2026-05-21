import { useMediaViewStore } from "./media-view-store";

export function useCurrentLibrary() {
  return useMediaViewStore().selectedLibrary;
}
