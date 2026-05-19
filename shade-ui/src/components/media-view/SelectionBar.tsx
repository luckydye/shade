import type { Component } from "solid-js";
import { For, Show } from "solid-js";
import { useMediaItemActions } from "../../utils/use-media-item-actions";
import { Button } from "../Button";
import { useCollectionMembershipStore } from "./collection-membership-store";
import { useMediaViewStore } from "./media-view-store";

const buttonClass =
  "h-8 rounded-md border border-[var(--border-medium)] bg-[var(--surface)] px-3 text-[11px] font-semibold uppercase tracking-[0.03em] text-[var(--text-muted)] transition-colors hover:border-[var(--border-active)] hover:bg-[var(--surface-hover)] hover:text-[var(--text)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--border-active)] disabled:opacity-40";

const dangerButtonClass =
  "h-8 rounded-md border border-[var(--danger-border)] bg-transparent px-3 text-[11px] font-semibold uppercase tracking-[0.03em] text-[var(--danger-text)] transition-colors hover:border-[var(--danger-hover-border)] hover:text-[var(--danger-hover-text)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--danger-hover-border)] disabled:opacity-40";

export const SelectionBar: Component = () => {
  const store = useMediaViewStore();
  const collections = useCollectionMembershipStore();
  const itemActions = useMediaItemActions();
  const selectedCount = () => store.selectedMediaItemIds().length;
  const presets = () => store.presets() ?? [];
  const selectedCollectionFileHashes = () =>
    store.selectedMediaItemIds().map((itemId) => {
      const item = store.itemsById().get(itemId);
      if (!item) {
        throw new Error(`selected media item not found: ${itemId}`);
      }
      if (item.kind !== "local") {
        throw new Error(`collection item is not local: ${itemId}`);
      }
      return item.fingerprint ?? item.path;
    });
  const clearSelection = () => {
    store.setSelectedMediaItemIds([]);
    store.setShowApplyPresetMenu(false);
    store.setMediaActionStatus(null);
  };

  return (
    <Show when={selectedCount() > 0}>
      <div class="flex items-center justify-between gap-2 py-3">
        <p class="text-[11px] font-medium text-[var(--text-dim)]">
          {selectedCount()} selected
        </p>
        <div class="flex items-center gap-2">
          <Button
            type="button"
            class={buttonClass}
            onClick={() => void itemActions.handleOpenSelectedItems()}
          >
            Open Selected
          </Button>
          <Button
            type="button"
            class={buttonClass}
            disabled={store.isSubmitting()}
            onClick={() => void itemActions.handleExportSelected()}
          >
            Export Selected
          </Button>
          <div class="relative">
            <Button
              type="button"
              class={buttonClass}
              disabled={store.isSubmitting() || selectedCount() === 0}
              onClick={() => {
                store.setShowApplyPresetMenu(!store.showApplyPresetMenu());
                if (!store.presets()) {
                  void store.refetchPresets();
                }
              }}
            >
              Apply Preset
            </Button>
            <Show when={store.showApplyPresetMenu()}>
              <div class="absolute bottom-full right-0 mb-1 min-w-[180px] rounded-lg border border-[var(--border-medium)] bg-[var(--panel-bg)] py-1 shadow-[0_8px_24px_rgba(0,0,0,0.2)]">
                <Show
                  when={presets().length > 0}
                  fallback={
                    <div class="px-3 py-2 text-[11px] font-medium text-[var(--text-faint)]">
                      No presets saved
                    </div>
                  }
                >
                  <For each={presets()}>
                    {(preset) => (
                      <button
                        type="button"
                        class="flex h-7 w-full items-center px-3 text-left text-[11px] font-semibold uppercase tracking-[0.03em] text-[var(--text-muted)] hover:bg-[var(--surface-hover)] hover:text-[var(--text)] disabled:opacity-40"
                        disabled={store.isSubmitting()}
                        onClick={() =>
                          void itemActions.handleApplyPresetToSelected(preset.name)
                        }
                      >
                        {preset.name}
                      </button>
                    )}
                  </For>
                  <button
                    type="button"
                    class="flex h-7 w-full items-center border-t border-[var(--border)] px-3 text-left text-[11px] font-semibold uppercase tracking-[0.03em] text-[var(--danger-text)] hover:bg-[var(--surface-hover)] disabled:opacity-40"
                    disabled={store.isSubmitting()}
                    onClick={() => void itemActions.handleClearEditsForSelected()}
                  >
                    Clear Edits
                  </button>
                </Show>
              </div>
            </Show>
          </div>
          <div class="relative">
            <Button
              type="button"
              class={buttonClass}
              onClick={() =>
                collections.setShowAddToCollectionMenu(
                  !collections.showAddToCollectionMenu(),
                )
              }
            >
              Add to Collection
            </Button>
            <Show when={collections.showAddToCollectionMenu()}>
              <div class="absolute bottom-full right-0 mb-1 min-w-[160px] rounded-lg border border-[var(--border-medium)] bg-[var(--panel-bg)] py-1 shadow-[0_8px_24px_rgba(0,0,0,0.2)]">
                <For each={collections.collections()}>
                  {(col) => (
                    <button
                      type="button"
                      class="flex h-7 w-full items-center px-3 text-left text-[11px] font-semibold uppercase tracking-[0.03em] text-[var(--text-muted)] hover:bg-[var(--surface-hover)] hover:text-[var(--text)]"
                      onClick={() =>
                        void collections.handleAddToCollection(
                          col.id,
                          selectedCollectionFileHashes(),
                        )
                      }
                    >
                      {col.name}
                    </button>
                  )}
                </For>
                <button
                  type="button"
                  class="flex h-7 w-full items-center border-t border-[var(--border)] px-3 text-left text-[11px] font-semibold uppercase tracking-[0.03em] text-[var(--text-muted)] hover:bg-[var(--surface-hover)] hover:text-[var(--text)]"
                  onClick={() =>
                    void collections.handleCreateAndAddToCollection(
                      selectedCollectionFileHashes(),
                    )
                  }
                >
                  + New Collection
                </button>
              </div>
            </Show>
          </div>
          <Show when={collections.selectedCollectionId()}>
            <Button
              type="button"
              class={dangerButtonClass}
              onClick={() =>
                void collections
                  .handleRemoveFromCollection(selectedCollectionFileHashes())
                  .then(() => store.setSelectedMediaItemIds([]))
              }
            >
              Remove from Collection
            </Button>
          </Show>
          <Show when={store.canWriteSelectedLibrary()}>
            <Button
              type="button"
              class={dangerButtonClass}
              disabled={store.isSubmitting()}
              onClick={() => void itemActions.handleDeleteSelectedItems()}
            >
              Delete Selected
            </Button>
          </Show>
          <Button type="button" class={buttonClass} onClick={clearSelection}>
            Clear
          </Button>
        </div>
      </div>
    </Show>
  );
};
