import { createSignal } from "solid-js";
import { createStore } from "solid-js/store";
import * as bridge from "../bridge/index";

export interface PreviewImage {
	image: ImageData;
	crop: bridge.PreviewCrop;
	viewportX: number;
	viewportY: number;
	viewportWidth: number;
	viewportHeight: number;
}

const [previewFrame, setPreviewFrame] = createSignal<PreviewImage | null>(null);
export { previewFrame };
const [previewContextFrame, setPreviewContextFrame] =
	createSignal<ImageData | null>(null);
export { previewContextFrame };
type PreviewQuality = "interactive" | "final";
const INTERACTIVE_PREVIEW_SCALE = 0.33;
let previewRefreshVersion = 0;
let previewRefreshQueued: { version: number; quality: PreviewQuality } | null =
	null;
let previewRefreshPromise: Promise<void> | null = null;

export interface LayerInfo {
	kind: "image" | "adjustment" | "crop";
	visible: boolean;
	opacity: number;
	blend_mode?: string;
	adjustments?: bridge.AdjustmentValues | null;
	crop?: bridge.CropValues | null;
}

export interface CropRect {
	x: number;
	y: number;
	width: number;
	height: number;
}

export interface EditorState {
	currentView: "media" | "editor";
	layers: LayerInfo[];
	canvasWidth: number;
	canvasHeight: number;
	sourceBitDepth: string;
	previewDisplayColorSpace: string;
	previewRenderWidth: number;
	previewRenderHeight: number;
	selectedLayerIdx: number;
	isLoading: boolean;
	webgpuAvailable: boolean;
	previewZoom: number;
	previewCenterX: number;
	previewCenterY: number;
	previewViewportWidth: number;
	previewViewportHeight: number;
	crop: CropRect;
	cropDraft: CropRect | null;
	isCropMode: boolean;
	loadingMediaSrc: string | null;
}

const [state, setState] = createStore<EditorState>({
	currentView: "media",
	layers: [],
	canvasWidth: 0,
	canvasHeight: 0,
	sourceBitDepth: "Unknown",
	previewDisplayColorSpace: "Unknown",
	previewRenderWidth: 0,
	previewRenderHeight: 0,
	selectedLayerIdx: -1,
	isLoading: false,
	webgpuAvailable: true,
	previewZoom: 1,
	previewCenterX: 0,
	previewCenterY: 0,
	previewViewportWidth: 0,
	previewViewportHeight: 0,
	crop: { x: 0, y: 0, width: 0, height: 0 },
	cropDraft: null,
	isCropMode: false,
	loadingMediaSrc: null,
});

export { state };

export const [isDrawerOpen, setIsDrawerOpen] = createSignal(false);

function resolveSelectedLayerIdx(layers: LayerInfo[], currentIdx: number) {
	if (currentIdx >= 0 && currentIdx < layers.length) {
		return currentIdx;
	}
	for (let idx = layers.length - 1; idx >= 0; idx -= 1) {
		if (layers[idx].kind === "adjustment") {
			return idx;
		}
	}
	return layers.length - 1;
}

function clamp(value: number, min: number, max: number) {
	return Math.min(Math.max(value, min), max);
}

function fullCanvasCrop(
	width = state.canvasWidth,
	height = state.canvasHeight,
): CropRect {
	return { x: 0, y: 0, width, height };
}

function normalizeCropRect(
	rect: CropRect,
	canvasWidth = state.canvasWidth,
	canvasHeight = state.canvasHeight,
): CropRect {
	if (canvasWidth <= 0 || canvasHeight <= 0) {
		throw new Error("cannot normalize crop without a loaded image");
	}
	const x = clamp(Math.round(rect.x), 0, canvasWidth - 1);
	const y = clamp(Math.round(rect.y), 0, canvasHeight - 1);
	const maxWidth = canvasWidth - x;
	const maxHeight = canvasHeight - y;
	const width = clamp(Math.round(rect.width), 1, maxWidth);
	const height = clamp(Math.round(rect.height), 1, maxHeight);
	return { x, y, width, height };
}

