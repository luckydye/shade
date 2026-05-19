import { type Component, onMount, Show } from "solid-js";
import { useNavigationHistory } from "./utils/use-navigation-history";
import { EditorView } from "./components/EditorView";
import { MediaView } from "./components/MediaView";
import { StatusPanel } from "./components/StatusPanel";
import { Toast } from "./components/Toast";
import { Toolbar } from "./components/Toolbar";
import { setState, state } from "./store/editor-store";
import { checkWebGPU } from "./utils/webgpu-check";
import { useKeybinds } from "./utils/use-keybinds";

const App: Component = () => {
  const showEditor = () => (state.canvasWidth > 0 || state.isLoading) && state.currentView === "editor";

  useNavigationHistory();
  useKeybinds();

  onMount(async () => {
    const webgpu = await checkWebGPU();
    setState({
      webgpuAvailable: webgpu.available,
      webgpuReason: webgpu.available ? null : (webgpu.reason ?? "WebGPU unavailable"),
    });
  });

  return (
    <div class="bg-surface-background relative flex h-screen w-screen select-none flex-col overflow-hidden text-[var(--text)]">
      <Toolbar />
      <div class="flex min-h-0 flex-1">
        <MediaView />
        <Show when={showEditor()}>
          <EditorView />
        </Show>
      </div>
      <StatusPanel />
      <Toast />
    </div>
  );
};

export default App;
