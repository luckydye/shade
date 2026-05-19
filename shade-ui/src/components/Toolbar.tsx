import { type Component, onCleanup, onMount, Show } from "solid-js";
import { ToolbarExport } from "../actions/toolbar-export";
import { ToolbarOpen } from "../actions/toolbar-open";
import { actions, buildActionContext } from "../store/actions";
import { showEditorView, showMediaView, state } from "../store/editor-store";
import { ActionButton } from "./ActionButton";
import { Button } from "./Button";

import saveSvg from "../assets/icons/save.svg?raw";
import backSvg from "../assets/icons/back.svg?raw";
import uploadSvg from "../assets/icons/upload.svg?raw";

export const Toolbar: Component = () => {
  const canResumeEditor = () =>
    state.artboards.length > 0 && state.currentView === "media";
  const canExport = () => state.canvasWidth > 0 && state.canvasHeight > 0;
  const showMobileLibraryButton = () => state.currentView === "editor";
  const runAction = (id: string) => actions.run(id, buildActionContext());

  const statusText = () => {
    if (state.loadError) return state.loadError;
    if (!state.webgpuAvailable) {
      return state.webgpuReason ?? "WebGPU unavailable";
    }
    if (state.canvasWidth <= 0 || state.canvasHeight <= 0) return "No image loaded";
    const previewResolution =
      state.previewRenderWidth > 0 && state.previewRenderHeight > 0
        ? `${state.previewRenderWidth} × ${state.previewRenderHeight}`
        : "Pending";
    return [
      `Image ${state.canvasWidth} × ${state.canvasHeight}`,
      `Preview ${previewResolution}`,
      `Display ${state.previewDisplayColorSpace}`,
      `Source ${state.sourceBitDepth}`,
    ].join(" · ");
  };

  onMount(() => {
    actions.register(ToolbarExport);
    actions.register(ToolbarOpen);
    onCleanup(() => {
      actions.unregister("toolbar.export");
      actions.unregister("toolbar.open");
    });
  });

  return (
    <header
      data-tauri-drag-region
      class="mobile-slider-fade static z-40 grid w-full select-none grid-cols-[56px_minmax(0,1fr)_auto] items-center gap-3 border-b border-[var(--border)] bg-[var(--toolbar-bg)] px-4 pb-3 pt-3 backdrop-blur-[18px] transition-opacity duration-150 touch-compact:fixed touch-compact:inset-x-0 touch-compact:top-0 touch-compact:pt-[calc(env(safe-area-inset-top)+0.75rem)] touch-mobile:grid-cols-[40px_minmax(0,1fr)_auto]"
    >
      <div class="flex h-8 items-center">
        <Show when={showMobileLibraryButton()}>
          <Button
            type="button"
            class="hidden h-8 w-8 items-center justify-center rounded-md border border-[var(--border-medium)] bg-[var(--surface)] text-[var(--text-secondary)] transition-colors hover:border-[var(--border-active)] hover:bg-[var(--surface-hover)] hover:text-[var(--text)] touch-compact:flex"
            aria-label="Back to library"
            onClick={() => {
              showMediaView();
            }}
          >
            <span innerHTML={backSvg}></span>
          </Button>
        </Show>
      </div>

      <div class="min-w-0 flex justify-center text-center pointer-events-none">
        <Button
          type="button"
          class={`pointer-events-auto min-w-0 max-w-full min-w-0 rounded-md px-2 py-1 transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--border-active)] ${
            canResumeEditor()
              ? "cursor-pointer hover:bg-[var(--surface-subtle)]"
              : "cursor-default"
          }`}
          onClick={() => {
            if (!canResumeEditor()) return;
            showEditorView();
          }}
          disabled={!canResumeEditor()}
        >
          <span class="block max-w-full truncate text-[11px] font-medium text-[var(--text-value)]">
            {(state.isLoading && (
              <span>{state.isDownloading ? "Downloading" : "Processing"}</span>
            )) ||
              statusText()}
          </span>
        </Button>
      </div>

      <div>
        <div class="flex items-center justify-end gap-2">
          <ActionButton
            label="Export"
            icon={saveSvg}
            onClick={() => runAction("toolbar.export")}
            disabled={!canExport()}
            primary
          />
          <ActionButton
            label="Open"
            icon={uploadSvg}
            disabled={!state.webgpuAvailable}
            onClick={() => runAction("toolbar.open")}
          />
        </div>
      </div>
    </header>
  );
};
