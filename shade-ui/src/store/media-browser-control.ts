export interface MediaBrowserController {
  selectLibrary(libraryId: string): void;
  getSelectedLibraryId(): string | null;
}

let controller: MediaBrowserController | null = null;

export function registerMediaBrowserController(
  next: MediaBrowserController,
): () => void {
  controller = next;
  return () => {
    if (controller === next) {
      controller = null;
    }
  };
}

export function getMediaBrowserController() {
  if (!controller) {
    throw new Error("media browser controller is not registered");
  }
  return controller;
}
