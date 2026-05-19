import type { Component } from "solid-js";
import { For, Show } from "solid-js";
import type { Collection, PresetInfo } from "../../types";
import { Button } from "../Button";

export type SelectionBarProps = {
  selectedCount: number;
  isSubmitting: boolean;
  canWriteSelectedLibrary: boolean;
  selectedCollectionId: string | null;
  presets: PresetInfo[];
  showApplyPresetMenu: boolean;
  showAddToCollectionMenu: boolean;
  collections: Collection[];
  onOpenSelected: () => void;
  onExportSelected: () => void;
  onToggleApplyPresetMenu: () => void;
  onApplyPreset: (name: string) => void;
  onClearEdits: () => void;
  onToggleAddToCollectionMenu: () => void;
  onAddToCollection: (collectionId: string) => void;
  onCreateAndAddToCollection: () => void;
  onRemoveFromCollection: () => void;
  onDeleteSelected: () => void;
  onClearSelection: () => void;
};

const buttonClass =
  "h-8 rounded-md border border-[var(--border-medium)] bg-[var(--surface)] px-3 text-[11px] font-semibold uppercase tracking-[0.03em] text-[var(--text-muted)] transition-colors hover:border-[var(--border-active)] hover:bg-[var(--surface-hover)] hover:text-[var(--text)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--border-active)] disabled:opacity-40";

const dangerButtonClass =
  "h-8 rounded-md border border-[var(--danger-border)] bg-transparent px-3 text-[11px] font-semibold uppercase tracking-[0.03em] text-[var(--danger-text)] transition-colors hover:border-[var(--danger-hover-border)] hover:text-[var(--danger-hover-text)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--danger-hover-border)] disabled:opacity-40";

export const SelectionBar: Component<SelectionBarProps> = (props) => (
  <Show when={props.selectedCount > 0}>
    <div class="flex items-center justify-between gap-2 py-3">
      <p class="text-[11px] font-medium text-[var(--text-dim)]">
        {props.selectedCount} selected
      </p>
      <div class="flex items-center gap-2">
        <Button type="button" class={buttonClass} onClick={props.onOpenSelected}>
          Open Selected
        </Button>
        <Button
          type="button"
          class={buttonClass}
          disabled={props.isSubmitting}
          onClick={props.onExportSelected}
        >
          Export Selected
        </Button>
        <div class="relative">
          <Button
            type="button"
            class={buttonClass}
            disabled={props.isSubmitting || props.selectedCount === 0}
            onClick={props.onToggleApplyPresetMenu}
          >
            Apply Preset
          </Button>
          <Show when={props.showApplyPresetMenu}>
            <div class="absolute bottom-full right-0 mb-1 min-w-[180px] rounded-lg border border-[var(--border-medium)] bg-[var(--panel-bg)] py-1 shadow-[0_8px_24px_rgba(0,0,0,0.2)]">
              <Show
                when={props.presets.length > 0}
                fallback={
                  <div class="px-3 py-2 text-[11px] font-medium text-[var(--text-faint)]">
                    No presets saved
                  </div>
                }
              >
                <For each={props.presets}>
                  {(preset) => (
                    <button
                      type="button"
                      class="flex h-7 w-full items-center px-3 text-left text-[11px] font-semibold uppercase tracking-[0.03em] text-[var(--text-muted)] hover:bg-[var(--surface-hover)] hover:text-[var(--text)] disabled:opacity-40"
                      disabled={props.isSubmitting}
                      onClick={() => props.onApplyPreset(preset.name)}
                    >
                      {preset.name}
                    </button>
                  )}
                </For>
                <button
                  type="button"
                  class="flex h-7 w-full items-center border-t border-[var(--border)] px-3 text-left text-[11px] font-semibold uppercase tracking-[0.03em] text-[var(--danger-text)] hover:bg-[var(--surface-hover)] disabled:opacity-40"
                  disabled={props.isSubmitting}
                  onClick={props.onClearEdits}
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
            onClick={props.onToggleAddToCollectionMenu}
          >
            Add to Collection
          </Button>
          <Show when={props.showAddToCollectionMenu}>
            <div class="absolute bottom-full right-0 mb-1 min-w-[160px] rounded-lg border border-[var(--border-medium)] bg-[var(--panel-bg)] py-1 shadow-[0_8px_24px_rgba(0,0,0,0.2)]">
              <For each={props.collections}>
                {(col) => (
                  <button
                    type="button"
                    class="flex h-7 w-full items-center px-3 text-left text-[11px] font-semibold uppercase tracking-[0.03em] text-[var(--text-muted)] hover:bg-[var(--surface-hover)] hover:text-[var(--text)]"
                    onClick={() => props.onAddToCollection(col.id)}
                  >
                    {col.name}
                  </button>
                )}
              </For>
              <button
                type="button"
                class="flex h-7 w-full items-center border-t border-[var(--border)] px-3 text-left text-[11px] font-semibold uppercase tracking-[0.03em] text-[var(--text-muted)] hover:bg-[var(--surface-hover)] hover:text-[var(--text)]"
                onClick={props.onCreateAndAddToCollection}
              >
                + New Collection
              </button>
            </div>
          </Show>
        </div>
        <Show when={props.selectedCollectionId}>
          <Button
            type="button"
            class={dangerButtonClass}
            onClick={props.onRemoveFromCollection}
          >
            Remove from Collection
          </Button>
        </Show>
        <Show when={props.canWriteSelectedLibrary}>
          <Button
            type="button"
            class={dangerButtonClass}
            disabled={props.isSubmitting}
            onClick={props.onDeleteSelected}
          >
            Delete Selected
          </Button>
        </Show>
        <Button type="button" class={buttonClass} onClick={props.onClearSelection}>
          Clear
        </Button>
      </div>
    </div>
  </Show>
);
