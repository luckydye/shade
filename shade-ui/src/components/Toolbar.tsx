import { Component, JSX, Show } from "solid-js";
import {
  exportImage,
  pickExportTarget,
  openImageFile,
  showEditorView,
  showMediaView,
  state,
} from "../store/editor";
import { Button } from "./Button";

const ACCEPTED =
  "image/jpeg,image/png,image/tiff,image/webp,image/avif,image/x-exr,.exr,.3fr,.ari,.arw,.cr2,.cr3,.crm,.crw,.dcr,.dcs,.dng,.erf,.fff,.iiq,.kdc,.mef,.mos,.mrw,.nef,.nrw,.orf,.ori,.pef,.qtk,.raf,.raw,.rw2,.rwl,.srw,.x3f";

interface ActionButtonProps {
  label: string;
  icon: JSX.Element;
  onClick?: () => void;
  disabled?: boolean;
  primary?: boolean;
}

const TOOLBAR_BUTTON_BASE_CLASS =
  "inline-flex h-8 items-center gap-2 rounded-md border px-3 text-[11px] font-semibold uppercase tracking-[0.03em] transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--border-active)] disabled:opacity-45";
const TOOLBAR_BUTTON_PRIMARY_CLASS =
  "border-[var(--btn-primary-bg)] bg-[var(--btn-primary-bg)] text-[var(--btn-primary-text)] enabled:hover:bg-[var(--btn-primary-hover)]";
const TOOLBAR_BUTTON_SECONDARY_CLASS =
  "border-[var(--border-medium)] bg-[var(--surface)] text-[var(--text-secondary)] enabled:hover:border-[var(--border-active)] enabled:hover:bg-[var(--surface-hover)] enabled:hover:text-[var(--text)]";
const STATUS_TRIGGER_CLASS =
  "min-w-0 rounded-md px-2 py-1 transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--border-active)]";
const STATUS_PILL_CLASS =
  "inline-flex h-8 items-center rounded-md border border-[var(--border-medium)] bg-[var(--surface)] px-3 text-[11px] font-medium text-[var(--text-value)]";

const ActionButton: Component<ActionButtonProps> = (props) => (
  <Button
    type="button"
    onClick={props.onClick}
    disabled={props.disabled}
    class={`${TOOLBAR_BUTTON_BASE_CLASS} ${
      props.primary
        ? TOOLBAR_BUTTON_PRIMARY_CLASS
        : TOOLBAR_BUTTON_SECONDARY_CLASS
    }`}
  >
    <span class="inline-flex items-center justify-center">{props.icon}</span>
    <span class="hidden sm:inline">{props.label}</span>
  </Button>
);

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
      class="absolute top-0 z-50 grid w-full select-none grid-cols-[40px_minmax(0,1fr)_auto] items-center gap-3 border-b border-[var(--border)] bg-[var(--toolbar-bg)] px-3 py-2 pt-[calc(env(safe-area-inset-top)+0.5rem)] backdrop-blur-[18px] lg:static lg:grid-cols-[56px_minmax(0,1fr)_auto] lg:pt-2"
    >
      <div class="flex h-8 items-center">
        <Show when={hasImage() && state.currentView === "editor"}>
          <ActionButton
            label="Back"
            icon={
              <svg
                width="24px"
                height="24px"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="1.8"
                class="h-4 w-4"
              >
                <path d="M15 18l-6-6 6-6" />
              </svg>
            }
            onClick={() => {
              if (document.startViewTransition) {
                document.startViewTransition(showMediaView);
              } else {
                showMediaView();
              }
            }}
          />
        </Show>
      </div>

      <div class="min-w-0 flex justify-center text-center">
        <Button
          type="button"
          class={`min-w-0 max-w-full ${STATUS_TRIGGER_CLASS} ${
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
          accept={ACCEPTED}
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
