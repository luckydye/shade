import { Component, For } from "solid-js";
import { state, selectLayer, setLayerVisible, refreshLayerStack } from "../store/editor";
import { invoke } from "@tauri-apps/api/core";

const LayerPanel: Component = () => {
  const addAdjustmentLayer = async () => {
    await invoke("add_layer", { kind: "adjustment" });
    await refreshLayerStack();
  };

  return (
    <div class="w-48 bg-panel border-r border-gray-700 flex flex-col">
      <div class="p-2 border-b border-gray-700 text-xs font-semibold text-gray-400 uppercase tracking-wider">
        Layers
      </div>
      <div class="flex-1 overflow-y-auto">
        <For each={[...state.layers].reverse()}>
          {(layer, i) => {
            const realIdx = state.layers.length - 1 - i();
            return (
              <div
                class={`flex items-center gap-2 px-2 py-1.5 cursor-pointer border-b border-gray-800 text-xs
                  ${state.selectedLayerIdx === realIdx ? "bg-blue-900/40" : "hover:bg-gray-800"}`}
                onClick={() => selectLayer(realIdx)}
              >
                <button
                  class={`w-4 h-4 flex-shrink-0 rounded-sm border text-center leading-none
                    ${layer.visible ? "bg-accent border-accent text-white" : "border-gray-600"}`}
                  onClick={(e) => { e.stopPropagation(); setLayerVisible(realIdx, !layer.visible); }}
                  title="Toggle visibility"
                >
                  {layer.visible ? "●" : "○"}
                </button>
                <span class="flex-1 truncate">
                  {layer.kind === "image" ? "Image" : "Adjustment"}
                </span>
              </div>
            );
          }}
        </For>
      </div>
      <div class="p-2 border-t border-gray-700">
        <button
          onClick={addAdjustmentLayer}
          class="w-full text-xs py-1 bg-gray-700 hover:bg-gray-600 rounded transition-colors"
        >
          + Add Adjustment
        </button>
      </div>
    </div>
  );
};

export default LayerPanel;
