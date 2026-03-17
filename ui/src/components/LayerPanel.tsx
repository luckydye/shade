import { Component, For, Show, createSignal } from "solid-js";
import {
  state,
  selectLayer,
  setLayerVisible,
  addLayer,
  deleteLayer,
  applyGradientMask,
  removeMask,
  moveLayer,
} from "../store/editor";

type GradientKind = "linear" | "radial";
type DropTarget = { layerIdx: number; position: "before" | "after" };

const LayerPanel: Component = () => {
  const [maskTarget, setMaskTarget] = createSignal<number | null>(null);
  const [dropTarget, setDropTarget] = createSignal<DropTarget | null>(null);
  let draggedLayerIdx: number | null = null;

  const addAdjustmentLayer = async () => {
    await addLayer("adjustment");
  };

  const addCurvesLayer = async () => {
    await addLayer("curves");
  };

  const applyLinearMask = async (idx: number) => {
    const w = state.canvasWidth;
    const h = state.canvasHeight;
    await applyGradientMask({
      kind: "linear",
      layer_idx: idx,
      x1: 0,
      y1: 0,
      x2: 0,
      y2: h,
    });
    setMaskTarget(null);
  };

  const applyRadialMask = async (idx: number) => {
    const w = state.canvasWidth;
    const h = state.canvasHeight;
    await applyGradientMask({
      kind: "radial",
      layer_idx: idx,
      cx: w / 2,
      cy: h / 2,
      radius: Math.min(w, h) / 2,
    });
    setMaskTarget(null);
  };

  const resolveDropIndex = (target: DropTarget) =>
    target.position === "before" ? target.layerIdx + 1 : target.layerIdx;

  const clearDragState = () => {
    draggedLayerIdx = null;
    setDropTarget(null);
  };

  const updateDropTarget = (event: DragEvent, layerIdx: number) => {
    const currentTarget = event.currentTarget;
    if (!(currentTarget instanceof HTMLDivElement)) {
      throw new Error("layer drop target must be a div");
    }
    const bounds = currentTarget.getBoundingClientRect();
    const position =
      event.clientY < bounds.top + bounds.height * 0.5 ? "before" : "after";
    setDropTarget({ layerIdx, position });
  };

  const startLayerDrag = (event: DragEvent, layerIdx: number) => {
    draggedLayerIdx = layerIdx;
    event.dataTransfer?.setData("text/plain", String(layerIdx));
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = "move";
    }
  };

  const commitDrop = async () => {
    const fromIdx = draggedLayerIdx;
    const target = dropTarget();
    clearDragState();
    if (fromIdx === null || target === null) {
      return;
    }
    await moveLayer(fromIdx, resolveDropIndex(target));
  };

  return (
    <div class="w-48 bg-[var(--panel-bg)] border-r border-[var(--border-medium)] flex flex-col">
      <div class="p-2 border-b border-[var(--border-medium)] text-xs font-semibold text-[var(--text-muted)] uppercase tracking-wider">
        Layers
      </div>
      <div class="flex-1 overflow-y-auto">
        <For each={[...state.layers].reverse()}>
          {(layer, i) => {
            const realIdx = state.layers.length - 1 - i();
            const rowDropTarget = () => dropTarget();
            return (
              <div>
                <Show when={rowDropTarget()?.layerIdx === realIdx && rowDropTarget()?.position === "before"}>
                  <div class="pointer-events-none px-2">
                    <div class="h-0.5 rounded-full bg-blue-400" />
                  </div>
                </Show>
                <div
                  draggable
                  class={`flex items-center gap-2 px-2 py-1.5 cursor-pointer border-b border-[var(--border)] text-xs
                    ${
                      state.selectedLayerIdx === realIdx
                        ? "bg-[var(--surface-active)]"
                        : "hover:bg-[var(--surface)]"
                    }`}
                  style={{ "-webkit-user-drag": "element", "user-drag": "element" }}
                  onClick={() => selectLayer(realIdx)}
                  onDragStart={(event) => startLayerDrag(event, realIdx)}
                  onDragEnd={clearDragState}
                  onDragOver={(event) => {
                    event.preventDefault();
                    if (draggedLayerIdx === null || draggedLayerIdx === realIdx) {
                      setDropTarget(null);
                      return;
                    }
                    updateDropTarget(event, realIdx);
                  }}
                  onDrop={(event) => {
                    event.preventDefault();
                    void commitDrop();
                  }}
                >
                  <button
                    class={`w-4 h-4 flex-shrink-0 rounded-sm border text-center leading-none
                      ${
                        layer.visible
                          ? "bg-blue-500 border-blue-500 text-white"
                          : "border-[var(--border-medium)]"
                      }`}
                    onClick={(e) => {
                      e.stopPropagation();
                      setLayerVisible(realIdx, !layer.visible);
                    }}
                    title="Toggle visibility"
                  >
                    {layer.visible ? "●" : "○"}
                  </button>
                  <span class="flex-1 truncate">
                    {layer.kind === "image"
                      ? "Image"
                      : layer.kind === "crop"
                        ? "Crop"
                        : "Adjustment"}
                  </span>
                  <Show when={layer.has_mask}>
                    <button
                      class="text-blue-400 text-[10px] hover:text-red-400 transition-colors"
                      onClick={(e) => {
                        e.stopPropagation();
                        void removeMask(realIdx);
                      }}
                      title="Remove mask"
                    >
                      M
                    </button>
                  </Show>
                  <Show when={!layer.has_mask && layer.kind !== "crop"}>
                    <button
                      class="text-[var(--text-faint)] text-[10px] hover:text-[var(--text)] transition-colors"
                      onClick={(e) => {
                        e.stopPropagation();
                        setMaskTarget(maskTarget() === realIdx ? null : realIdx);
                      }}
                      title="Add mask"
                    >
                      +M
                    </button>
                  </Show>
                  {layer.kind !== "image" && (
                    <button
                      class="text-[var(--text-faint)] transition-colors hover:text-[var(--text)]"
                      onClick={(e) => {
                        e.stopPropagation();
                        void deleteLayer(realIdx);
                      }}
                      title="Delete layer"
                    >
                      ×
                    </button>
                  )}
                </div>
                <Show when={maskTarget() === realIdx}>
                  <div class="flex gap-1 px-2 py-1 bg-[var(--surface-faint)] border-b border-[var(--border)]">
                    <button
                      class="flex-1 text-[10px] py-0.5 bg-[var(--surface-hover)] hover:bg-[var(--surface-active)] rounded transition-colors"
                      onClick={() => void applyLinearMask(realIdx)}
                    >
                      Linear
                    </button>
                    <button
                      class="flex-1 text-[10px] py-0.5 bg-[var(--surface-hover)] hover:bg-[var(--surface-active)] rounded transition-colors"
                      onClick={() => void applyRadialMask(realIdx)}
                    >
                      Radial
                    </button>
                  </div>
                </Show>
                <Show when={rowDropTarget()?.layerIdx === realIdx && rowDropTarget()?.position === "after"}>
                  <div class="pointer-events-none px-2">
                    <div class="h-0.5 rounded-full bg-blue-400" />
                  </div>
                </Show>
              </div>
            );
          }}
        </For>
      </div>
      <div class="p-2 border-t border-[var(--border-medium)]">
        <button
          onClick={addAdjustmentLayer}
          class="w-full text-xs py-1 bg-[var(--surface-hover)] hover:bg-[var(--surface-active)] rounded transition-colors"
        >
          + Add Adjustment
        </button>
        <button
          onClick={addCurvesLayer}
          class="w-full mt-2 text-xs py-1 bg-[var(--surface-hover)] hover:bg-[var(--surface-active)] rounded transition-colors"
        >
          + Add Curves
        </button>
        <button
          onClick={() => void addLayer("crop")}
          class="w-full mt-2 text-xs py-1 bg-[var(--surface-hover)] hover:bg-[var(--surface-active)] rounded transition-colors"
        >
          + Add Crop
        </button>
      </div>
    </div>
  );
};

export { LayerPanel };
