import {
  addLayer,
  applyEdit,
  applyGradientMask,
  createBrushMask,
  deleteLayer,
  moveLayer,
  openImage,
  refreshPreview,
  removeMask,
  renameLayer,
  selectLayer,
  setLayerOpacity,
  setLayerVisible,
  showEditorView,
  showMediaView,
  stampBrushMask,
  state,
  setViewportState,
  getViewportDisplaySize,
  getViewportFitRef,
  getViewportZoomPercent,
  offsetViewportCenter,
  panViewport,
} from "./editor";
import { fullCanvasCrop, getSelectedArtboard, type ArtboardSource } from "./editor-store";
import { getMediaBrowserController } from "./media-browser-control";
import { listMediaLibraries } from "../bridge/index";
import {
  loadLibraryData,
  mediaItemKey,
  openMediaItem,
  type MediaItem,
} from "../components/media-view/media-utils";

type JsonObject = Record<string, unknown>;

type RemoteControlToolCall = {
  name: string;
  arguments: unknown;
};

type LayerEditOp =
  | "tone"
  | "color"
  | "curves"
  | "ls_curve"
  | "vignette"
  | "sharpen"
  | "grain"
  | "glow"
  | "hsl"
  | "denoise"
  | "crop";

type CurvePoint = {
  x: number;
  y: number;
};

function assertObject(value: unknown, label: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as JsonObject;
}

function readString(args: JsonObject, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${key} must be a non-empty string`);
  }
  return value;
}

function readOptionalString(args: JsonObject, key: string): string | null {
  const value = args[key];
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${key} must be a non-empty string when provided`);
  }
  return value;
}

function readInteger(args: JsonObject, key: string): number {
  const value = args[key];
  if (!Number.isInteger(value)) {
    throw new Error(`${key} must be an integer`);
  }
  return value as number;
}

function readFiniteNumber(args: JsonObject, key: string): number {
  const value = args[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${key} must be a finite number`);
  }
  return value;
}

function readOptionalFiniteNumber(args: JsonObject, key: string): number | null {
  const value = args[key];
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${key} must be a finite number when provided`);
  }
  return value;
}

function readBoolean(args: JsonObject, key: string): boolean {
  const value = args[key];
  if (typeof value !== "boolean") {
    throw new Error(`${key} must be a boolean`);
  }
  return value;
}

function readOptionalBoolean(args: JsonObject, key: string): boolean | null {
  const value = args[key];
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== "boolean") {
    throw new Error(`${key} must be a boolean when provided`);
  }
  return value;
}