function cropRectsMatch(a: CropRect, b: CropRect) {
	return (
		a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height
	);
}

export function getCommittedCropRect() {
	const cropLayer = state.layers.find(
		(layer) => layer.kind === "crop" && layer.visible && layer.crop,
	);
	if (cropLayer?.crop) {
		return cropLayer.crop;
	}
	return fullCanvasCrop();
}

export function getDraftCropRect() {
	return state.cropDraft ?? getCommittedCropRect();
}

export function hasActiveCrop() {
	return !cropRectsMatch(getCommittedCropRect(), fullCanvasCrop());
}

function selectedLayerIsCrop() {
	return (
		state.selectedLayerIdx >= 0 &&
		state.layers[state.selectedLayerIdx]?.kind === "crop"
	);
}

function getPreviewBounds() {
	if (selectedLayerIsCrop()) {
		return fullCanvasCrop();
	}
	return getCommittedCropRect();
}

function fitPreviewSize(
	containerWidth: number,
	containerHeight: number,
	imageWidth: number,
	imageHeight: number,
) {
	if (
		containerWidth <= 0 ||
		containerHeight <= 0 ||
		imageWidth <= 0 ||
		imageHeight <= 0
	) {
		return { width: 0, height: 0 };
	}
	const scale = Math.min(
		containerWidth / imageWidth,
		containerHeight / imageHeight,
	);
	return {
		width: Math.max(1, Math.floor(imageWidth * scale)),
		height: Math.max(1, Math.floor(imageHeight * scale)),
	};
}

function capPreviewRenderSize(
	width: number,
	height: number,
	maxPixelCount: number,
) {
	if (width <= 0 || height <= 0) return { width: 0, height: 0 };
	const pixelCount = width * height;
	if (pixelCount <= maxPixelCount) return { width, height };
	const scale = Math.sqrt(maxPixelCount / pixelCount);
	return {
		width: Math.max(1, Math.floor(width * scale)),
		height: Math.max(1, Math.floor(height * scale)),
	};
}

function clampPreviewCenter(zoom: number, centerX: number, centerY: number) {
	const { width: cropWidth, height: cropHeight } = getPreviewCropSize(zoom);
	const bounds = getPreviewBounds();
	return {
		x: clamp(
			centerX,
			bounds.x + cropWidth * 0.5,
			bounds.x + bounds.width - cropWidth * 0.5,
		),
		y: clamp(
			centerY,
			bounds.y + cropHeight * 0.5,
			bounds.y + bounds.height - cropHeight * 0.5,
		),
	};
}

function getPreviewCropSize(zoom: number) {
	const bounds = getPreviewBounds();
	if (
		bounds.width <= 0 ||
		bounds.height <= 0 ||
		state.previewViewportWidth <= 0 ||
		state.previewViewportHeight <= 0
	) {
		return { width: 0, height: 0 };
	}
	const fitScale = Math.min(
		state.previewViewportWidth / bounds.width,
		state.previewViewportHeight / bounds.height,
	);
	if (fitScale <= 0) {
		throw new Error("preview fit scale must be positive");
	}
	const imageScale = fitScale * zoom;
	return {
		width: Math.min(bounds.width, state.previewViewportWidth / imageScale),
		height: Math.min(bounds.height, state.previewViewportHeight / imageScale),
	};
}

