import {
  fullCanvasCrop,
  normalizeCropRect,
  setState,
  state,
} from "./editor-store";
import { useOpenImage } from "./use-open-image";

function start() {
  if (state.canvasWidth <= 0 || state.canvasHeight <= 0) {
    throw new Error("cannot start crop mode without a loaded image");
  }
  setState({ isCropMode: true, cropDraft: state.crop });
  void useOpenImage().refreshPreview();
}

function cancel() {
  if (!state.isCropMode) return;
  setState({ isCropMode: false, cropDraft: null });
  void useOpenImage().refreshPreview();
}

function updateDraft(next: {
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
}) {
  if (!state.isCropMode) {
    throw new Error("cannot update crop draft when crop mode is inactive");
  }
  setState("cropDraft", normalizeCropRect(next));
}

function reset() {
  if (state.canvasWidth <= 0 || state.canvasHeight <= 0) {
    throw new Error("cannot reset crop without a loaded image");
  }
  const crop = fullCanvasCrop();
  setState({ crop, cropDraft: state.isCropMode ? crop : null });
  useOpenImage().resetViewport();
}

function apply() {
  if (!state.isCropMode || !state.cropDraft) {
    throw new Error("cannot apply crop without an active draft");
  }
  const crop = normalizeCropRect(state.cropDraft);
  setState({
    crop,
    cropDraft: null,
    isCropMode: false,
    viewportZoom: 1,
    viewportCenterX: crop.x + crop.width * 0.5,
    viewportCenterY: crop.y + crop.height * 0.5,
  });
  void useOpenImage().refreshPreview();
}

export function useCrop() {
  return { start, cancel, updateDraft, reset, apply };
}
