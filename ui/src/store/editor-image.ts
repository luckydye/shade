import * as bridge from "../bridge/index";
import {
	fullCanvasCrop,
	setPreviewContextFrame,
	setPreviewFrame,
	setState,
	state,
} from "./editor-store";
import { refreshPreview } from "./editor-preview";
import { refreshLayerStack } from "./editor-layers";

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

async function openImageFrom(
	load: () => Promise<{
		canvas_width: number;
		canvas_height: number;
		source_bit_depth: string;
	}>,
	loadingMediaSrc: string | null,
) {
	clearLoadedImageState();
	setState({
		currentView: "editor",
		isLoading: true,
		loadingMediaSrc,
	});
	try {
		const info = await load();
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
	await openImageFrom(() => bridge.openImage(path), loadingMediaSrc);
}

export async function openImageFile(file: File) {
	await openImageFrom(() => bridge.openImageFile(file), null);
}

export async function openPeerImage(
	peerEndpointId: string,
	picture: bridge.SharedPicture,
	loadingMediaSrc: string | null = null,
) {
	await openImageFrom(
		() => bridge.openPeerImage(peerEndpointId, picture),
		loadingMediaSrc,
	);
}
