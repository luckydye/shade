import { useMediaViewStore } from "../store/media-view-store";

export function useCurrentLibrary() {
  return useMediaViewStore().selectedLibrary;
}