function getVisiblePreview(zoom: number, centerX: number, centerY: number) {
	const bounds = getPreviewBounds();
	if (bounds.width <= 0 || bounds.height <= 0) return null;
	if (state.previewViewportWidth <= 0 || state.previewViewportHeight <= 0)
		return null;
	const fitScale = Math.min(
		state.previewViewportWidth / bounds.width,
		state.previewViewportHeight / bounds.height,
	);
	if (fitScale <= 0) {
		throw new Error("preview fit scale must be positive");
	}
	const center = clampPreviewCenter(zoom, centerX, centerY);
	const imageScale = fitScale * zoom;
	const imageX =
		state.previewViewportWidth * 0.5 - (center.x - bounds.x) * imageScale;
	const imageY =
		state.previewViewportHeight * 0.5 - (center.y - bounds.y) * imageScale;
	const screenLeft = Math.max(0, imageX);
	const screenTop = Math.max(0, imageY);
	const screenRight = Math.min(
		state.previewViewportWidth,
		imageX + bounds.width * imageScale,
	);
	const screenBottom = Math.min(
		state.previewViewportHeight,
		imageY + bounds.height * imageScale,
	);
	if (screenRight <= screenLeft || screenBottom <= screenTop) {
		throw new Error("visible preview must intersect the viewport");
	}
	return {
		viewportX: screenLeft,
		viewportY: screenTop,
		viewportWidth: screenRight - screenLeft,
		viewportHeight: screenBottom - screenTop,
		crop: {
			x: bounds.x + (screenLeft - imageX) / imageScale,
			y: bounds.y + (screenTop - imageY) / imageScale,
			width: (screenRight - screenLeft) / imageScale,
			height: (screenBottom - screenTop) / imageScale,
		},
		screenWidth: screenRight - screenLeft,
		screenHeight: screenBottom - screenTop,
	};
}

function getPreviewRequest(
	quality: PreviewQuality,
): bridge.PreviewRequest | null {
	const visible = getVisiblePreview(
		state.previewZoom,
		state.previewCenterX,
		state.previewCenterY,
	);
	if (!visible) return null;
	const devicePixelRatio =
		(window.devicePixelRatio || 1) *
		(quality === "interactive" ? INTERACTIVE_PREVIEW_SCALE : 1);
	const targetWidth = Math.max(
		1,
		Math.round(visible.screenWidth * devicePixelRatio),
	);
	const targetHeight = Math.max(
		1,
		Math.round(visible.screenHeight * devicePixelRatio),
	);
	return {
		target_width: targetWidth,
		target_height: targetHeight,
		crop: visible.crop,
		ignore_crop_layers: selectedLayerIsCrop(),
	};
}

function previewCropMatches(a: bridge.PreviewCrop, b: bridge.PreviewCrop) {
	const epsilon = 0.01;
	return (
		Math.abs(a.x - b.x) <= epsilon &&
		Math.abs(a.y - b.y) <= epsilon &&
		Math.abs(a.width - b.width) <= epsilon &&
		Math.abs(a.height - b.height) <= epsilon
	);
}

function getContextPreviewRequest(
	quality: PreviewQuality,
): bridge.PreviewRequest | null {
	if (state.canvasWidth <= 0 || state.canvasHeight <= 0) return null;
	const crop = selectedLayerIsCrop() ? undefined : getCommittedCropRect();
	const devicePixelRatio =
		(window.devicePixelRatio || 1) *
		(quality === "interactive" ? INTERACTIVE_PREVIEW_SCALE : 1);
	const fitted = fitPreviewSize(
		state.previewViewportWidth * devicePixelRatio,
		state.previewViewportHeight * devicePixelRatio,
		crop?.width ?? state.canvasWidth,
		crop?.height ?? state.canvasHeight,
	);
	if (fitted.width <= 0 || fitted.height <= 0) return null;
	return {
		target_width: fitted.width,
		target_height: fitted.height,
		crop,
		ignore_crop_layers: true,
	};
}

function toImageData(frame: bridge.PreviewFrame) {
	if (frame.kind === "rgba-float16") {
		return new ImageData(frame.pixels as any, frame.width, frame.height, {
			pixelFormat: "rgba-float16",
			colorSpace: frame.colorSpace,
		} as any);
	}
	const pixels = new Uint8ClampedArray(
		frame.pixels.buffer,
		frame.pixels.byteOffset,
		frame.pixels.byteLength,
	) as any;
	return new ImageData(pixels, frame.width, frame.height);
}

