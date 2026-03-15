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
    <div class="flex h-screen w-screen select-none flex-col overflow-hidden bg-[radial-gradient(circle_at_top,_rgba(255,255,255,0.06),_transparent_24%),linear-gradient(180deg,_#050505_0%,_#0c0c0c_100%)] text-stone-100">
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
