import { type Component, createMemo, For, onMount, Show } from "solid-js";
import { Slider } from "./Slider";
import {
  addFont,
  pruneUnusedFonts,
  refreshFontList,
  setTextTransform,
  state,
  updateTextContent,
  updateTextStyle,
} from "../store/editor";
import type { LayerInfo } from "../store/editor";
import type {
  FontInfo,
  TextAlignName,
  TextStyleValues,
} from "../bridge";

const ALIGN_OPTIONS: { value: TextAlignName; label: string }[] = [
  { value: "left", label: "Left" },
  { value: "center", label: "Center" },
  { value: "right", label: "Right" },
  { value: "justify", label: "Justify" },
];

const FIELD_LABEL_CLASS =
  "text-[11px] font-medium uppercase tracking-wider text-[var(--text-dim)]";
const FIELD_INPUT_CLASS =
  "w-full rounded-sm border border-[var(--border-medium)] bg-[var(--bg-input,transparent)] px-2 py-1 text-sm text-[var(--text)] focus:outline-none focus:ring-1 focus:ring-[var(--accent)]";

/** sRGB → linear (used when reading from a color input). Per IEC 61966-2-1. */
function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/** Linear → sRGB for display in a color input. */
function linearToSrgb(c: number): number {
  return c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1.0 / 2.4) - 0.055;
}

/** `[r, g, b, a]` linear-sRGB → "#rrggbb" for `<input type="color">`. */
function colorArrayToHex(color: [number, number, number, number]): string {
  const r = Math.round(Math.max(0, Math.min(1, linearToSrgb(color[0]))) * 255);
  const g = Math.round(Math.max(0, Math.min(1, linearToSrgb(color[1]))) * 255);
  const b = Math.round(Math.max(0, Math.min(1, linearToSrgb(color[2]))) * 255);
  return `#${[r, g, b].map((n) => n.toString(16).padStart(2, "0")).join("")}`;
}

/** "#rrggbb" → `[r, g, b, a]` linear sRGB; existing alpha is preserved. */
function hexToColorArray(
  hex: string,
  alpha: number,
): [number, number, number, number] {
  const m = /^#([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return [1, 1, 1, alpha];
  const r = parseInt(m[1].substring(0, 2), 16) / 255;
  const g = parseInt(m[1].substring(2, 4), 16) / 255;
  const b = parseInt(m[1].substring(4, 6), 16) / 255;
  return [srgbToLinear(r), srgbToLinear(g), srgbToLinear(b), alpha];
}

/** Best-effort family name from a font filename — the user can rename later. */
function deriveFamilyFromFilename(fileName: string): string {
  const stem = fileName.replace(/\.(ttf|otf|ttc|woff2?|eot)$/i, "");
  return stem.replace(/[-_](Regular|Bold|Italic|Light|Medium|Thin|Black)$/i, "");
}

