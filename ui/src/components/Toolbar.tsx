import { Component, JSX } from "solid-js";
import { openImageFile, state } from "../store/editor";

const ACCEPTED = "image/jpeg,image/png,image/tiff,image/webp,image/avif,image/x-exr,.exr";

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

const Toolbar: Component = () => {
  let fileInputRef: HTMLInputElement | undefined;

  const handleFileChange = async (e: Event) => {
    const file = (e.currentTarget as HTMLInputElement).files?.[0];
    if (file) await openImageFile(file);
    if (fileInputRef) fileInputRef.value = "";
  };

  return (
    <header class="flex items-center gap-4 border-b border-white/6 bg-[rgba(4,4,4,0.94)] px-4 py-3 backdrop-blur-[18px] lg:px-5">
      <div class="flex items-center gap-3">
        <div class="flex flex-col">
          <span class="hidden text-[11px] text-white/40 lg:block">
            {state.canvasWidth > 0 ? `${state.canvasWidth} × ${state.canvasHeight}` : "No image loaded"}
          </span>
        </div>
      </div>

      <input ref={fileInputRef} type="file" accept={ACCEPTED} class="hidden" onChange={handleFileChange} />

      <div class="ml-auto flex items-center gap-2">
        {state.isLoading && (
          <span class="hidden rounded-full border border-white/10 bg-white/6 px-3 py-1 text-[11px] font-medium text-white/70 sm:inline-flex">
            Processing
          </span>
        )}
        <ActionButton label="Open" icon={<UploadIcon />} onClick={() => fileInputRef?.click()} />
      </div>
    </header>
  );
};

export default Toolbar;
