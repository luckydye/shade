import { Component } from "solid-js";
import { openImage } from "../store/editor";

const Toolbar: Component = () => {
  const handleOpen = async () => {
    // In a real Tauri app we'd use the dialog plugin.
    // For now, use a simple prompt for scaffolding.
    const path = prompt("Enter image path:");
    if (path) await openImage(path);
  };

  const handleExport = async () => {
    const path = prompt("Enter export path (e.g. output.png):");
    if (!path) return;
    // invoke("export_image", { path }) would go here
  };

  return (
    <div class="h-10 bg-toolbar border-b border-gray-700 flex items-center px-3 gap-2">
      <span class="text-white font-semibold text-sm mr-4">Shade</span>
      <button
        onClick={handleOpen}
        class="px-3 py-1 text-xs bg-gray-600 hover:bg-gray-500 rounded transition-colors"
      >
        Open
      </button>
      <button
        onClick={handleExport}
        class="px-3 py-1 text-xs bg-gray-600 hover:bg-gray-500 rounded transition-colors"
      >
        Export
      </button>
      <div class="flex-1" />
      <button class="px-3 py-1 text-xs bg-gray-600 hover:bg-gray-500 rounded transition-colors">
        Undo
      </button>
      <button class="px-3 py-1 text-xs bg-gray-600 hover:bg-gray-500 rounded transition-colors">
        Redo
      </button>
    </div>
  );
};

export default Toolbar;
