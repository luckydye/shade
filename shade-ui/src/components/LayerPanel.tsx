import { type Component, createSignal, For, Show } from "solid-js";
import {
  addLayer,
  applyGradientMask,
  createBrushMask,
  deleteLayer,
  moveLayer,
  removeMask,
  selectLayer,
  setLayerVisible,
  state,
} from "../store/editor";
import { getLayerDisplayName } from "../store/editor-store";
import { Button } from "./Button";

type GradientKind = "linear" | "radial";
type DropTarget = { layerIdx: number; position: "before" | "after" };

const LayerPanel: Component = () => {
  const [maskTarget, setMaskTarget] = createSignal<number | null>(null);
  const [dropTarget, setDropTarget] = createSignal<DropTarget | null>(null);
  let draggedLayerIdx: number | null = null;

  const topLayerInsertPosition = () => state.layers.length;

  const cropLayerInsertPosition = () => {
    const imageLayerIdx = state.layers.findIndex((layer) => layer.kind === "image");
    if (imageLayerIdx < 0) {
      throw new Error("cannot add a crop layer without an image layer");
    }
    return imageLayerIdx + 1;
  };

  const addAdjustmentLayer = async () => {
    await addLayer("adjustment", topLayerInsertPosition());
  };

  const addCurvesLayer = async () => {
    await addLayer("curves", topLayerInsertPosition());
  };

  const addLsCurveLayer = async () => {
    await addLayer("ls_curve", topLayerInsertPosition());
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

  const applyBrushMask = async (idx: number) => {
    await createBrushMask(idx);
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
                <Show
                  when={
                    rowDropTarget()?.layerIdx === realIdx &&
                    rowDropTarget()?.position === "before"
                  }
                >
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
                  <Button
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
                  </Button>
                  <span class="flex-1 truncate">{getLayerDisplayName(layer)}</span>
                  <Show when={layer.has_mask}>
                    <Button
                      class="text-blue-400 text-[10px] hover:text-red-400 transition-colors"
                      onClick={(e) => {
                        e.stopPropagation();
                        void removeMask(realIdx);
                      }}
                      title="Remove mask"
                    >
                      M
                    </Button>
                  </Show>
                  <Show when={!layer.has_mask && layer.kind !== "crop"}>
                    <Button
                      class="text-[var(--text-faint)] text-[10px] hover:text-[var(--text)] transition-colors"
                      onClick={(e) => {
                        e.stopPropagation();
                        setMaskTarget(maskTarget() === realIdx ? null : realIdx);
                      }}
                      title="Add mask"
                    >
                      +M
                    </Button>
                  </Show>
                  {layer.kind !== "image" && (
                    <Button
                      class="text-[var(--text-faint)] transition-colors hover:text-[var(--text)]"
                      onClick={(e) => {
                        e.stopPropagation();
                        void deleteLayer(realIdx);
                      }}
                      title="Delete layer"
                    >
                      ×
                    </Button>
                  )}
                </div>
                <Show when={maskTarget() === realIdx}>
                  <div class="flex gap-1 px-2 py-1 bg-[var(--surface-faint)] border-b border-[var(--border)]">
                    <Button
                      class="flex-1 text-[10px] py-0.5 bg-[var(--surface-hover)] hover:bg-[var(--surface-active)] rounded transition-colors"
                      onClick={() => void applyLinearMask(realIdx)}
                    >
                      Linear
                    </Button>
                    <Button
                      class="flex-1 text-[10px] py-0.5 bg-[var(--surface-hover)] hover:bg-[var(--surface-active)] rounded transition-colors"
                      onClick={() => void applyRadialMask(realIdx)}
                    >
                      Radial
                    </Button>
                    <Button
                      class="flex-1 text-[10px] py-0.5 bg-[var(--surface-hover)] hover:bg-[var(--surface-active)] rounded transition-colors"
                      onClick={() => void applyBrushMask(realIdx)}
                    >
                      Brush
                    </Button>
                  </div>
                </Show>
                <Show
                  when={
                    rowDropTarget()?.layerIdx === realIdx &&
                    rowDropTarget()?.position === "after"
                  }
                >
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
        <Button
          onClick={addAdjustmentLayer}
          class="w-full text-xs py-1 bg-[var(--surface-hover)] hover:bg-[var(--surface-active)] rounded transition-colors"
        >
          + Add Adjustment
        </Button>
        <Button
          onClick={addCurvesLayer}
          class="w-full mt-2 text-xs py-1 bg-[var(--surface-hover)] hover:bg-[var(--surface-active)] rounded transition-colors"
        >
          + Add Curves
        </Button>
        <Button
          onClick={() => void addLayer("crop", cropLayerInsertPosition())}
          class="w-full mt-2 text-xs py-1 bg-[var(--surface-hover)] hover:bg-[var(--surface-active)] rounded transition-colors"
        >
          + Add Crop
        </Button>
      </div>
    </div>
  );
};

export { LayerPanel };
