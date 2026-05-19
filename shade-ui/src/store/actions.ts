import { state } from "./editor-store";
import {
  mediaViewFocusedItemId,
  mediaViewSelectedItemIds,
  mediaViewSelectedLibraryId,
} from "./media-view-context";

export interface ActionContext {
  currentView: "media" | "editor";
  mediaViewFocusedItemId: string | null;
  mediaViewSelectedItemIds: string[];
  selectedLibraryId: string | null;
  hasImage: boolean;
  selectedLayerIdx: number;
  selectedLayerPart: "layer" | "mask";
  isCropMode: boolean;
}

export type ActionWhen = (ctx: ActionContext) => boolean;

export interface ActionDef {
  id: string;
  title: string;
  description?: string;
  group?: string;
  when?: ActionWhen;
  run: (ctx: ActionContext) => Promise<void> | void;
}

export type ActionShortcutMap = Record<string, string | string[]>;

export class ActionsRegistry {
  private actions = new Map<string, ActionDef>();
  private shortcuts = new Map<string, string>();
  private history: string[] = [];

  register(def: ActionDef): void {
    this.actions.set(def.id, def);
  }

  unregister(id: string): void {
    this.actions.delete(id);
  }

  get(id: string): ActionDef | undefined {
    return this.actions.get(id);
  }

  entries(): IterableIterator<[string, ActionDef]> {
    return this.actions.entries();
  }

  available(ctx: ActionContext): ActionDef[] {
    const result: ActionDef[] = [];
    for (const [, action] of this.actions) {
      if (!action.when || action.when(ctx)) {
        result.push(action);
      }
    }
    return result;
  }

  run(id: string, ctx: ActionContext): void {
    const action = this.actions.get(id);
    if (!action) {
      throw new Error(`Action '${id}' not found`);
    }
    const result = action.run(ctx);
    this.history.unshift(id);
    if (result && typeof result.then === "function") {
      result.catch((err: unknown) => {
        console.error(`Action '${id}' failed:`, err);
      });
    }
  }

  mapShortcut(shortcut: string, actionId: string): void {
    this.shortcuts.set(shortcut.toLowerCase(), actionId);
  }

  loadShortcuts(bindings: ActionShortcutMap): void {
    for (const [actionId, shortcuts] of Object.entries(bindings)) {
      const list = Array.isArray(shortcuts) ? shortcuts : [shortcuts];
      for (const shortcut of list) {
        this.mapShortcut(shortcut, actionId);
      }
    }
  }

  unmapShortcut(shortcut: string): void {
    this.shortcuts.delete(shortcut.toLowerCase());
  }

  private normalizeShortcut(event: KeyboardEvent): string {
    const parts: string[] = [];
    if (event.ctrlKey || event.metaKey) {
      parts.push("mod");
    }
    if (event.shiftKey) {
      parts.push("shift");
    }
    if (event.altKey) {
      parts.push("alt");
    }
    parts.push(event.key.toLowerCase());
    return parts.join("+");
  }

  handleKey(event: KeyboardEvent, ctx: ActionContext): boolean {
    const shortcut = this.normalizeShortcut(event);
    const actionId = this.shortcuts.get(shortcut);
    if (!actionId) {
      return false;
    }
    const action = this.actions.get(actionId);
    if (!action) {
      return false;
    }
    if (action.when && !action.when(ctx)) {
      return false;
    }
    event.preventDefault();
    this.run(actionId, ctx);
    return true;
  }

  getHistory(): string[] {
    return [...this.history];
  }

  rank(id: string, search: string): number {
    const action = this.actions.get(id);
    if (!action) {
      return 0;
    }
    const s = search.toLowerCase();
    if (action.title.toLowerCase().includes(s)) {
      return 2;
    }
    if (action.description?.toLowerCase().includes(s)) {
      return 1;
    }
    return 0;
  }
}

export const actions = new ActionsRegistry();

export function buildActionContext(): ActionContext {
  return {
    currentView: state.currentView,
    mediaViewFocusedItemId: mediaViewFocusedItemId(),
    mediaViewSelectedItemIds: mediaViewSelectedItemIds(),
    selectedLibraryId: mediaViewSelectedLibraryId(),
    hasImage: state.canvasWidth > 0 || state.isLoading,
    selectedLayerIdx: state.selectedLayerIdx,
    selectedLayerPart: state.selectedLayerPart,
    isCropMode: state.isCropMode,
  };
}