function readCurvePoints(args: JsonObject, key: string): CurvePoint[] {
  const value = args[key];
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${key} must be a non-empty array`);
  }
  return value.map((entry, index) => {
    const point = assertObject(entry, `${key}[${index}]`);
    return {
      x: readFiniteNumber(point, "x"),
      y: readFiniteNumber(point, "y"),
    };
  });
}

function requireLayerIndex(layerIndex: number) {
  if (layerIndex < 0 || layerIndex >= state.layers.length) {
    throw new Error("layer index is out of bounds");
  }
  return state.layers[layerIndex];
}

function requireAdjustmentLayer(layerIndex: number) {
  const layer = requireLayerIndex(layerIndex);
  if (layer.kind !== "adjustment") {
    throw new Error("target layer must be an adjustment layer");
  }
  return layer;
}

function requireCropLayer(layerIndex: number) {
  const layer = requireLayerIndex(layerIndex);
  if (layer.kind !== "crop") {
    throw new Error("target layer must be a crop layer");
  }
  return layer;
}

function defaultLayerInsertPosition(kind: string) {
  if (kind !== "crop") {
    return state.layers.length;
  }
  const imageLayerIdx = state.layers.findIndex((layer) => layer.kind === "image");
  if (imageLayerIdx < 0) {
    throw new Error("cannot add a crop layer without an image layer");
  }
  return imageLayerIdx + 1;
}

function resolveMediaItem(items: MediaItem[], args: JsonObject) {
  const mediaId = readOptionalString(args, "mediaId");
  const path = readOptionalString(args, "path");
  const name = readOptionalString(args, "name");
  const fileHash = readOptionalString(args, "fileHash");
  const matches = items.filter((item) => {
    if (mediaId && mediaItemKey(item) === mediaId) {
      return true;
    }
    if (item.kind === "local" && path && item.path === path) {
      return true;
    }
    if (name && item.name === name) {
      return true;
    }
    if (fileHash && item.fileHash === fileHash) {
      return true;
    }
    return false;
  });
  if (matches.length === 0) {
    throw new Error("library item not found");
  }
  if (matches.length > 1) {
    throw new Error("library item selector is ambiguous");
  }
  return matches[0];
}

function currentTone(layerIndex: number) {
  return (
    requireAdjustmentLayer(layerIndex).adjustments?.tone ?? {
      exposure: 0,
      contrast: 0,
      blacks: 0,
      whites: 0,
      highlights: 0,
      shadows: 0,
      gamma: 1,
    }
  );
}

function currentColor(layerIndex: number) {
  return (
    requireAdjustmentLayer(layerIndex).adjustments?.color ?? {
      saturation: 1,
      vibrancy: 0,
      temperature: 0,
      tint: 0,
    }
  );
}

function currentHsl(layerIndex: number) {
  return (
    requireAdjustmentLayer(layerIndex).adjustments?.hsl ?? {
      red_hue: 0,
      red_sat: 0,
      red_lum: 0,
      green_hue: 0,
      green_sat: 0,
      green_lum: 0,
      blue_hue: 0,
      blue_sat: 0,
      blue_lum: 0,
    }
  );
}

function currentCrop(layerIndex: number) {
  return requireCropLayer(layerIndex).crop ?? fullCanvasCrop();
}

function resolveCropLayerIndex(args: JsonObject) {
  const explicit = args.layerIndex;
  if (explicit !== undefined) {
    return readInteger(args, "layerIndex");
  }
  if (
    state.selectedLayerIdx >= 0 &&
    state.layers[state.selectedLayerIdx]?.kind === "crop"
  ) {
    return state.selectedLayerIdx;
  }
  throw new Error("layerIndex is required when no crop layer is selected");
}

function currentDenoise(layerIndex: number) {
  return (
    requireAdjustmentLayer(layerIndex).adjustments?.denoise ?? {
      luma_strength: 0,
      chroma_strength: 0,
      mode: 0,
    }
  );
}

function currentGrain(layerIndex: number) {
  return (
    requireAdjustmentLayer(layerIndex).adjustments?.grain ?? {
      amount: 0,
      size: 1,
    }
  );
}

function serializeArtboardSource(source: ArtboardSource) {
  switch (source.kind) {
    case "path":
      return source;
    case "file":
      return {
        kind: "file",
        name: source.file.name,
        size: source.file.size,
        type: source.file.type,
        lastModified: source.file.lastModified,
      };
    case "peer":
      return {
        kind: "peer",
        peerEndpointId: source.peerEndpointId,
        picture: source.picture,
      };
    default:
      throw new Error("unsupported artboard source");
  }
}

function serializeArtboard(artboard: NonNullable<ReturnType<typeof getSelectedArtboard>>) {
  return {
    id: artboard.id,
    title: artboard.title,
    worldX: artboard.worldX,
    worldY: artboard.worldY,
    width: artboard.width,
    height: artboard.height,
    sourceBitDepth: artboard.sourceBitDepth,
    source: serializeArtboardSource(artboard.source),
    activeMediaLibraryId: artboard.activeMediaLibraryId,
    activeMediaItemId: artboard.activeMediaItemId,
    activeFileHash: artboard.activeFileHash,
    activeMediaRating: artboard.activeMediaRating,
    activeMediaBaseRating: artboard.activeMediaBaseRating,
  };
}

async function handleShowView(args: unknown) {
  const parsed = assertObject(args, "show_view arguments");
  const view = readString(parsed, "view");
  if (view === "media") {
    showMediaView();
    return { currentView: state.currentView };
  }
  if (view === "editor") {
    showEditorView();
    return { currentView: state.currentView };
  }
  throw new Error(`unsupported view: ${view}`);
}

async function handleSelectMediaLibrary(args: unknown) {
  const parsed = assertObject(args, "select_media_library arguments");
  const libraryId = readString(parsed, "libraryId");
  getMediaBrowserController().selectLibrary(libraryId);
  showMediaView();
  return {
    currentView: state.currentView,
    selectedLibraryId: getMediaBrowserController().getSelectedLibraryId(),
  };
}

async function handleListLibraryImages(args: unknown) {
  const parsed = assertObject(args, "list_library_images arguments");
  const libraryId = readString(parsed, "libraryId");
  const libraryData = await loadLibraryData(libraryId);
  return {
    libraryId,
    isComplete: libraryData.isComplete,
    items: libraryData.items.map((item) => ({
      id: mediaItemKey(item),
      kind: item.kind,
      name: item.name,
      path: item.kind === "local" ? item.path : null,
      peerId: item.kind === "peer" ? item.peerId : null,
      fileHash: item.fileHash,
      modifiedAt: item.modifiedAt,
      metadata: item.metadata,
    })),
  };
}

async function handleOpenLibraryImage(args: unknown) {
  const parsed = assertObject(args, "open_library_image arguments");
  const libraryId = readString(parsed, "libraryId");
  const mode = readOptionalString(parsed, "mode") ?? "replace";
  if (mode !== "replace" && mode !== "append") {
    throw new Error("mode must be replace or append");
  }
  const libraryData = await loadLibraryData(libraryId);
  const item = resolveMediaItem(libraryData.items, parsed);
  getMediaBrowserController().selectLibrary(libraryId);
  await openMediaItem(item, libraryId, null, mode);
  return {
    opened: mediaItemKey(item),
    view: state.currentView,
    selectedArtboardId: state.selectedArtboardId,
  };
}

async function handleOpenImagePath(args: unknown) {
  const parsed = assertObject(args, "open_image_path arguments");
  const path = readString(parsed, "path");
  const mode = readOptionalString(parsed, "mode") ?? "replace";
  if (mode !== "replace" && mode !== "append") {
    throw new Error("mode must be replace or append");
  }
  await openImage(path, null, null, mode);
  return {
    path,
    view: state.currentView,
    selectedArtboardId: state.selectedArtboardId,
  };
}

async function handleAddLayer(args: unknown) {
  const parsed = assertObject(args, "add_layer arguments");
  const kind = readString(parsed, "kind");
  const position =
    parsed.position === undefined
      ? defaultLayerInsertPosition(kind)
      : readInteger(parsed, "position");
  const layerIndex = await addLayer(kind, position);
  return {
    layerIndex,
    layer: state.layers[layerIndex],
  };
}

async function handleDeleteLayer(args: unknown) {
  const parsed = assertObject(args, "delete_layer arguments");
  const layerIndex = readInteger(parsed, "layerIndex");
  const layer = requireLayerIndex(layerIndex);
  if (layer.kind === "image") {
    throw new Error("cannot delete the image layer");
  }
  await deleteLayer(layerIndex);
  return {
    layerCount: state.layers.length,
  };
}

async function handleMoveLayer(args: unknown) {
  const parsed = assertObject(args, "move_layer arguments");
  const fromIndex = readInteger(parsed, "fromIndex");
  const toIndex = readInteger(parsed, "toIndex");
  await moveLayer(fromIndex, toIndex);
  return {
    layers: state.layers,
  };
}

async function handleApplyLayerEdit(args: unknown) {
  const parsed = assertObject(args, "apply_layer_edit arguments");
  const layerIndex = readInteger(parsed, "layerIndex");
  const op = readString(parsed, "op") as LayerEditOp;
  const values = assertObject(parsed["values"], "values");
  switch (op) {
    case "tone": {
      const current = currentTone(layerIndex);
      await applyEdit({
        layer_idx: layerIndex,
        op,
        exposure: readOptionalFiniteNumber(values, "exposure") ?? current.exposure,
        contrast: readOptionalFiniteNumber(values, "contrast") ?? current.contrast,
        blacks: readOptionalFiniteNumber(values, "blacks") ?? current.blacks,
        whites: readOptionalFiniteNumber(values, "whites") ?? current.whites,
        highlights:
          readOptionalFiniteNumber(values, "highlights") ?? current.highlights,
        shadows: readOptionalFiniteNumber(values, "shadows") ?? current.shadows,
        gamma: readOptionalFiniteNumber(values, "gamma") ?? current.gamma,
      });
      break;
    }
    case "color": {
      const current = currentColor(layerIndex);
      await applyEdit({
        layer_idx: layerIndex,
        op,
        saturation:
          readOptionalFiniteNumber(values, "saturation") ?? current.saturation,
        vibrancy: readOptionalFiniteNumber(values, "vibrancy") ?? current.vibrancy,
        temperature:
          readOptionalFiniteNumber(values, "temperature") ?? current.temperature,
        tint: readOptionalFiniteNumber(values, "tint") ?? current.tint,
      });
      break;
    }
    case "curves":
    case "ls_curve":
      await applyEdit({
        layer_idx: layerIndex,
        op,
        curve_points: readCurvePoints(values, "controlPoints"),
      });
      break;
    case "vignette":
      requireAdjustmentLayer(layerIndex);
      await applyEdit({
        layer_idx: layerIndex,
        op,
        vignette_amount: readFiniteNumber(values, "amount"),
      });
      break;
    case "sharpen":
      requireAdjustmentLayer(layerIndex);
      await applyEdit({
        layer_idx: layerIndex,
        op,
        sharpen_amount: readFiniteNumber(values, "amount"),
      });
      break;
    case "grain": {
      const current = currentGrain(layerIndex);
      await applyEdit({
        layer_idx: layerIndex,
        op,
        grain_amount: readOptionalFiniteNumber(values, "amount") ?? current.amount,
        grain_size: readOptionalFiniteNumber(values, "size") ?? current.size,
      });
      break;
    }
    case "glow":
      requireAdjustmentLayer(layerIndex);
      await applyEdit({
        layer_idx: layerIndex,
        op,
        glow_amount: readFiniteNumber(values, "amount"),
      });
      break;
    case "hsl": {
      const current = currentHsl(layerIndex);
      await applyEdit({
        layer_idx: layerIndex,
        op,
        red_hue: readOptionalFiniteNumber(values, "red_hue") ?? current.red_hue,
        red_sat: readOptionalFiniteNumber(values, "red_sat") ?? current.red_sat,
        red_lum: readOptionalFiniteNumber(values, "red_lum") ?? current.red_lum,
        green_hue:
          readOptionalFiniteNumber(values, "green_hue") ?? current.green_hue,
        green_sat:
          readOptionalFiniteNumber(values, "green_sat") ?? current.green_sat,
        green_lum:
          readOptionalFiniteNumber(values, "green_lum") ?? current.green_lum,
        blue_hue: readOptionalFiniteNumber(values, "blue_hue") ?? current.blue_hue,
        blue_sat: readOptionalFiniteNumber(values, "blue_sat") ?? current.blue_sat,
        blue_lum: readOptionalFiniteNumber(values, "blue_lum") ?? current.blue_lum,
      });
      break;
    }
    case "denoise": {
      const current = currentDenoise(layerIndex);
      const mode = values.mode;
      if (
        mode !== undefined &&
        (typeof mode !== "number" || !Number.isInteger(mode) || mode < 0)
      ) {
        throw new Error("mode must be a non-negative integer when provided");
      }
      await applyEdit({
        layer_idx: layerIndex,
        op,
        denoise_luma_strength:
          readOptionalFiniteNumber(values, "luma_strength") ??
          current.luma_strength,
        denoise_chroma_strength:
          readOptionalFiniteNumber(values, "chroma_strength") ??
          current.chroma_strength,
        denoise_mode: (mode as number | undefined) ?? current.mode,
      });
      break;
    }
    case "crop": {
      const current = currentCrop(layerIndex);
      await applyEdit({
        layer_idx: layerIndex,
        op,
        crop_x: readOptionalFiniteNumber(values, "x") ?? current.x,
        crop_y: readOptionalFiniteNumber(values, "y") ?? current.y,
        crop_width: readOptionalFiniteNumber(values, "width") ?? current.width,
        crop_height: readOptionalFiniteNumber(values, "height") ?? current.height,
        crop_rotation:
          readOptionalFiniteNumber(values, "rotation") ?? current.rotation,
      });
      break;
    }
    default:
      throw new Error(`unsupported layer edit op: ${op}`);
  }
  return {
    layerIndex,
    layer: state.layers[layerIndex],
  };
}

async function handleSetLayerMask(args: unknown) {
  const parsed = assertObject(args, "set_layer_mask arguments");
  const layerIndex = readInteger(parsed, "layerIndex");
  requireAdjustmentLayer(layerIndex);
  const kind = readString(parsed, "kind");
  if (kind === "remove") {
    await removeMask(layerIndex);
    return { layerIndex, mask: null };
  }
  if (kind === "brush") {
    await createBrushMask(layerIndex);
    return {
      layerIndex,
      mask: state.layers[layerIndex]?.mask_params ?? null,
    };
  }
  if (kind === "linear") {
    await applyGradientMask({
      layer_idx: layerIndex,
      kind,
      x1: readFiniteNumber(parsed, "x1"),
      y1: readFiniteNumber(parsed, "y1"),
      x2: readFiniteNumber(parsed, "x2"),
      y2: readFiniteNumber(parsed, "y2"),
    });
    return {
      layerIndex,
      mask: state.layers[layerIndex]?.mask_params ?? null,
    };
  }
  if (kind === "radial") {
    await applyGradientMask({
      layer_idx: layerIndex,
      kind,
      cx: readFiniteNumber(parsed, "cx"),
      cy: readFiniteNumber(parsed, "cy"),
      radius: readFiniteNumber(parsed, "radius"),
    });
    return {
      layerIndex,
      mask: state.layers[layerIndex]?.mask_params ?? null,
    };
  }
  throw new Error(`unsupported mask kind: ${kind}`);
}

async function handlePaintBrushMask(args: unknown) {
  const parsed = assertObject(args, "paint_brush_mask arguments");
  const layerIndex = readInteger(parsed, "layerIndex");
  const layer = requireAdjustmentLayer(layerIndex);
  if (layer.mask_params?.kind !== "brush") {
    throw new Error("target layer does not have a brush mask");
  }
  await stampBrushMask(
    layerIndex,
    readFiniteNumber(parsed, "cx"),
    readFiniteNumber(parsed, "cy"),
    readFiniteNumber(parsed, "radius"),
    readFiniteNumber(parsed, "softness"),
    readOptionalBoolean(parsed, "erase") ?? false,
  );
  await refreshPreview();
  return {
    layerIndex,
    mask: state.layers[layerIndex]?.mask_params ?? null,
  };
}

function appStateSnapshot() {
  const selectedArtboard = getSelectedArtboard();
  const viewportDisplay = getViewportDisplaySize();
  const fitRef = getViewportFitRef();
  return {
    currentView: state.currentView,
    selectedLibraryId: getMediaBrowserController().getSelectedLibraryId(),
    activeMediaLibraryId: state.activeMediaLibraryId,
    activeMediaItemId: state.activeMediaItemId,
    selectedArtboardId: state.selectedArtboardId,
    artboards: state.artboards.map((artboard) => serializeArtboard(artboard)),
    selectedArtboard: selectedArtboard ? serializeArtboard(selectedArtboard) : null,
    selectedLayerIdx: state.selectedLayerIdx,
    layers: state.layers,
    canvasWidth: state.canvasWidth,
    canvasHeight: state.canvasHeight,
    viewport: {
      zoom: state.viewportZoom,
      centerX: state.viewportCenterX,
      centerY: state.viewportCenterY,
      screenWidth: state.viewportScreenWidth,
      screenHeight: state.viewportScreenHeight,
      displayWidth: viewportDisplay.width,
      displayHeight: viewportDisplay.height,
      zoomPercent: getViewportZoomPercent(),
      fitX: fitRef.x,
      fitY: fitRef.y,
      fitWidth: fitRef.width,
      fitHeight: fitRef.height,
    },
    sourceBitDepth: state.sourceBitDepth,
    isLoading: state.isLoading,
    isDownloading: state.isDownloading,
    loadError: state.loadError,
  };
}

export async function executeRemoteControlTool(
  call: RemoteControlToolCall,
): Promise<unknown> {
  switch (call.name) {
    case "get_app_state":
      return appStateSnapshot();
    case "show_view":
      return handleShowView(call.arguments);
    case "list_media_libraries":
      return listMediaLibraries();
    case "select_media_library":
      return handleSelectMediaLibrary(call.arguments);
    case "list_library_images":
      return handleListLibraryImages(call.arguments);
    case "open_library_image":
      return handleOpenLibraryImage(call.arguments);
    case "open_image_path":
      return handleOpenImagePath(call.arguments);
    case "select_layer": {
      const args = assertObject(call.arguments, "select_layer arguments");
      const layerIndex = readInteger(args, "layerIndex");
      requireLayerIndex(layerIndex);
      selectLayer(layerIndex);
      return {
        selectedLayerIdx: state.selectedLayerIdx,
      };
    }
    case "add_layer":
      return handleAddLayer(call.arguments);
    case "delete_layer":
      return handleDeleteLayer(call.arguments);
    case "move_layer":
      return handleMoveLayer(call.arguments);
    case "set_layer_visible": {
      const args = assertObject(call.arguments, "set_layer_visible arguments");
      const layerIndex = readInteger(args, "layerIndex");
      requireLayerIndex(layerIndex);
      await setLayerVisible(layerIndex, readBoolean(args, "visible"));
      return { layerIndex, layer: state.layers[layerIndex] };
    }
    case "set_layer_opacity": {
      const args = assertObject(call.arguments, "set_layer_opacity arguments");
      const layerIndex = readInteger(args, "layerIndex");
      requireLayerIndex(layerIndex);
      await setLayerOpacity(layerIndex, readFiniteNumber(args, "opacity"));
      return { layerIndex, layer: state.layers[layerIndex] };
    }
    case "rename_layer": {
      const args = assertObject(call.arguments, "rename_layer arguments");
      const layerIndex = readInteger(args, "layerIndex");
      requireLayerIndex(layerIndex);
      await renameLayer(layerIndex, readOptionalString(args, "name"));
      return { layerIndex, layer: state.layers[layerIndex] };
    }
    case "apply_layer_edit":
      return handleApplyLayerEdit(call.arguments);
    case "set_crop_rect": {
      const args = assertObject(call.arguments, "set_crop_rect arguments");
      const layerIndex = resolveCropLayerIndex(args);
      const current = currentCrop(layerIndex);
      await applyEdit({
        layer_idx: layerIndex,
        op: "crop",
        crop_x: readOptionalFiniteNumber(args, "x") ?? current.x,
        crop_y: readOptionalFiniteNumber(args, "y") ?? current.y,
        crop_width: readOptionalFiniteNumber(args, "width") ?? current.width,
        crop_height: readOptionalFiniteNumber(args, "height") ?? current.height,
        crop_rotation: readOptionalFiniteNumber(args, "rotation") ?? current.rotation,
      });
      return {
        layerIndex,
        layer: state.layers[layerIndex],
      };
    }
    case "set_layer_mask":
      return handleSetLayerMask(call.arguments);
    case "paint_brush_mask":
      return handlePaintBrushMask(call.arguments);
    case "set_viewport": {
      const args = assertObject(call.arguments, "set_viewport arguments");
      setViewportState({
        centerX: readOptionalFiniteNumber(args, "centerX") ?? undefined,
        centerY: readOptionalFiniteNumber(args, "centerY") ?? undefined,
        zoom: readOptionalFiniteNumber(args, "zoom") ?? undefined,
      });
      return appStateSnapshot();
    }
    case "pan_viewport": {
      const args = assertObject(call.arguments, "pan_viewport arguments");
      const unit = readOptionalString(args, "unit") ?? "image";
      const deltaX = readFiniteNumber(args, "deltaX");
      const deltaY = readFiniteNumber(args, "deltaY");
      if (unit === "image") {
        offsetViewportCenter(deltaX, deltaY);
        return appStateSnapshot();
      }
      if (unit === "screen") {
        panViewport(deltaX, deltaY, true);
        return appStateSnapshot();
      }
      throw new Error("unit must be image or screen");
    }
    default:
      throw new Error(`unknown remote control tool: ${call.name}`);
  }
}
