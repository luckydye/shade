import { createStore } from "solid-js/store";
import * as bridge from "../bridge/index";

export interface LayerInfo {
  kind: "image" | "adjustment";
  visible: boolean;
  opacity: number;
  blend_mode?: string;
}

export interface EditorState {
  layers: LayerInfo[];
  canvasWidth: number;
  canvasHeight: number;
  selectedLayerIdx: number;
  isLoading: boolean;
  webgpuAvailable: boolean;
}

const [state, setState] = createStore<EditorState>({
  layers: [],
  canvasWidth: 0,
  canvasHeight: 0,
  selectedLayerIdx: -1,
  isLoading: false,
  webgpuAvailable: true,
});

export { state };

export async function openImage(path: string) {
  setState("isLoading", true);
  try {
    const info = await bridge.openImage(path);
    setState({ canvasWidth: info.canvas_width, canvasHeight: info.canvas_height });
    await refreshLayerStack();
  } finally {
    setState("isLoading", false);
  }
}

export async function refreshLayerStack() {
  const info = await bridge.getLayerStack();
  setState({
    layers: info.layers as LayerInfo[],
    canvasWidth: info.canvas_width,
    canvasHeight: info.canvas_height,
  });
}

export async function setLayerVisible(idx: number, visible: boolean) {
  await bridge.setLayerVisible(idx, visible);
  await refreshLayerStack();
}

export async function setLayerOpacity(idx: number, opacity: number) {
  await bridge.setLayerOpacity(idx, opacity);
  await refreshLayerStack();
}

export async function applyEdit(params: Record<string, unknown>) {
  await bridge.applyEdit(params);
}

export function selectLayer(idx: number) {
  setState("selectedLayerIdx", idx);
}

export async function addLayer(kind: string) {
  await bridge.addLayer(kind);
  await refreshLayerStack();
}