export function getPreviewDisplaySize() {
	const bounds = getPreviewBounds();
	return fitPreviewSize(
		state.previewViewportWidth,
		state.previewViewportHeight,
		bounds.width,
		bounds.height,
	);
}

export function getMaxPreviewZoom() {
	const bounds = getPreviewBounds();
	if (
		bounds.width <= 0 ||
		bounds.height <= 0 ||
		state.previewViewportWidth <= 0 ||
		state.previewViewportHeight <= 0
	) {
		return 1;
	}
	const fitScale = Math.min(
		state.previewViewportWidth / bounds.width,
		state.previewViewportHeight / bounds.height,
	);
	if (fitScale <= 0) {
		throw new Error("preview fit scale must be positive");
	}
	return Math.max(1, 1 / fitScale);
}

export function resetPreviewViewport() {
	const crop = getPreviewBounds();
	setState({
		previewZoom: 1,
		previewCenterX: crop.x + crop.width * 0.5,
		previewCenterY: crop.y + crop.height * 0.5,
	});
	void refreshPreview();
}

export function setPreviewViewportSize(width: number, height: number) {
	const nextWidth = Math.max(0, Math.floor(width));
	const nextHeight = Math.max(0, Math.floor(height));
	if (
		nextWidth === state.previewViewportWidth &&
		nextHeight === state.previewViewportHeight
	)
		return;
	// setPreviewFrame(null);
	// setPreviewContextFrame(null);
	setState({
		previewViewportWidth: nextWidth,
		previewViewportHeight: nextHeight,
	});
	void refreshPreview();
}

export function zoomPreviewDelta(
	delta: number,
	pinch: boolean,
	anchorX: number,
	anchorY: number,
) {
	if (
		state.canvasWidth <= 0 ||
		state.canvasHeight <= 0 ||
		state.previewViewportWidth <= 0 ||
		state.previewViewportHeight <= 0
	) {
		return;
	}
	const sensitivity = pinch ? 0.0005 : 0.001;
	const multiplier = Math.exp(-delta * sensitivity);
	const fitScale = Math.min(
		state.previewViewportWidth / getPreviewBounds().width,
		state.previewViewportHeight / getPreviewBounds().height,
	);
	if (fitScale <= 0) {
		throw new Error("preview fit scale must be positive");
	}
	const oldImageScale = fitScale * state.previewZoom;
	const zoom = clamp(state.previewZoom * multiplier, 1, getMaxPreviewZoom());
	const newImageScale = fitScale * zoom;
	const viewportCenterX = state.previewViewportWidth * 0.5;
	const viewportCenterY = state.previewViewportHeight * 0.5;
	const anchoredImageX =
		state.previewCenterX + (anchorX - viewportCenterX) / oldImageScale;
	const anchoredImageY =
		state.previewCenterY + (anchorY - viewportCenterY) / oldImageScale;
	const center = clampPreviewCenter(
		zoom,
		anchoredImageX - (anchorX - viewportCenterX) / newImageScale,
		anchoredImageY - (anchorY - viewportCenterY) / newImageScale,
	);
	setState({
		previewZoom: zoom,
		previewCenterX: center.x,
		previewCenterY: center.y,
	});
	void refreshPreview();
}

export function panPreview(deltaX: number, deltaY: number) {
	if (
		state.previewZoom <= 1 ||
		state.previewViewportWidth <= 0 ||
		state.previewViewportHeight <= 0
	)
		return;
	const fitScale = Math.min(
		state.previewViewportWidth / getPreviewBounds().width,
		state.previewViewportHeight / getPreviewBounds().height,
	);
	if (fitScale <= 0) {
		throw new Error("preview fit scale must be positive");
	}
	const imageScale = fitScale * state.previewZoom;
	const center = clampPreviewCenter(
		state.previewZoom,
		state.previewCenterX - deltaX / imageScale,
		state.previewCenterY - deltaY / imageScale,
	);
	setState({
		previewCenterX: center.x,
		previewCenterY: center.y,
	});
	void refreshPreview();
}

