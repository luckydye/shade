import type { Component } from "solid-js";
import { useMediaViewStore } from "../../store/media-view-store";

export const MobileMediaSearch: Component = () => {
  const store = useMediaViewStore();

  return (
    <div class="fixed bottom-[env(safe-area-inset-bottom)] left-0 right-0 hidden w-auto px-2 pb-2 touch-mobile:block">
      <input
        type="text"
        value={store.filenameFilter()}
        onInput={(event) => store.setFilenameFilter(event.currentTarget.value)}
        class="h-8 w-full rounded-md border border-[var(--border)] bg-[var(--input-bg)] px-2 text-[13px] font-medium text-[var(--text)] outline-none transition-colors placeholder:text-[var(--text-dim)] focus-visible:ring-1 focus-visible:ring-[var(--border-active)] touch-mobile:h-10 touch-mobile:rounded-full touch-mobile:px-4 touch-mobile:text-base"
        placeholder="Search names or tags"
        aria-label="Search names or tags"
      />
    </div>
  );
};
