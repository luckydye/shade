import type { Component } from "solid-js";
import { onCleanup, onMount, Show } from "solid-js";
import { useMediaUploadHandlers } from "../../utils/use-media-upload-handlers";
import { useMediaViewStore } from "./media-view-store";

export const UploadDropOverlay: Component = () => {
  const store = useMediaViewStore();
  const uploads = useMediaUploadHandlers();

  onMount(() => {
    const handleDragEnter = (event: DragEvent) => uploads.handleUploadDragEnter(event);
    const handleDragOver = (event: DragEvent) => uploads.handleUploadDragOver(event);
    const handleDragLeave = (event: DragEvent) => uploads.handleUploadDragLeave(event);
    const handleDrop = (event: DragEvent) => uploads.handleUploadDrop(event);
    const handlePaste = (event: ClipboardEvent) => uploads.handleUploadPaste(event);

    window.addEventListener("dragenter", handleDragEnter);
    window.addEventListener("dragover", handleDragOver);
    window.addEventListener("dragleave", handleDragLeave);
    window.addEventListener("drop", handleDrop);
    window.addEventListener("paste", handlePaste);

    onCleanup(() => {
      window.removeEventListener("dragenter", handleDragEnter);
      window.removeEventListener("dragover", handleDragOver);
      window.removeEventListener("dragleave", handleDragLeave);
      window.removeEventListener("drop", handleDrop);
      window.removeEventListener("paste", handlePaste);
    });
  });

  return (
    <Show when={uploads.isUploadDragActive()}>
      <div class="pointer-events-none absolute inset-3 z-20 flex items-center justify-center rounded-xl border border-dashed border-[var(--border-active)] bg-[color-mix(in_srgb,var(--surface-active)_68%,transparent)]">
        <div class="flex flex-col items-center gap-2 rounded-2xl border border-[var(--border-active)] bg-[var(--panel-bg)] px-5 py-4 text-center shadow-[0_12px_32px_rgba(0,0,0,0.18)]">
          <div class="text-[11px] font-semibold uppercase tracking-[0.04em] text-[var(--text)]">
            {uploads.uploadDragLabel()}
          </div>
          <p class="text-[12px] font-medium text-[var(--text-dim)]">
            {store.selectedLibrary()?.name ?? "Selected library"}
          </p>
        </div>
      </div>
    </Show>
  );
};
