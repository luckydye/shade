import * as bridge from "../bridge/index";
import {
  fullCanvasCrop,
  setState,
  state,
  type ArtboardSource,
  type ArtboardState,
} from "./editor-store";
import {
  clearPreviewTiles,
  refreshPreview,
  resetPreviewLatencyEstimate,
  resetViewport,
  resumePreview,
  suspendPreview,
} from "../viewport/preview";
import { refreshLayerStack } from "./editor-layers";

const ARTBOARD_GAP = 96;
const DEFAULT_PENDING_ARTBOARD_WIDTH = 1600;
const DEFAULT_PENDING_ARTBOARD_HEIGHT = 1200;
const SUPERSEDED_IMAGE_LOAD_ERROR = "image load superseded by newer request";

let activeLoadToken = 0;

type OpenImageMode = "append" | "replace";

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

function beginLoadToken() {
  activeLoadToken += 1;
  return activeLoadToken;
}

function isActiveLoadToken(token: number) {
  return activeLoadToken === token;
}

function isSupersededImageLoadError(error: unknown) {
  return error instanceof Error && error.message === SUPERSEDED_IMAGE_LOAD_ERROR;
}

function getPendingArtboardSize() {
  const selectedArtboard = state.artboards.find(
    (artboard) => artboard.id === state.selectedArtboardId,
  );
  if (selectedArtboard && selectedArtboard.width > 0 && selectedArtboard.height > 0) {
    return { width: selectedArtboard.width, height: selectedArtboard.height };
  }
  if (state.canvasWidth > 0 && state.canvasHeight > 0) {
    return { width: state.canvasWidth, height: state.canvasHeight };
  }
  return {
    width: DEFAULT_PENDING_ARTBOARD_WIDTH,
    height: DEFAULT_PENDING_ARTBOARD_HEIGHT,
  };
}

function artboardSourceMatches(a: ArtboardSource, b: ArtboardSource) {
  if (a.kind !== b.kind) {
    return false;
  }
  switch (a.kind) {
    case "path":
      return a.path === (b as ArtboardSource & { kind: "path" }).path;
    case "file": {
      const other = b as ArtboardSource & { kind: "file" };
      return (
        a.file.name === other.file.name &&
        a.file.size === other.file.size &&
        a.file.lastModified === other.file.lastModified
      );
    }
    case "peer": {
      const other = b as ArtboardSource & { kind: "peer" };
      return (
        a.peerEndpointId === other.peerEndpointId &&
        a.picture.id === other.picture.id
      );
    }
    default:
      throw new Error("unknown artboard source");
  }
}

async function focusExistingArtboard(artboardId: string) {
  if (artboardId !== state.selectedArtboardId) {
    await selectArtboard(artboardId);
    return;
  }
  setState("currentView", "editor");
  resetViewport();
}

