import { onCleanup, onMount } from "solid-js";
import { targetAcceptsTextInput } from "../components/media-view/media-utils";
import actionShortcuts from "../keybinds.json";
import { type ActionShortcutMap, actions, buildActionContext } from "../store/actions";

let actionShortcutsLoaded = false;

export function useKeybinds() {
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
}