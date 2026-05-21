import { type Component, onMount, Show } from "solid-js";
import backSvg from "./assets/icons/back.svg?raw";
import { ActionButton } from "./components/ActionButton";
import { useCollections } from "./utils/use-collection-membership";
import { CollectionSidebar } from "./components/media-view/CollectionSidebar";
import { LibrarySelector } from "./components/media-view/LibrarySelector";
import { MobileMediaSearch } from "./components/media-view/MobileMediaSearch";
import { PictureGrid } from "./components/media-view/PictureGrid";
import { SelectionBar } from "./components/media-view/SelectionBar";
import { UploadDropOverlay } from "./components/media-view/UploadDropOverlay";
import { StatusPanel } from "./components/StatusPanel";
import { Toast } from "./components/Toast";
import { Toolbar } from "./components/Toolbar";
import { setState, showMediaView, state } from "./utils/editor-store";
import { useCurrentLibrary } from "./utils/use-current-library";
import { useEdgeSwipe } from "./utils/use-edge-swipe";
import { useKeybinds } from "./utils/use-keybinds";
import { useMediaViewModel } from "./utils/use-media-view-model";
import { useNavigationHistory } from "./utils/use-navigation-history";
import { checkWebGPU } from "./utils/webgpu-check";
import { Viewport } from "./components/Viewport";
import { Inspector } from "./components/Inspector";
import { useEditorActions } from "./utils/use-editor-actions";

const MediaLibraryView: Component<{
  selectedLibrary: ReturnType<typeof useCurrentLibrary>;
}> = (props) => {
  const collections = useCollections();
  const handleMediaEdgeSwipe = useEdgeSwipe({
    onSwipe: () => collections.setMobileSidebarOpen(true),
  });

  return (
    <section class="mobile-slider-fade outline-none relative transition-opacity duration-150 flex flex-1 flex-col overflow-hidden pt-0 touch-compact:pt-[calc(env(safe-area-inset-top)+3.5rem)]">
      <UploadDropOverlay />

      <div class="flex border-b border-[var(--border)] px-4 py-4 touch-mobile:px-4">
        <LibrarySelector />
      </div>

      <div class="relative flex-1 min-h-0 flex" onTouchStart={handleMediaEdgeSwipe}>
        <Show when={props.selectedLibrary()}>
          <CollectionSidebar />
        </Show>
        <div class="relative flex-1 min-h-0 flex flex-col">
          <PictureGrid />
        </div>
      </div>

      <div class="flex flex-col gap-2 border-t border-[var(--border)] px-4 touch-mobile:hidden lg:px-6">
        <SelectionBar />
      </div>

      <Show when={props.selectedLibrary()}>
        <MobileMediaSearch />
      </Show>
    </section>
  );
};

const EditorMediaStrip: Component = () => (
  <section class="mobile-slider-fade outline-none relative transition-opacity duration-150 flex w-[112px] shrink-0 flex-col border-r border-[var(--border)] bg-[var(--panel-bg)] touch-compact:hidden">
    <div class="px-2 pt-2 pb-1 w-full flex">
      <ActionButton
        class="w-full"
        label="Back"
        icon={backSvg}
        onClick={() => showMediaView()}
      />
    </div>

    <div class="relative flex-1 min-h-0 flex">
      <div class="relative flex-1 min-h-0 flex flex-col">
        <PictureGrid />
      </div>
    </div>
  </section>
);

const App: Component = () => {
  useMediaViewModel();
  const selectedLibrary = useCurrentLibrary();

  useNavigationHistory();
  useKeybinds();
  useEditorActions();

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
        <Show
          when={state.currentView === "editor"}
          fallback={<MediaLibraryView selectedLibrary={selectedLibrary} />}
        >
          <EditorMediaStrip />
        </Show>

        <Show when={state.currentView === "editor"}>
          <div class="flex min-h-0 flex-1 flex-row touch-compact:flex-col">
            <Viewport />
            <Inspector />
          </div>
        </Show>
      </div>
      <StatusPanel />
      <Toast />
    </div>
  );
};

export default App;
