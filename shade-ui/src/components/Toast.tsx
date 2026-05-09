import { Show } from "solid-js";
import { Portal } from "solid-js/web";
import { toastMessage } from "../store/toast";

export function Toast() {
  return (
    <Portal>
      <div class="pointer-events-none fixed inset-x-0 top-4 z-[9999] flex justify-center">
        <Show when={toastMessage()}>
          {(message) => (
            <div class="rounded-lg bg-[var(--panel-bg)] px-4 py-2 text-sm font-medium text-[var(--text)] shadow-[0_8px_24px_rgba(0,0,0,0.2),inset_0_0_0_1px_var(--border-medium)]">
              {message()}
            </div>
          )}
        </Show>
      </div>
    </Portal>
  );
}