function resetPreviewState(canvasWidth: number, canvasHeight: number) {
	const crop = fullCanvasCrop(canvasWidth, canvasHeight);
	setState({
		canvasWidth,
		canvasHeight,
		previewZoom: 1,
		previewCenterX: crop.width * 0.5,
		previewCenterY: crop.height * 0.5,
		crop,
		cropDraft: null,
		isCropMode: false,
	});
}

function clearLoadedImageState() {
	setPreviewFrame(null);
	setPreviewContextFrame(null);
	setState({
		layers: [],
		canvasWidth: 0,
		canvasHeight: 0,
		selectedLayerIdx: -1,
		previewZoom: 1,
		previewCenterX: 0,
		previewCenterY: 0,
		previewRenderWidth: 0,
		previewRenderHeight: 0,
		previewDisplayColorSpace: "Unknown",
		sourceBitDepth: "Unknown",
		crop: { x: 0, y: 0, width: 0, height: 0 },
		cropDraft: null,
		isCropMode: false,
	});
}

export function closeImage() {
	clearLoadedImageState();
	setState({
		currentView: "media",
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
) {
	clearLoadedImageState();
	setState({
		currentView: "editor",
		isLoading: true,
		loadingMediaSrc,
	});
	try {
		const info = await bridge.openImage(path);
		resetPreviewState(info.canvas_width, info.canvas_height);
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

export async function openImageFile(file: File) {
	clearLoadedImageState();
	setState({
		currentView: "editor",
		isLoading: true,
	});
	try {
		const info = await bridge.openImageFile(file);
		resetPreviewState(info.canvas_width, info.canvas_height);
		setState("sourceBitDepth", info.source_bit_depth);
		await refreshLayerStack();
		await refreshPreview();
	} finally {
		setState({
			isLoading: false,
			loadingMediaSrc: null,
		});
	}
}

export async function openPeerImage(
	peerEndpointId: string,
	picture: bridge.SharedPicture,
	loadingMediaSrc: string | null = null,
) {
	clearLoadedImageState();
	setState({
		currentView: "editor",
		isLoading: true,
		loadingMediaSrc,
	});
	try {
		const info = await bridge.openPeerImage(peerEndpointId, picture);
		resetPreviewState(info.canvas_width, info.canvas_height);
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

export async function refreshLayerStack() {
	const info = await bridge.getLayerStack();
	const layers = info.layers as LayerInfo[];
	setState({
		layers,
		canvasWidth: info.canvas_width,
		canvasHeight: info.canvas_height,
		selectedLayerIdx:
			layers.length === 0
				? -1
				: resolveSelectedLayerIdx(layers, state.selectedLayerIdx),
	});
}

export async function setLayerVisible(idx: number, visible: boolean) {
	await bridge.setLayerVisible(idx, visible);
	await refreshLayerStack();
	await refreshPreview();
}

export async function setLayerOpacity(idx: number, opacity: number) {
	await bridge.setLayerOpacity(idx, opacity);
	await refreshLayerStack();
	await refreshPreview();
}

export async function deleteLayer(idx: number) {
	await bridge.deleteLayer(idx);
	await refreshLayerStack();
	if (state.layers.length === 0) {
		setPreviewFrame(null);
		setPreviewContextFrame(null);
	}
	await refreshPreview();
}

export async function applyEdit(params: Record<string, unknown>) {
	const layerIdx = params.layer_idx;
	if (typeof layerIdx !== "number") {
		throw new Error("applyEdit requires a numeric layer_idx");
	}
	const layer = state.layers[layerIdx];
	if (!layer) {
		throw new Error("applyEdit target layer is out of bounds");
	}
	if (layer.kind === "crop") {
		if (params.op !== "crop") {
			throw new Error("crop layers only accept the crop op");
		}
		setState("layers", layerIdx, "crop", {
			x: params.crop_x as number,
			y: params.crop_y as number,
			width: params.crop_width as number,
			height: params.crop_height as number,
		});
		await bridge.applyEdit(params);
		await refreshPreview();
		return;
	}
	if (layer.kind !== "adjustment") {
		throw new Error(
			"applyEdit target layer must be an adjustment or crop layer",
		);
	}
	const adjustments = layer.adjustments ?? {
		tone: null,
		curves: null,
		color: null,
		vignette: null,
		sharpen: null,
		grain: null,
		hsl: null,
	};
	switch (params.op) {
		case "tone":
			setState("layers", layerIdx, "adjustments", {
				...adjustments,
				tone: {
					exposure: params.exposure as number,
					contrast: params.contrast as number,
					blacks: params.blacks as number,
					whites: params.whites as number,
					highlights: params.highlights as number,
					shadows: params.shadows as number,
					gamma: params.gamma as number,
				},
			});
			break;
		case "color":
			setState("layers", layerIdx, "adjustments", {
				...adjustments,
				color: {
					saturation: params.saturation as number,
					temperature: params.temperature as number,
					tint: params.tint as number,
				},
			});
			break;
		case "curves":
			setState("layers", layerIdx, "adjustments", {
				...adjustments,
				curves: {
					lut_r: adjustments.curves?.lut_r ?? [],
					lut_g: adjustments.curves?.lut_g ?? [],
					lut_b: adjustments.curves?.lut_b ?? [],
					lut_master: adjustments.curves?.lut_master ?? [],
					per_channel: adjustments.curves?.per_channel ?? false,
					control_points: params.curve_points as
						| bridge.CurveControlPoint[]
						| undefined,
				},
			});
			break;
		case "vignette":
			setState("layers", layerIdx, "adjustments", {
				...adjustments,
				vignette: { amount: params.vignette_amount as number },
			});
			break;
		case "sharpen":
			setState("layers", layerIdx, "adjustments", {
				...adjustments,
				sharpen: { amount: params.sharpen_amount as number },
			});
			break;
		case "grain":
			setState("layers", layerIdx, "adjustments", {
				...adjustments,
				grain: { amount: params.grain_amount as number },
			});
			break;
		case "hsl":
			setState("layers", layerIdx, "adjustments", {
				...adjustments,
				hsl: {
					red_hue: params.red_hue as number,
					red_sat: params.red_sat as number,
					red_lum: params.red_lum as number,
					green_hue: params.green_hue as number,
					green_sat: params.green_sat as number,
					green_lum: params.green_lum as number,
					blue_hue: params.blue_hue as number,
					blue_sat: params.blue_sat as number,
					blue_lum: params.blue_lum as number,
				},
			});
			break;
		default:
			throw new Error(`unknown edit op: ${String(params.op)}`);
	}
	await bridge.applyEdit(params);
	await refreshPreview();
}

export function selectLayer(idx: number) {
	if (idx === state.selectedLayerIdx) return;
	setState("selectedLayerIdx", idx);
}

export function findCropLayerIdx() {
	return state.layers.findIndex((layer) => layer.kind === "crop");
}

export function startCropMode() {
	if (state.canvasWidth <= 0 || state.canvasHeight <= 0) {
		throw new Error("cannot start crop mode without a loaded image");
	}
	setState({
		isCropMode: true,
		cropDraft: state.crop,
	});
	void refreshPreview();
}

export function cancelCropMode() {
	if (!state.isCropMode) return;
	setState({
		isCropMode: false,
		cropDraft: null,
	});
	void refreshPreview();
}

export function updateCropDraft(next: CropRect) {
	if (!state.isCropMode) {
		throw new Error("cannot update crop draft when crop mode is inactive");
	}
	setState("cropDraft", normalizeCropRect(next));
}

export function resetCrop() {
	if (state.canvasWidth <= 0 || state.canvasHeight <= 0) {
		throw new Error("cannot reset crop without a loaded image");
	}
	const crop = fullCanvasCrop();
	setState({
		crop,
		cropDraft: state.isCropMode ? crop : null,
	});
	resetPreviewViewport();
}

export function applyCrop() {
	if (!state.isCropMode || !state.cropDraft) {
		throw new Error("cannot apply crop without an active draft");
	}
	const crop = normalizeCropRect(state.cropDraft);
	setState({
		crop,
		cropDraft: null,
		isCropMode: false,
		previewZoom: 1,
		previewCenterX: crop.x + crop.width * 0.5,
		previewCenterY: crop.y + crop.height * 0.5,
	});
	void refreshPreview();
}

export async function addLayer(kind: string) {
	const idx = await bridge.addLayer(kind);
	await refreshLayerStack();
	setState("selectedLayerIdx", idx);
	await refreshPreview();
}

export async function listPresets() {
	return bridge.listPresets();
}

export async function savePreset(name: string) {
	return bridge.savePreset(name);
}

export async function loadPreset(name: string) {
	await bridge.loadPreset(name);
	await refreshLayerStack();
	await refreshPreview();
}

async function performPreviewRefresh() {
	const queued = previewRefreshQueued;
	if (!queued) return;
	previewRefreshQueued = null;
	const request = getPreviewRequest(queued.quality);
	const contextRequest = getContextPreviewRequest(queued.quality);
	if (!request || !contextRequest) return;
	const frame = await bridge.renderPreview(request);
	if (queued.version !== previewRefreshVersion) return;
	if (frame.width === 0 || frame.height === 0) return;
	const crop = request.crop;
	if (!crop) {
		throw new Error("preview refresh requires a crop");
	}
	const currentVisible = getVisiblePreview(
		state.previewZoom,
		state.previewCenterX,
		state.previewCenterY,
	);
	if (!currentVisible) return;
	const currentCrop = currentVisible.crop;
	if (!previewCropMatches(crop, currentCrop)) {
		void refreshPreview();
		return;
	}
	setState({
		previewDisplayColorSpace:
			frame.kind === "rgba-float16"
				? frame.colorSpace === "display-p3"
					? "Display P3"
					: frame.colorSpace
				: "sRGB",
		previewRenderWidth: frame.width,
		previewRenderHeight: frame.height,
	});
	setPreviewFrame({
		image: toImageData(frame),
		crop,
		viewportX: currentVisible.viewportX,
		viewportY: currentVisible.viewportY,
		viewportWidth: currentVisible.viewportWidth,
		viewportHeight: currentVisible.viewportHeight,
	});
	if (
		request.crop &&
		request.crop.width === state.canvasWidth &&
		request.crop.height === state.canvasHeight
	) {
		setPreviewContextFrame(toImageData(frame));
		return;
	}
	if (queued.quality === "interactive" && previewContextFrame()) {
		return;
	}
	const contextFrame = await bridge.renderPreview(contextRequest);
	if (queued.version !== previewRefreshVersion) return;
	if (contextFrame.width === 0 || contextFrame.height === 0) return;
	setPreviewContextFrame(toImageData(contextFrame));
}

function queuePreviewRefresh(version: number, quality: PreviewQuality) {
	if (
		previewRefreshQueued &&
		previewRefreshQueued.version === version &&
		previewRefreshQueued.quality === "final"
	) {
		return;
	}
	previewRefreshQueued = { version, quality };
	if (previewRefreshPromise) return previewRefreshPromise;
	previewRefreshPromise = (async () => {
		while (previewRefreshQueued) {
			await performPreviewRefresh();
		}
		previewRefreshPromise = null;
	})();
	return previewRefreshPromise;
}

export function refreshPreview(mode: "progressive" | "final" = "progressive") {
	previewRefreshVersion += 1;
	const version = previewRefreshVersion;
	if (mode === "final") {
		return queuePreviewRefresh(version, "final");
	}
	const interactive =
		queuePreviewRefresh(version, "interactive") ?? Promise.resolve();
	return interactive.finally(() => {
		if (version !== previewRefreshVersion) return;
		return queuePreviewRefresh(version, "final") ?? Promise.resolve();
	});
}
