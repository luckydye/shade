import type { Component } from "solid-js";
import { MEDIA_FILE_ACCEPT } from "../media-file-accept";
import {
  exportImage,
  pickExportTarget,
  openImageFile,
  showEditorView,
  state,
} from "../store/editor";
import { Button } from "./Button";
import { ActionButton } from "./ActionButton";

const STATUS_TRIGGER_CLASS =
  "min-w-0 rounded-md px-2 py-1 transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--border-active)]";

const UploadIcon = () => (
  <svg
    width="24px"
    height="24px"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="1.8"
    class="h-4 w-4"
  >
    <path d="M12 16V6" />
    <path d="m7.5 10.5 4.5-4.5 4.5 4.5" />
    <path d="M5 18.5c0 1.1.9 2 2 2h10c1.1 0 2-.9 2-2" />
  </svg>
);

const SaveIcon = () => (
  <svg
    width="24px"
    height="24px"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="1.8"
    class="h-4 w-4"
  >
    <path d="M12 4v9" />
    <path d="m7.5 9.5 4.5 4.5 4.5-4.5" />
    <path d="M5 18.5c0 1.1.9 2 2 2h10c1.1 0 2-.9 2-2" />
  </svg>
);

export const Toolbar: Component = () => {
  let fileInputRef: HTMLInputElement | undefined;
  const hasImage = () => state.canvasWidth > 0 || state.isLoading;
  const canResumeEditor = () => state.artboards.length > 0 && state.currentView === "media";
  const canExport = () => state.canvasWidth > 0 && state.canvasHeight > 0;

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

  const handleFileChange = async (e: Event) => {
    const files = (e.currentTarget as HTMLInputElement).files;
    if (!files || files.length === 0) {
      return;
    }
    const selectedFiles = Array.from(files);
    try {
      for (const [index, file] of selectedFiles.entries()) {
        await openImageFile(file, index === 0 ? "replace" : "append");
      }
    } catch {
      return;
    }
    if (fileInputRef) fileInputRef.value = "";
  };

  const handleExport = async () => {
    const path = await pickExportTarget();
    if (!path) {
      return;
    }
    await exportImage(path);
  };

  return (
    <header
      data-tauri-drag-region
      class="static grid w-full select-none grid-cols-[40px_minmax(0,1fr)_auto] items-center gap-3 border-b border-[var(--border)] bg-[var(--toolbar-bg)] px-4 py-3 backdrop-blur-[18px] md:grid-cols-[56px_minmax(0,1fr)_auto]"
    >
      <div class="flex h-8 items-center"></div>

      <div class="min-w-0 flex justify-center text-center pointer-events-none">
        <Button
          type="button"
          class={`pointer-events-auto min-w-0 max-w-full ${STATUS_TRIGGER_CLASS} ${
            canResumeEditor()
              ? "cursor-pointer hover:bg-[var(--surface-subtle)]"
              : "cursor-default"
          }`}
          style={{
            "view-transition-name":
              hasImage() && state.currentView === "media"
                ? "active-editor-media"
                : "none",
          }}
          onClick={() => {
            if (!canResumeEditor()) return;
            if (document.startViewTransition) {
              document.startViewTransition(showEditorView);
            } else {
              showEditorView();
            }
          }}
          disabled={!canResumeEditor()}
        >
          <span class="block max-w-full truncate text-[11px] font-medium text-[var(--text-value)]">
            {(state.isLoading && (
              <span>
                Processing
              </span>
            )) ||
              statusText()}
          </span>
        </Button>
      </div>

      <div>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept={MEDIA_FILE_ACCEPT}
          class="hidden"
          onChange={handleFileChange}
        />
        <div class="flex items-center justify-end gap-2">
          <ActionButton
            label="Export"
            icon={<SaveIcon />}
            onClick={() => void handleExport()}
            disabled={!canExport()}
            primary
          />
          <ActionButton
            label="Open"
            icon={<UploadIcon />}
            disabled={!state.webgpuAvailable}
            onClick={() => fileInputRef?.click()}
          />
        </div>
      </div>
    </header>
  );
};
