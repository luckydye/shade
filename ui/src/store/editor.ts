import { createStore } from "solid-js/store";
import { invoke } from "@tauri-apps/api/core";

export interface LayerInfo {
  kind: "image" | "adjustment";
  visible: boolean;
  opacity: number;
  blend_mode: string;
}

export interface EditorState {
  layers: LayerInfo[];
  canvasWidth: number;
  canvasHeight: number;
  selectedLayerIdx: number;
  isLoading: boolean;
}

const [state, setState] = createStore<EditorState>({
  layers: [],
  canvasWidth: 0,
  canvasHeight: 0,
  selectedLayerIdx: -1,
  isLoading: false,
});

export { state };

export async function openImage(path: string) {
  setState("isLoading", true);
  try {
    const info = await invoke<{ layer_count: number; canvas_width: number; canvas_height: number }>(
      "open_image",
      { path }
    );
    setState({ canvasWidth: info.canvas_width, canvasHeight: info.canvas_height });
    await refreshLayerStack();
  } finally {
    setState("isLoading", false);
  }
}

export async function refreshLayerStack() {
  const info = await invoke<{
    layers: LayerInfo[];
    canvas_width: number;
    canvas_height: number;
    generation: number;
  }>("get_layer_stack");
  setState({ layers: info.layers, canvasWidth: info.canvas_width, canvasHeight: info.canvas_height });
}

export async function setLayerVisible(idx: number, visible: boolean) {
  await invoke("set_layer_visible", { params: { layer_idx: idx, visible } });
  await refreshLayerStack();
}

export async function setLayerOpacity(idx: number, opacity: number) {
  await invoke("set_layer_opacity", { params: { layer_idx: idx, opacity } });
  await refreshLayerStack();
}

export async function applyEdit(params: Record<string, unknown>) {
  await invoke("apply_edit", { params });
  // In a real app, trigger re-render of the viewport here
}

export function selectLayer(idx: number) {
  setState("selectedLayerIdx", idx);
}
