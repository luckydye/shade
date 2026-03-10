import { Component, Show } from "solid-js";
import { state } from "./store/editor";
import Toolbar from "./components/Toolbar";
import LayerPanel from "./components/LayerPanel";
import Inspector from "./components/Inspector";
import Canvas from "./components/Canvas";

const App: Component = () => {
  return (
    <div class="flex flex-col h-screen w-screen select-none">
      {/* Toolbar */}
      <Toolbar />

      {/* Main area */}
      <div class="flex flex-1 overflow-hidden">
        {/* Layer panel */}
        <LayerPanel />

        {/* Canvas */}
        <Canvas />

        {/* Inspector */}
        <Inspector />
      </div>

      {/* Status bar */}
      <div class="h-6 bg-toolbar border-t border-gray-700 flex items-center px-3 text-xs text-gray-400 gap-6">
        <span>{state.canvasWidth > 0 ? `${state.canvasWidth}×${state.canvasHeight}` : "No image"}</span>
        <span>{state.layers.length} layers</span>
        <Show when={state.isLoading}>
          <span class="text-accent">Processing…</span>
        </Show>
      </div>
    </div>
  );
};

export default App;