async function loadArtboardIntoEditor(artboard: ArtboardState) {
  const loadToken = beginLoadToken();
  setPendingEditorState(
    artboard.id,
    artboard.width,
    artboard.height,
    artboard.sourceBitDepth,
    artboard.activeMediaLibraryId && artboard.activeMediaItemId
      ? {
          libraryId: artboard.activeMediaLibraryId,
          itemId: artboard.activeMediaItemId,
        }
      : null,
    null,
  );
  try {
    const info = await loadArtboardSource(artboard.source);
    if (!isActiveLoadToken(loadToken)) {
      return;
    }
    resetPreviewLatencyEstimate();
    clearPreviewTiles();
    setState(
      "artboards",
      (candidate) => candidate.id === artboard.id,
      {
        ...artboard,
        width: info.canvas_width,
        height: info.canvas_height,
        sourceBitDepth: info.source_bit_depth,
      },
    );
    resetViewportState(info.canvas_width, info.canvas_height);
    setState({
      sourceBitDepth: info.source_bit_depth,
    });
    await refreshLayerStack();
    resumePreview();
    await refreshPreview();
  } catch (error) {
    if (!isActiveLoadToken(loadToken) || isSupersededImageLoadError(error)) {
      return;
    }
    throw error;
  } finally {
    if (isActiveLoadToken(loadToken)) {
      setState({
        isLoading: false,
        loadingMediaSrc: null,
      });
    }
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
  resumePreview();
  resetPreviewLatencyEstimate();
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

function setPendingEditorState(
  artboardId: string,
  canvasWidth: number,
  canvasHeight: number,
  sourceBitDepth: string,
  activeMediaSelection: {
    libraryId: string;
    itemId: string;
  } | null,
  loadingMediaSrc: string | null,
) {
  suspendPreview();
  resetViewportState(canvasWidth, canvasHeight);
  setState({
    currentView: "editor",
    selectedArtboardId: artboardId,
    activeMediaLibraryId: activeMediaSelection?.libraryId ?? null,
    activeMediaItemId: activeMediaSelection?.itemId ?? null,
    layers: [],
    selectedLayerIdx: -1,
    sourceBitDepth,
    previewDisplayColorSpace: "Unknown",
    isLoading: true,
    loadingMediaSrc,
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
  mode: OpenImageMode,
) {
  const existingArtboard = state.artboards.find((artboard) =>
    artboardSourceMatches(artboard.source, source),
  );
  if (existingArtboard) {
    if (loadingMediaSrc?.startsWith("blob:")) {
      URL.revokeObjectURL(loadingMediaSrc);
    }
    await focusExistingArtboard(existingArtboard.id);
    return;
  }
  const replacementArtboard =
    mode === "replace"
      ? state.artboards.find((artboard) => artboard.id === state.selectedArtboardId) ?? null
      : null;
  const previousSelectedArtboardId = state.selectedArtboardId;
  const pendingSize = replacementArtboard ?? getPendingArtboardSize();
  const artboard = replacementArtboard ?? {
    id: createArtboardId(),
    title: getArtboardTitle(source),
    worldX: getNextArtboardWorldX(),
    worldY: 0,
    width: pendingSize.width,
    height: pendingSize.height,
    sourceBitDepth: "Loading",
    source,
    activeMediaLibraryId: activeMediaSelection?.libraryId ?? null,
    activeMediaItemId: activeMediaSelection?.itemId ?? null,
    previewTile: null,
    backdropTile: null,
  };
  const loadToken = beginLoadToken();
  if (!replacementArtboard) {
    setState("artboards", (artboards) => [...artboards, artboard]);
  }
  setPendingEditorState(
    artboard.id,
    pendingSize.width,
    pendingSize.height,
    "Loading",
    activeMediaSelection,
    loadingMediaSrc,
  );
  try {
    const info = await load();
    if (!isActiveLoadToken(loadToken)) {
      return;
    }
    resetPreviewLatencyEstimate();
    clearPreviewTiles();
    setState(
      "artboards",
      (candidate) => candidate.id === artboard.id,
      {
        ...artboard,
        title: getArtboardTitle(source),
        width: info.canvas_width,
        height: info.canvas_height,
        sourceBitDepth: info.source_bit_depth,
        source,
        activeMediaLibraryId: activeMediaSelection?.libraryId ?? null,
        activeMediaItemId: activeMediaSelection?.itemId ?? null,
        previewTile: null,
        backdropTile: null,
      },
    );
    resetViewportState(info.canvas_width, info.canvas_height);
    setState({
      sourceBitDepth: info.source_bit_depth,
    });
    await refreshLayerStack();
    resumePreview();
    await refreshPreview();
  } catch (error) {
    if (!isActiveLoadToken(loadToken) || isSupersededImageLoadError(error)) {
      return;
    }
    if (replacementArtboard) {
      await loadArtboardIntoEditor(replacementArtboard);
      throw error;
    }
    setState("artboards", (artboards) =>
      artboards.filter((candidate) => candidate.id !== artboard.id),
    );
    if (
      previousSelectedArtboardId &&
      state.artboards.some((candidate) => candidate.id === previousSelectedArtboardId)
    ) {
      await selectArtboard(previousSelectedArtboardId);
    } else {
      closeImage();
    }
    throw error;
  } finally {
    if (loadingMediaSrc?.startsWith("blob:")) {
      URL.revokeObjectURL(loadingMediaSrc);
    }
    if (isActiveLoadToken(loadToken)) {
      setState({
        isLoading: false,
        loadingMediaSrc: null,
      });
    }
  }
}

export function closeImage() {
  beginLoadToken();
  clearLoadedImageState();
  setState({
    currentView: "media",
    activeMediaLibraryId: null,
    activeMediaItemId: null,
    isLoading: false,
    loadingMediaSrc: null,
  });
}

export async function closeArtboard(artboardId: string) {
  const artboardIndex = state.artboards.findIndex((candidate) => candidate.id === artboardId);
  if (artboardIndex < 0) {
    throw new Error("artboard not found");
  }
  const remainingArtboards = state.artboards.filter((candidate) => candidate.id !== artboardId);
  if (remainingArtboards.length === 0) {
    closeImage();
    return;
  }
  if (state.selectedArtboardId !== artboardId) {
    setState("artboards", remainingArtboards);
    return;
  }
  beginLoadToken();
  const nextArtboard =
    remainingArtboards[Math.min(artboardIndex, remainingArtboards.length - 1)];
  clearPreviewTiles();
  setState({
    artboards: remainingArtboards,
    selectedArtboardId: null,
    isLoading: false,
    loadingMediaSrc: null,
  });
  await selectArtboard(nextArtboard.id);
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
  mode: OpenImageMode = "replace",
) {
  await openImageFrom(
    () => bridge.openImage(path),
    { kind: "path", path },
    loadingMediaSrc,
    activeMediaSelection,
    mode,
  );
}

export async function openImageFile(file: File, mode: OpenImageMode = "replace") {
  await openImageFrom(() => bridge.openImageFile(file), { kind: "file", file }, null, null, mode);
}

export async function openPeerImage(
  peerEndpointId: string,
  picture: bridge.SharedPicture,
  loadingMediaSrc: string | null = null,
  activeMediaSelection: {
    libraryId: string;
    itemId: string;
  } | null = null,
  mode: OpenImageMode = "replace",
) {
  await openImageFrom(
    () => bridge.openPeerImage(peerEndpointId, picture),
    { kind: "peer", peerEndpointId, picture },
    loadingMediaSrc,
    activeMediaSelection,
    mode,
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
  await loadArtboardIntoEditor(artboard);
}

export async function exportImage(path: string) {
  await bridge.exportImage(path);
}

export async function pickExportTarget() {
  return bridge.pickExportTarget();
}
