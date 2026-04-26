import type { Component, JSX } from "solid-js";
import { Button } from "./Button";

const TOOLBAR_BUTTON_BASE_CLASS =
  "inline-flex h-7 items-center gap-2 rounded-md px-3 text-[11px] font-semibold uppercase tracking-[0.03em] transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--border-active)] disabled:opacity-45";
const TOOLBAR_BUTTON_PRIMARY_CLASS =
  "border-[var(--btn-primary-bg)] bg-[var(--btn-primary-bg)] text-[var(--btn-primary-text)] enabled:hover:bg-[var(--btn-primary-hover)]";
const TOOLBAR_BUTTON_SECONDARY_CLASS =
  "text-[var(--text-secondary)] enabled:hover:border-[var(--border-active)] enabled:hover:bg-[var(--surface-hover)] enabled:hover:text-[var(--text)]";

export const ActionButton: Component<{
  label: string;
  class: string;
  icon: JSX.Element;
  onClick?: () => void;
  disabled?: boolean;
  primary?: boolean;
}> = (props) => (
  <Button
    type="button"
    onClick={props.onClick}
    disabled={props.disabled}
    class={`${props.class} ${TOOLBAR_BUTTON_BASE_CLASS} ${
      props.primary
        ? TOOLBAR_BUTTON_PRIMARY_CLASS
        : TOOLBAR_BUTTON_SECONDARY_CLASS
    }`}
  >
    <span class="inline-flex items-center justify-center">{props.icon}</span>
    <span class="hidden sm:inline">{props.label}</span>
  </Button>
);