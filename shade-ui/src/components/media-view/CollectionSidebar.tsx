import type { Component } from "solid-js";
import { createSignal, For, Show } from "solid-js";
import type { Collection } from "../../bridge/index";
import { Button } from "../Button";

function formatCount(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

const SIDEBAR_ITEM_BASE =
  "flex w-full items-center justify-between gap-1 rounded-md px-2 py-1 text-left text-[12px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--border-active)]";
const SIDEBAR_ITEM_ACTIVE =
  "bg-[var(--surface-active)] text-[var(--text)]";
const SIDEBAR_ITEM_INACTIVE =
  "text-[var(--text-muted)] hover:bg-[var(--surface-hover)] hover:text-[var(--text)]";

export type CollectionSidebarProps = {
  collections: Collection[];
  selectedCollectionId: string | null;
  totalCount: number;
  onSelect: (id: string | null) => void;
  onCreate: () => void;
  onRename: (id: string, name: string) => void;
  onDelete: (id: string) => void;
  mobileOpen?: boolean;
  onMobileClose?: () => void;
};

export const CollectionSidebar: Component<CollectionSidebarProps> = (props) => {
  const [contextMenuId, setContextMenuId] = createSignal<string | null>(null);
  const [contextMenuPos, setContextMenuPos] = createSignal({ x: 0, y: 0 });
  const [renamingId, setRenamingId] = createSignal<string | null>(null);
  let renameInputRef: HTMLInputElement | undefined;

  function handleContextMenu(event: MouseEvent, id: string) {
    event.preventDefault();
    setContextMenuId(id);
    setContextMenuPos({ x: event.clientX, y: event.clientY });
  }

  function closeContextMenu() {
    setContextMenuId(null);
  }

  function startRename(id: string) {
    closeContextMenu();
    setRenamingId(id);
    requestAnimationFrame(() => {
      renameInputRef?.select();
    });
  }

  function commitRename(id: string, value: string) {
    const trimmed = value.trim();
    if (trimmed) {
      props.onRename(id, trimmed);
    }
    setRenamingId(null);
  }

  return (
    <>
      {/* Mobile backdrop */}
      <Show when={props.mobileOpen}>
        <div
          class="fixed inset-0 z-30 hidden touch-mobile:block bg-black/40"
          onClick={() => props.onMobileClose?.()}
        />
      </Show>
    <div
      class={`flex w-[180px] shrink-0 flex-col border-r border-[var(--border)] py-6 pl-4 touch-mobile:fixed touch-mobile:inset-y-0 touch-mobile:left-0 touch-mobile:z-40 touch-mobile:bg-[var(--panel-bg)] touch-mobile:shadow-xl touch-mobile:transition-transform touch-mobile:duration-300 ${
        props.mobileOpen ? "touch-mobile:translate-x-0" : "touch-mobile:-translate-x-full"
      }`}
    >
      <div class="flex-1 overflow-y-auto pr-2 space-y-1">
        <Button
          type="button"
          class={`${SIDEBAR_ITEM_BASE} ${
            props.selectedCollectionId === null ? SIDEBAR_ITEM_ACTIVE : SIDEBAR_ITEM_INACTIVE
          }`}
          onClick={() => props.onSelect(null)}
        >
          All Photos
          <span class="shrink-0 text-[10px] text-[var(--text-faint)]">
            {formatCount(props.totalCount)}
          </span>
        </Button>

        <For each={props.collections}>
          {(collection) => (
            <Show
              when={renamingId() !== collection.id}
              fallback={
                <input
                  ref={renameInputRef}
                  type="text"
                  class="my-0.5 h-7 w-full rounded-md border border-[var(--border-active)] bg-[var(--input-bg)] px-2 text-[12px] font-medium text-[var(--text)] outline-none"
                  value={collection.name}
                  onBlur={(e) => commitRename(collection.id, e.currentTarget.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      commitRename(collection.id, e.currentTarget.value);
                    } else if (e.key === "Escape") {
                      setRenamingId(null);
                    }
                  }}
                />
              }
            >
              <Button
                type="button"
                class={`${SIDEBAR_ITEM_BASE} ${
                  props.selectedCollectionId === collection.id
                    ? SIDEBAR_ITEM_ACTIVE
                    : SIDEBAR_ITEM_INACTIVE
                }`}
                onClick={() => props.onSelect(collection.id)}
                onDblClick={() => startRename(collection.id)}
                onContextMenu={(e: MouseEvent) => handleContextMenu(e, collection.id)}
              >
                <span class="flex min-w-0 items-center gap-1.5 truncate">
                  <svg class="shrink-0 opacity-50" width="11" height="11" viewBox="0 0 12 12" fill="none" xmlns="http://www.w3.org/2000/svg">
                    <rect x="0.5" y="2.5" width="11" height="9" rx="1.5" stroke="currentColor"/>
                    <path d="M0.5 5.5H11.5" stroke="currentColor" stroke-width="0.75"/>
                    <path d="M3 2.5V1.5C3 1 3.5 0.5 4 0.5H8C8.5 0.5 9 1 9 1.5V2.5" stroke="currentColor" stroke-width="0.75"/>
                  </svg>
                  {collection.name}
                </span>
                <span class="shrink-0 text-[10px] text-[var(--text-faint)]">
                  {collection.item_count}
                </span>
              </Button>
            </Show>
          )}
        </For>
      </div>

      <div class="px-1.5 pt-1">
        <Button
          type="button"
          class={`${SIDEBAR_ITEM_BASE} ${SIDEBAR_ITEM_INACTIVE}`}
          onClick={() => props.onCreate()}
        >
          + New Collection
        </Button>
      </div>

      <Show when={contextMenuId()}>
        {(menuId) => {
          function onClickOutside(e: MouseEvent) {
            if (!(e.target as HTMLElement)?.closest("[data-collection-menu]")) {
              closeContextMenu();
            }
          }
          document.addEventListener("click", onClickOutside, { once: true });

          return (
            <div
              data-collection-menu
              class="fixed z-50 min-w-[120px] rounded-lg border border-[var(--border-medium)] bg-[var(--panel-bg)] py-1 shadow-[0_8px_24px_rgba(0,0,0,0.2)]"
              style={{ left: `${contextMenuPos().x}px`, top: `${contextMenuPos().y}px` }}
            >
              <button
                type="button"
                class="flex h-7 w-full items-center px-3 text-left text-[11px] font-semibold uppercase tracking-[0.03em] text-[var(--text-muted)] hover:bg-[var(--surface-hover)] hover:text-[var(--text)]"
                onClick={() => startRename(menuId())}
              >
                Rename
              </button>
              <button
                type="button"
                class="flex h-7 w-full items-center px-3 text-left text-[11px] font-semibold uppercase tracking-[0.03em] text-[var(--danger-text)] hover:bg-[var(--surface-hover)] hover:text-[var(--danger-hover-text)]"
                onClick={() => {
                  closeContextMenu();
                  props.onDelete(menuId());
                }}
              >
                Delete
              </button>
            </div>
          );
        }}
      </Show>
    </div>
    </>
  );
};