export const TextLayerEditor: Component<{
  layer: LayerInfo;
  layerIdx: number;
}> = (props) => {
  // Defensive default — text-layer editing should only render when LayerInfo
  // carries a text payload, but the inspector's parent gates on layer.kind.
  const text = createMemo(() => props.layer.text ?? null);
  const style = createMemo<TextStyleValues | null>(() => text()?.style ?? null);

  const fonts = createMemo<FontInfo[]>(() => state.fonts);

  const onContentInput = (event: InputEvent) => {
    const target = event.currentTarget as HTMLTextAreaElement;
    void updateTextContent(props.layerIdx, target.value);
  };

  const onFontPick = (event: Event) => {
    const target = event.currentTarget as HTMLSelectElement;
    const value = Number(target.value);
    if (!Number.isFinite(value)) return;
    void updateTextStyle(props.layerIdx, { font_id: value });
  };

  const onAlignPick = (value: TextAlignName) => {
    void updateTextStyle(props.layerIdx, { align: value });
  };

  const onColorInput = (event: Event) => {
    const target = event.currentTarget as HTMLInputElement;
    const current = style()?.color ?? [1, 1, 1, 1];
    const next = hexToColorArray(target.value, current[3]);
    void updateTextStyle(props.layerIdx, { color: next });
  };

  const onItalicToggle = (event: Event) => {
    const target = event.currentTarget as HTMLInputElement;
    void updateTextStyle(props.layerIdx, { italic: target.checked });
  };

  const onWeightInput = (event: Event) => {
    const target = event.currentTarget as HTMLSelectElement;
    const value = Number(target.value);
    if (!Number.isFinite(value)) return;
    void updateTextStyle(props.layerIdx, { weight: value });
  };

  const onMaxWidthInput = (event: Event) => {
    const target = event.currentTarget as HTMLInputElement;
    const raw = target.value.trim();
    if (raw === "") {
      void updateTextStyle(props.layerIdx, { max_width: null });
      return;
    }
    const value = Number(raw);
    if (!Number.isFinite(value) || value <= 0) return;
    void updateTextStyle(props.layerIdx, { max_width: value });
  };

  const onAddFont = async (event: Event) => {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    const bytes = new Uint8Array(await file.arrayBuffer());
    const family = deriveFamilyFromFilename(file.name);
    const fontId = await addFont(family, bytes);
    // Auto-select the new font on the active layer.
    void updateTextStyle(props.layerIdx, { font_id: fontId });
    // Reset the input so picking the same file twice still fires `change`.
    input.value = "";
  };

  onMount(() => {
    void refreshFontList();
  });

  return (
    <div class="flex flex-col gap-3 px-3 py-2">
      <Show when={text()}>
        {(t) => (
          <>
            <div class="flex flex-col gap-1">
              <span class={FIELD_LABEL_CLASS}>Content</span>
              <textarea
                class={`${FIELD_INPUT_CLASS} min-h-16 resize-y font-mono text-[13px]`}
                value={t().content}
                onInput={onContentInput}
                spellcheck={false}
                placeholder="Type something…"
              />
            </div>

            <div class="flex flex-col gap-1">
              <div class="flex items-baseline justify-between gap-2">
                <span class={FIELD_LABEL_CLASS}>Font</span>
                <label class="cursor-pointer text-[11px] text-[var(--accent)] hover:underline">
                  + Upload
                  <input
                    type="file"
                    accept=".ttf,.otf,.ttc"
                    class="hidden"
                    onChange={(e) => void onAddFont(e)}
                  />
                </label>
              </div>
              <select
                class={FIELD_INPUT_CLASS}
                value={String(style()?.font_id ?? "")}
                onChange={onFontPick}
              >
                <Show
                  when={fonts().length > 0}
                  fallback={<option value="">No fonts uploaded</option>}
                >
                  <For each={fonts()}>
                    {(f) => (
                      <option value={String(f.font_id)}>
                        {f.family} (#{f.font_id})
                      </option>
                    )}
                  </For>
                </Show>
              </select>
              <Show when={fonts().length > 0}>
                <button
                  type="button"
                  class="self-start text-[11px] text-[var(--text-dim)] hover:text-[var(--text)]"
                  onClick={() => void pruneUnusedFonts()}
                >
                  Prune unused fonts
                </button>
              </Show>
            </div>

            <Slider
              label="Size"
              value={t().style.size_px}
              defaultValue={32}
              min={4}
              max={256}
              step={1}
              valueLabel={`${Math.round(t().style.size_px)} px`}
              onChange={(v) =>
                void updateTextStyle(props.layerIdx, { size_px: v })
              }
            />

            <Slider
              label="Line height"
              value={t().style.line_height}
              defaultValue={1.2}
              min={0.5}
              max={3}
              step={0.05}
              onChange={(v) =>
                void updateTextStyle(props.layerIdx, { line_height: v })
              }
            />

            <Slider
              label="Letter spacing"
              value={t().style.letter_spacing}
              defaultValue={0}
              min={-10}
              max={40}
              step={0.5}
              onChange={(v) =>
                void updateTextStyle(props.layerIdx, { letter_spacing: v })
              }
            />

            <div class="flex flex-col gap-1">
              <span class={FIELD_LABEL_CLASS}>Color</span>
              <input
                type="color"
                class="h-8 w-full cursor-pointer rounded-sm border border-[var(--border-medium)] bg-transparent"
                value={colorArrayToHex(t().style.color)}
                onInput={onColorInput}
              />
            </div>

            <div class="flex flex-col gap-1">
              <span class={FIELD_LABEL_CLASS}>Weight</span>
              <select
                class={FIELD_INPUT_CLASS}
                value={String(t().style.weight)}
                onChange={onWeightInput}
              >
                <For
                  each={[100, 200, 300, 400, 500, 600, 700, 800, 900]}
                >
                  {(w) => <option value={String(w)}>{w}</option>}
                </For>
              </select>
            </div>

            <label class="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={t().style.italic}
                onChange={onItalicToggle}
              />
              <span>Italic</span>
            </label>

            <div class="flex flex-col gap-1">
              <span class={FIELD_LABEL_CLASS}>Align</span>
              <div class="grid grid-cols-4 gap-1">
                <For each={ALIGN_OPTIONS}>
                  {(opt) => (
                    <button
                      type="button"
                      class={`rounded-sm border px-2 py-1 text-[11px] capitalize transition-colors ${
                        t().style.align === opt.value
                          ? "border-[var(--accent)] bg-[var(--accent)] text-white"
                          : "border-[var(--border-medium)] text-[var(--text)] hover:border-[var(--accent)]"
                      }`}
                      onClick={() => onAlignPick(opt.value)}
                    >
                      {opt.label}
                    </button>
                  )}
                </For>
              </div>
            </div>

            <div class="flex flex-col gap-1">
              <span class={FIELD_LABEL_CLASS}>Max width (px)</span>
              <input
                type="number"
                min="0"
                step="1"
                placeholder="No wrap"
                class={FIELD_INPUT_CLASS}
                value={t().style.max_width ?? ""}
                onInput={onMaxWidthInput}
              />
            </div>

            <div class="flex flex-col gap-1">
              <span class={FIELD_LABEL_CLASS}>Position (canvas px)</span>
              <div class="grid grid-cols-2 gap-2">
                <label class="flex flex-col gap-0.5 text-[11px] text-[var(--text-dim)]">
                  X
                  <input
                    type="number"
                    step="1"
                    class={FIELD_INPUT_CLASS}
                    value={t().transform.tx}
                    onInput={(e) => {
                      const value = Number(
                        (e.currentTarget as HTMLInputElement).value,
                      );
                      if (!Number.isFinite(value)) return;
                      void setTextTransform(props.layerIdx, {
                        ...t().transform,
                        tx: value,
                      });
                    }}
                  />
                </label>
                <label class="flex flex-col gap-0.5 text-[11px] text-[var(--text-dim)]">
                  Y
                  <input
                    type="number"
                    step="1"
                    class={FIELD_INPUT_CLASS}
                    value={t().transform.ty}
                    onInput={(e) => {
                      const value = Number(
                        (e.currentTarget as HTMLInputElement).value,
                      );
                      if (!Number.isFinite(value)) return;
                      void setTextTransform(props.layerIdx, {
                        ...t().transform,
                        ty: value,
                      });
                    }}
                  />
                </label>
              </div>
            </div>
          </>
        )}
      </Show>
    </div>
  );
};
