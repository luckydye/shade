import { Component, For, Show } from "solid-js";

type MediaRatingProps = {
  rating: number | null;
  readOnly?: boolean;
  pending?: boolean;
  onChange?: (rating: number | null) => void;
  class?: string;
};

export const MediaRating: Component<MediaRatingProps> = (props) => {
  return (
    <div
      class={`flex items-center gap-0.5 ${props.class ?? ""}`}
    >
      <For each={[1, 2, 3, 4, 5]}>
        {(value) => {
          const active = () => (props.rating ?? 0) >= value;
          return (
            <button
              type="button"
              class={`text-sm leading-none transition-colors ${
                props.readOnly
                  ? active()
                    ? "cursor-default text-amber-300"
                    : "cursor-default text-white/25"
                  : props.pending
                    ? "cursor-wait text-white/30"
                    : active()
                      ? "text-amber-300 hover:text-amber-200"
                      : "text-white/35 hover:text-white/60"
              }`}
              disabled={props.readOnly || props.pending}
              aria-label={`${value} star${value === 1 ? "" : "s"}`}
              title={
                props.readOnly
                  ? `${props.rating ?? 0} star rating`
                  : props.rating === value
                    ? `Clear ${value} star rating`
                    : `Set ${value} star rating`
              }
              onClick={() =>
                props.onChange?.(props.rating === value ? null : value)
              }
            >
              {active() ? "★" : "☆"}
            </button>
          );
        }}
      </For>
      <Show when={props.pending}>
        <span class="ml-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-white/45">
          Saving
        </span>
      </Show>
    </div>
  );
};
