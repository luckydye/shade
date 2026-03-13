import { Component } from "solid-js";
import { openImageFile } from "../store/editor";

const ACCEPTED = "image/jpeg,image/png,image/tiff,image/webp,image/avif";

const Toolbar: Component = () => {
  let fileInputRef: HTMLInputElement | undefined;

  const handleFileChange = async (e: Event) => {
    const file = (e.currentTarget as HTMLInputElement).files?.[0];
    if (file) await openImageFile(file);
    // Reset so the same file can be re-selected
    if (fileInputRef) fileInputRef.value = "";
  };

  return (
    <div class="h-10 bg-toolbar border-b border-gray-700 flex items-center px-3 gap-2">
      <span class="text-white font-semibold text-sm mr-4">Shade</span>

      {/* Hidden native file picker */}
      <input ref={fileInputRef} type="file" accept={ACCEPTED} class="hidden" onChange={handleFileChange} />

      <button
        onClick={() => fileInputRef?.click()}
        class="px-3 py-1 text-xs bg-gray-600 hover:bg-gray-500 rounded transition-colors"
      >
        Open
      </button>
      <button class="px-3 py-1 text-xs bg-gray-600 hover:bg-gray-500 rounded transition-colors">
        Export
      </button>

      <div class="flex-1" />
    </div>
  );
};

export default Toolbar;
