import * as bridge from "../bridge/index";
import { fullCanvasCrop, setState, state, type ArtboardSource } from "./editor-store";
import { clearPreviewTiles, refreshPreview } from "../viewport/preview";
import { refreshLayerStack } from "./editor-layers";

const ARTBOARD_GAP = 96;

function createArtboardId() {
  return globalThis.crypto?.randomUUID?.() ?? `artboard-${Date.now()}-${Math.random()}`;
}

function getNextArtboardWorldX() {
  const rightEdge = state.artboards.reduce(
    (max, artboard) => Math.max(max, artboard.worldX + artboard.width),
    0,
  );
  return state.artboards.length === 0 ? 0 : rightEdge + ARTBOARD_GAP;
}

function getArtboardTitle(source: ArtboardSource) {
  switch (source.kind) {
    case "path": {
      const segments = source.path.split(/[\\/]/);
      const name = segments[segments.length - 1];
      return name || source.path;
    }
    case "file":
      return source.file.name;
    case "peer":
      return source.picture.name;
    default:
      throw new Error("unknown artboard source");
  }
}

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
    artboards: [],
    selectedArtboardId: null,
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
  source: ArtboardSource,
  loadingMediaSrc: string | null,
  activeMediaSelection: {
    libraryId: string;
    itemId: string;
  } | null,
) {
  setState({
    currentView: "editor",
    activeMediaLibraryId: activeMediaSelection?.libraryId ?? null,
    activeMediaItemId: activeMediaSelection?.itemId ?? null,
    isLoading: true,
    loadingMediaSrc,
  });
  try {
    const info = await load();
    clearPreviewTiles();
    const artboardId = createArtboardId();
    setState("artboards", (artboards) => [
      ...artboards,
      {
        id: artboardId,
        title: getArtboardTitle(source),
        worldX: getNextArtboardWorldX(),
        worldY: 0,
        width: info.canvas_width,
        height: info.canvas_height,
        sourceBitDepth: info.source_bit_depth,
        source,
        activeMediaLibraryId: activeMediaSelection?.libraryId ?? null,
        activeMediaItemId: activeMediaSelection?.itemId ?? null,
        previewTile: null,
        backdropTile: null,
      },
    ]);
    resetViewportState(info.canvas_width, info.canvas_height);
    setState({
      selectedArtboardId: artboardId,
      sourceBitDepth: info.source_bit_depth,
    });
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
  if (state.selectedArtboardId === null && !state.isLoading) {
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
  await openImageFrom(
    () => bridge.openImage(path),
    { kind: "path", path },
    loadingMediaSrc,
    activeMediaSelection,
  );
}

export async function openImageFile(file: File) {
  await openImageFrom(() => bridge.openImageFile(file), { kind: "file", file }, null, null);
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
    { kind: "peer", peerEndpointId, picture },
    loadingMediaSrc,
    activeMediaSelection,
  );
}

async function loadArtboardSource(source: ArtboardSource) {
  switch (source.kind) {
    case "path":
      return bridge.openImage(source.path);
    case "file":
      return bridge.openImageFile(source.file);
    case "peer":
      return bridge.openPeerImage(source.peerEndpointId, source.picture);
    default:
      throw new Error("unknown artboard source");
  }
}

export async function selectArtboard(artboardId: string) {
  if (artboardId === state.selectedArtboardId) {
    return;
  }
  const artboard = state.artboards.find((candidate) => candidate.id === artboardId);
  if (!artboard) {
    throw new Error("artboard not found");
  }
  setState({
    isLoading: true,
    loadingMediaSrc: null,
  });
  try {
    const info = await loadArtboardSource(artboard.source);
    clearPreviewTiles();
    setState(
      "artboards",
      (candidate) => candidate.id === artboardId,
      {
        ...artboard,
        width: info.canvas_width,
        height: info.canvas_height,
        sourceBitDepth: info.source_bit_depth,
      },
    );
    resetViewportState(info.canvas_width, info.canvas_height);
    setState({
      selectedArtboardId: artboardId,
      activeMediaLibraryId: artboard.activeMediaLibraryId,
      activeMediaItemId: artboard.activeMediaItemId,
      sourceBitDepth: info.source_bit_depth,
      currentView: "editor",
    });
    await refreshLayerStack();
    await refreshPreview();
  } finally {
    setState({
      isLoading: false,
      loadingMediaSrc: null,
    });
  }
}

export async function exportImage(path: string) {
  await bridge.exportImage(path);
}

export async function pickExportTarget() {
  return bridge.pickExportTarget();
}
