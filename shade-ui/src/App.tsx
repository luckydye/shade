import { Component, onMount } from "solid-js";
import { Toolbar } from "./components/Toolbar";
import { Inspector } from "./components/Inspector";
import { Viewport } from "./components/Viewport";
import { MediaView } from "./components/MediaView";
import { isTauriRuntime } from "./bridge";
import { checkWebGPU } from "./bridge/webgpu-check";
import { setState, state } from "./store/editor-store";

const App: Component = () => {
  const hasImage = () => state.canvasWidth > 0 || state.isLoading;
  const showEditor = () => hasImage() && state.currentView === "editor";

  onMount(() => {
    void (async () => {
      if (await isTauriRuntime()) {
        return;
      }
      const webgpu = await checkWebGPU();
      setState({
        webgpuAvailable: webgpu.available,
        webgpuReason: webgpu.available ? null : (webgpu.reason ?? "WebGPU unavailable"),
      });
    })();
  });

  return (
    <div class="app-gradient flex h-screen w-screen select-none flex-col overflow-hidden text-[var(--text)]">
      <Toolbar />
      <div class="flex min-h-0 flex-1">
        <MediaView />
        <div
          class={`min-h-0 flex-1 flex-col lg:flex-row ${showEditor() ? "flex" : "hidden"}`}
        >
          <Viewport />
          <Inspector />
        </div>
      </div>
    </div>
  );
};

export default App;
