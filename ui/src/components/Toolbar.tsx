import { Component, JSX, Show } from "solid-js";
import { save } from "@tauri-apps/plugin-dialog";
import {
  exportImage,
  openImageFile,
  showEditorView,
  showMediaView,
  state,
} from "../store/editor";

const ACCEPTED =
  "image/jpeg,image/png,image/tiff,image/webp,image/avif,image/x-exr,.exr,.3fr,.ari,.arw,.cr2,.cr3,.crm,.crw,.dcr,.dcs,.dng,.erf,.fff,.iiq,.kdc,.mef,.mos,.mrw,.nef,.nrw,.orf,.ori,.pef,.qtk,.raf,.raw,.rw2,.rwl,.srw,.x3f";

interface ActionButtonProps {
  label: string;
  icon: JSX.Element;
  onClick?: () => void;
  disabled?: boolean;
  primary?: boolean;
}

const ActionButton: Component<ActionButtonProps> = (props) => (
  <button
    type="button"
    onClick={props.onClick}
    disabled={props.disabled}
    class={`inline-flex min-h-10 items-center gap-2 rounded-2xl border px-3.5 transition-colors ${
      props.primary
        ? "border-[var(--btn-primary-bg)] bg-[var(--btn-primary-bg)] text-[var(--btn-primary-text)] enabled:hover:bg-[var(--btn-primary-hover)]"
        : "border-[var(--border-medium)] bg-[var(--surface)] text-[var(--text-secondary)] enabled:hover:border-[var(--border-dashed)] enabled:hover:bg-[var(--surface-hover)] enabled:hover:text-[var(--text)]"
    } ${props.disabled ? "opacity-45" : ""}`}
  >
    <span class="inline-flex items-center justify-center">{props.icon}</span>
    <span class="hidden text-[13px] font-medium sm:inline">{props.label}</span>
  </button>
);

const BrandIcon = () => (
  <svg
    width="24px"
    height="24px"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="1.8"
    class="h-4 w-4"
  >
    <path d="M12 3.5 14.2 8l4.8.8-3.5 3.4.8 4.8-4.3-2.3-4.3 2.3.8-4.8L5 8.8 9.8 8 12 3.5Z" />
    <path d="M8.5 12h7" />
    <path d="M12 8.5v7" />
  </svg>
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

const ResetIcon = () => (
  <svg
    width="24px"
    height="24px"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="1.8"
    class="h-4 w-4"
  >
    <path d="M6.5 8A7 7 0 1 1 5 12" />
    <path d="M5 5.5v4h4" />
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
  const canResumeEditor = () => hasImage() && state.currentView === "media";
  const canExport = () => state.canvasWidth > 0 && state.canvasHeight > 0;

  const statusText = () => {
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
    const file = files?.[0];
    if (file) await openImageFile(file);
    if (fileInputRef) fileInputRef.value = "";
  };

  const handleExport = async () => {
    const path = await save({
      title: "Export Render",
      filters: [
        { name: "PNG Image", extensions: ["png"] },
        { name: "JPEG Image", extensions: ["jpg", "jpeg"] },
      ],
    });
    if (!path) {
      return;
    }
    await exportImage(path);
  };

  return (
    <header data-tauri-drag-region class="absolute select-none lg:static top-0 w-full z-50 grid grid-cols-[40px_auto_40px] md:grid-cols-[auto_auto_auto] items-center gap-6 border-b border-[var(--border)] bg-[var(--toolbar-bg)] px-4 py-3 backdrop-blur-[18px] lg:px-3 pt-[calc(env(safe-area-inset-top))] lg:pt-2">
      <div>
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

      <div class="flex justify-center text-center pointer-events-none">
        <button
          type="button"
          class={`flex flex-col pointer-events-auto ${
            canResumeEditor() ? "cursor-pointer" : "cursor-default"
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
          <span class="block text-[11px] text-[var(--text-faint)]">
            {(state.isLoading && (
              <span class="hidden rounded-full border border-[var(--border-medium)] bg-[var(--surface-hover)] px-3 py-1 text-[11px] font-medium text-[var(--text-muted)] sm:inline-flex">
                Processing
              </span>
            )) ||
              statusText()}
          </span>
        </button>
      </div>

      <div>
        <input
          ref={fileInputRef}
          type="file"
          class="hidden"
          onChange={handleFileChange}
        />
        <div class="flex items-center justify-end gap-2">
          <ActionButton
            label="Export"
            icon={<SaveIcon />}
            onClick={() => void handleExport()}
            disabled={!canExport()}
          />
          <ActionButton
            label="Open"
            icon={<UploadIcon />}
            onClick={() => fileInputRef?.click()}
          />
        </div>
      </div>
    </header>
  );
};
