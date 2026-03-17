import { Component, Show } from "solid-js";
import { Toolbar } from "./components/Toolbar";
import Inspector from "./components/Inspector";
import Canvas from "./components/Canvas";
import { MediaView } from "./components/MediaView";
import { state } from "./store/editor";

const App: Component = () => {
  const hasImage = () => state.canvasWidth > 0 || state.isLoading;
  const showEditor = () => hasImage() && state.currentView === "editor";

  return (
    <div class="app-gradient flex h-screen w-screen select-none flex-col overflow-hidden text-[var(--text)]">
      <Toolbar />
      <Show when={showEditor()} fallback={<MediaView />}>
        <div class="flex min-h-0 flex-1 flex-col lg:flex-row">
          <Canvas />
          <Inspector />
        </div>
      </Show>
    </div>
  );
};

export default App;
