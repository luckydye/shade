import { Component, JSX, Show } from "solid-js";
import { openImageFile, showEditorView, showMediaView, state } from "../store/editor";

const ACCEPTED = "image/jpeg,image/png,image/tiff,image/webp,image/avif,image/x-exr,.exr,.3fr,.ari,.arw,.cr2,.cr3,.crm,.crw,.dcr,.dcs,.dng,.erf,.fff,.iiq,.kdc,.mef,.mos,.mrw,.nef,.nrw,.orf,.ori,.pef,.qtk,.raf,.raw,.rw2,.rwl,.srw,.x3f";

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
    class={`inline-flex min-h-10 items-center gap-2 rounded-2xl border px-3.5 text-white transition-colors ${
      props.primary
        ? "border-stone-100 bg-stone-100 text-stone-950 enabled:hover:bg-white"
        : "border-white/10 bg-white/[0.04] text-white/80 enabled:hover:border-white/15 enabled:hover:bg-white/[0.08] enabled:hover:text-white"
    } ${props.disabled ? "opacity-45" : ""}`}
  >
    <span class="inline-flex items-center justify-center">{props.icon}</span>
    <span class="hidden text-[13px] font-medium sm:inline">{props.label}</span>
  </button>
);

const BrandIcon = () => (
  <svg width="24px" height="24px" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" class="h-4 w-4">
    <path d="M12 3.5 14.2 8l4.8.8-3.5 3.4.8 4.8-4.3-2.3-4.3 2.3.8-4.8L5 8.8 9.8 8 12 3.5Z" />
    <path d="M8.5 12h7" />
    <path d="M12 8.5v7" />
  </svg>
);

const UploadIcon = () => (
  <svg width="24px" height="24px" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" class="h-4 w-4">
    <path d="M12 16V6" />
    <path d="m7.5 10.5 4.5-4.5 4.5 4.5" />
    <path d="M5 18.5c0 1.1.9 2 2 2h10c1.1 0 2-.9 2-2" />
  </svg>
);

const ResetIcon = () => (
  <svg width="24px" height="24px" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" class="h-4 w-4">
    <path d="M6.5 8A7 7 0 1 1 5 12" />
    <path d="M5 5.5v4h4" />
  </svg>
);

const SaveIcon = () => (
  <svg width="24px" height="24px" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" class="h-4 w-4">
    <path d="M12 4v9" />
    <path d="m7.5 9.5 4.5 4.5 4.5-4.5" />
    <path d="M5 18.5c0 1.1.9 2 2 2h10c1.1 0 2-.9 2-2" />
  </svg>
);

export const Toolbar: Component = () => {
  let fileInputRef: HTMLInputElement | undefined;
  const hasImage = () => state.canvasWidth > 0 || state.isLoading;
  const canResumeEditor = () => hasImage() && state.currentView === "media";

  const statusText = () => {
    if (state.canvasWidth <= 0 || state.canvasHeight <= 0) return "No image loaded";
    const previewResolution = state.previewRenderWidth > 0 && state.previewRenderHeight > 0
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

  return (
    <header class="absolute lg:static top-0 w-full z-50 grid grid-cols-[40px_1fr_40px] md:grid-cols-[auto_1fr_auto] items-center gap-6 border-b border-white/6 bg-[rgba(4,4,4,0.94)] px-4 py-3 backdrop-blur-[18px] lg:px-5 pt-[calc(env(safe-area-inset-top))]">
      <div>
        <Show when={hasImage() && state.currentView === "editor"}>
          <ActionButton
            label="Back"
            icon={
              <svg width="24px" height="24px" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" class="h-4 w-4">
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
      
      <div class="flex justify-center text-center">
        <button
          type="button"
          class={`flex flex-col ${canResumeEditor() ? "cursor-pointer" : "cursor-default"}`}
          style={{
            "view-transition-name": hasImage() && state.currentView === "media"
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
          <span class="block text-[11px] text-white/40">
            {state.isLoading && (
              <span class="hidden rounded-full border border-white/10 bg-white/6 px-3 py-1 text-[11px] font-medium text-white/70 sm:inline-flex">
                Processing
              </span>
            ) || statusText()}
          </span>
        </button>
      </div>

      <div>
        <input ref={fileInputRef} type="file" class="hidden" onChange={handleFileChange} />
        <ActionButton label="Open" icon={<UploadIcon />} onClick={() => fileInputRef?.click()} />
      </div>
    </header>
  );
};
