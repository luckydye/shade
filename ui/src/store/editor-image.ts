import * as bridge from "../bridge/index";
import { fullCanvasCrop, setState, state } from "./editor-store";
import { clearPreviewTiles, refreshPreview } from "../viewport/preview";
import { refreshLayerStack } from "./editor-layers";

function resetViewportState(canvasWidth: number, canvasHeight: number) {
  const crop = fullCanvasCrop(canvasWidth, canvasHeight);
  setState({
    canvasWidth,
    canvasHeight,
    viewportZoom: 1,
    viewportCenterX: crop.width * 0.5,
    viewportCenterY: crop.height * 0.5,
    crop,
    cropDraft: null,
    isCropMode: false,
  });
}

function clearLoadedImageState() {
  clearPreviewTiles();
  setState({
    layers: [],
    canvasWidth: 0,
    canvasHeight: 0,
    selectedLayerIdx: -1,
    viewportZoom: 1,
    viewportCenterX: 0,
    viewportCenterY: 0,
    previewRenderWidth: 0,
    previewRenderHeight: 0,
    previewDisplayColorSpace: "Unknown",
    sourceBitDepth: "Unknown",
    crop: { x: 0, y: 0, width: 0, height: 0, rotation: 0 },
    cropDraft: null,
    isCropMode: false,
  });
}

async function openImageFrom(
  load: () => Promise<{
    canvas_width: number;
    canvas_height: number;
    source_bit_depth: string;
  }>,
  loadingMediaSrc: string | null,
  activeMediaSelection: {
    libraryId: string;
    itemId: string;
  } | null,
) {
  clearLoadedImageState();
  setState({
    currentView: "editor",
    activeMediaLibraryId: activeMediaSelection?.libraryId ?? null,
    activeMediaItemId: activeMediaSelection?.itemId ?? null,
    isLoading: true,
    loadingMediaSrc,
  });
  try {
    const info = await load();
    resetViewportState(info.canvas_width, info.canvas_height);
    setState("sourceBitDepth", info.source_bit_depth);
    await refreshLayerStack();
    await refreshPreview();
  } finally {
    if (loadingMediaSrc?.startsWith("blob:")) {
      URL.revokeObjectURL(loadingMediaSrc);
    }
    setState({
      isLoading: false,
      loadingMediaSrc: null,
    });
  }
}

export function closeImage() {
  clearLoadedImageState();
  setState({
    currentView: "media",
    activeMediaLibraryId: null,
    activeMediaItemId: null,
    isLoading: false,
    loadingMediaSrc: null,
  });
}

export function showMediaView() {
  setState("currentView", "media");
}

export function showEditorView() {
  if (state.canvasWidth <= 0 && !state.isLoading) {
    throw new Error("cannot show editor without a loaded image");
  }
  setState("currentView", "editor");
}

export async function openImage(
  path: string,
  loadingMediaSrc: string | null = null,
  activeMediaSelection: {
    libraryId: string;
    itemId: string;
  } | null = null,
) {
  await openImageFrom(() => bridge.openImage(path), loadingMediaSrc, activeMediaSelection);
}

export async function openImageFile(file: File) {
  await openImageFrom(() => bridge.openImageFile(file), null);
}

export async function openPeerImage(
  peerEndpointId: string,
  picture: bridge.SharedPicture,
  loadingMediaSrc: string | null = null,
  activeMediaSelection: {
    libraryId: string;
    itemId: string;
  } | null = null,
) {
  await openImageFrom(
    () => bridge.openPeerImage(peerEndpointId, picture),
    loadingMediaSrc,
    activeMediaSelection,
  );
}

export async function exportImage(path: string) {
  await bridge.exportImage(path);
}

export async function pickExportTarget() {
  return bridge.pickExportTarget();
}
