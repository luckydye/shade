import {
  type Component,
  onCleanup,
  onMount,
  Show,
} from "solid-js";
import actionShortcuts from "./keybinds.json";
import { EditorView } from "./components/EditorView";
import { MediaView } from "./components/MediaView";
import { targetAcceptsTextInput } from "./components/media-view/media-utils";
import { StatusPanel } from "./components/StatusPanel";
import { Toast } from "./components/Toast";
import { Toolbar } from "./components/Toolbar";
import { actions, type ActionShortcutMap, buildActionContext } from "./store/actions";
import { setState, state } from "./store/editor-store";
import { useNavigationHistory } from "./app/use-navigation-history";
import { checkWebGPU } from "./utils/webgpu-check";

let actionShortcutsLoaded = false;

const App: Component = () => {
  const hasImage = () => state.canvasWidth > 0 || state.isLoading;
  const showEditor = () => hasImage() && state.currentView === "editor";
  
  useNavigationHistory();

  onMount(() => {
    void (async () => {
      const webgpu = await checkWebGPU();
      setState({
        webgpuAvailable: webgpu.available,
        webgpuReason: webgpu.available ? null : (webgpu.reason ?? "WebGPU unavailable"),
      });
    })();
  });

  onMount(() => {
    if (!actionShortcutsLoaded) {
      actions.loadShortcuts(actionShortcuts as ActionShortcutMap);
      actionShortcutsLoaded = true;
    }

    const handleKeyDown = (e: KeyboardEvent) => {
      if (targetAcceptsTextInput(e.target)) return;
      if (e.defaultPrevented) return;
      const handled = actions.handleKey(e, buildActionContext());
      if (handled) return;
    };
    document.addEventListener("keydown", handleKeyDown);
    
    onCleanup(() => {
      document.removeEventListener("keydown", handleKeyDown);
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
