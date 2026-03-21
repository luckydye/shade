# Shade UI System

## Purpose

This document defines the default UI system for Shade.

The target is dense professional software that still feels legible to a first-time user. Density is allowed. Visual drift is not. Every new panel, list, toolbar, and inspector should align to the same spacing, columns, typography, and state rules unless there is a clear reason not to.

This version is tailored for the current `shade-ui` stack:

- Tailwind v4 for layout, spacing, sizing, and typography.
- CSS custom properties for semantic colors and surfaces.
- Utility composition in components, not one-off screen CSS.

## Core Principles

- Dense, not cramped. Save space with alignment and repetition, not by shrinking everything.
- Align before decorating. A strong grid does more work than extra borders or containers.
- Use a small number of visual levels. Most screens should rely on background, content, and active state only.
- One active signal at a time. Selection, focus, and manipulation should be obvious without adding noise everywhere else.
- Keep structure mechanical. Similar controls should share the same height, spacing, and columns.
- Calm the chrome first. When a screen feels busy, remove border emphasis before shrinking content.
- Selected states should be decisive. Active items should read immediately without requiring stronger borders everywhere else.
- Prefer Tailwind utilities for structure. Keep semantic color in tokens like `var(--panel-bg)` and `var(--text-strong)`.
- Avoid arbitrary values unless the system needs a size Tailwind does not express cleanly.

## Tailwind Rules

- Use utilities for spacing, layout, sizing, alignment, typography, and borders.
- Use CSS variables inside utilities for semantic color: `bg-[var(--panel-bg)]`, `text-[var(--text-strong)]`, `border-[var(--border)]`.
- Keep repeated patterns in shared class strings or small components instead of rewriting long utility chains.
- Prefer one stable utility recipe per pattern. Do not restyle the same concept slightly differently in each screen.
- Arbitrary values are allowed for system values that Tailwind does not name well, such as `h-[3px]`, `tracking-[0.03em]`, or a custom grid template.

## Layout Grid

- Use a `4px` base unit.
- Use `8px`, `12px`, `16px`, and `24px` as the default spacing steps.
- Default panel padding is `p-3`.
- Default gap between related controls is `gap-2`.
- Default gap between sections is `gap-3`.
- Use `gap-4` section gaps only when switching between clearly different groups.
- Avoid one-off offsets. If a value does not fit the system, the layout is probably wrong.

Preferred Tailwind mapping:

- `8px` -> `2`
- `12px` -> `3`
- `16px` -> `4`
- `24px` -> `6`
- `28px` -> `7`
- `32px` -> `8`
- `48px` -> `12`
- `56px` -> `14`

## Column System

Inspector-style panels should use a fixed row anatomy:

- `16px` affordance column for icons, disclosure markers, or drag handles.
- `1fr` content column for labels, fields, tracks, and previews.
- `48px` to `56px` value column for compact numeric output.

Rules:

- Labels always start on the same x-position.
- Numeric values always end on the same x-position.
- Use tabular numerals for all changing values.
- Slider tracks should share the same left and right edges across the panel.
- If a row does not need an icon, keep the column empty rather than shifting the label.
- Decorative icons should not compete with labels. If they are not required for meaning, fade them further than the main text.

Preferred row shell:

```tsx
<div class="grid grid-cols-[16px_minmax(0,1fr)_56px] items-center gap-2">
```

Rules for that grid:

- Put the icon or affordance in column `1`.
- Put the label or main content in column `2` with `min-w-0`.
- Put the value in column `3` with `text-right tabular-nums`.
- Put slider tracks or secondary controls on a second row using `col-start-2 col-end-4`.
- Keep the vertical gap between label row and slider track tight. Parameter controls should read as one unit, not two stacked rows.

## Control Sizes

- Parameter row height: `h-7` to `h-8`.
- Slider track row height should usually prefer the compact end of that range, such as `h-7`, unless touch interaction requires more room.
- Button height: `h-8` by default.
- Segmented control height: `h-8`.
- Small section header height: `h-5` to `h-6`.
- Minimum hit area for interactive targets: `min-h-7`.
- Curve editors, histograms, and other visual tools should not be shorter than `min-h-[120px]` when expanded.

## Typography

- Section labels: `text-[11px] font-semibold uppercase tracking-[0.03em]`.
- Row labels: `text-xs` to `text-[13px] font-medium`.
- Values: `text-xs font-medium tabular-nums`.
- Button labels: `text-[11px]` to `text-xs font-semibold`.
- Use size changes sparingly. Hierarchy should come mostly from weight, spacing, and contrast.

## Surface Rules

- Keep to three surface levels: app background, panel surface, active or selected surface.
- Do not stack boxes inside boxes unless the user needs to perceive a real container boundary.
- Prefer spacing and subtle tone shifts over borders.
- Borders should be quieter than text and quieter than active controls.
- In list-heavy panels, prefer inset rings or surface changes for selection over full heavy row borders.
- Expanded content may use a slightly stronger surface, but only one step above the panel.
- Extend existing semantic tokens before adding new screen-specific colors.

Preferred token usage:

- `bg-[var(--panel-bg)]`
- `bg-[var(--surface)]`
- `bg-[var(--surface-active)]`
- `border-[var(--border)]`
- `text-[var(--text-strong)]`
- `text-[var(--text-value)]`

## Color And State

- Use one accent color for active controls, selected tabs, focused points, and manipulated values.
- Inactive controls should rely on neutral tones, not weak versions of the accent.
- Text contrast must stay high enough that labels are readable without zooming or hunting.
- Decorative icons should be lower contrast than labels.
- Active values should increase contrast before they increase saturation.

State order:

- Default: readable, quiet.
- Hover: slightly brighter surface or text.
- Active: strongest contrast and accent.
- Disabled: clearly unavailable, never confused with default.

Practical rule:

- Unselected states should get quieter before selected states get louder. Reduce the noise floor first, then strengthen the active item.

## Pattern Rules

### Panel Structure

Use this order for inspector-like surfaces:

1. Context or object stack.
2. Mode switch.
3. Primary controls.
4. Advanced controls.
5. Destructive or secondary actions.

The current inspector should read as:

1. Layer or adjustment stack.
2. Edit or preset mode.
3. Light and color controls.
4. Curves and advanced tools.

Preferred panel shell:

```tsx
<aside class="flex h-full w-[280px] flex-col gap-3 border-l border-[var(--border)] bg-[var(--panel-bg)] p-3">
```

### Parameter Rows

Every parameter row should follow the same pattern:

- Left: affordance or category icon.
- Middle: label.
- Right: numeric value.
- Bottom or following row: control track or input field aligned to the shared columns.

Do not let each parameter invent its own geometry.

Second-pass refinement:

- Keep row stacks compact. If a parameter feels visually detached from its slider, reduce `gap-y` before reducing font size.
- Keep value text stable and easy to scan. Values should remain slightly quieter than labels, but never faint enough to disappear.
- If icons are decorative, use a lower contrast token such as `text-[var(--text-subtle)]` instead of `text-[var(--text-icon)]` or stronger.

Preferred row recipe:

```tsx
<div class="grid grid-cols-[16px_minmax(0,1fr)_56px] gap-x-2 gap-y-1">
  <span class="text-[var(--text-icon)]" />
  <span class="min-w-0 text-[13px] font-medium text-[var(--text-strong)]" />
  <span class="text-right text-xs font-medium tabular-nums text-[var(--text-value)]" />
  <div class="col-start-2 col-end-4 h-8" />
</div>
```

### Buttons And Tabs

- Primary actions should look primary through contrast, not size inflation.
- Secondary actions should be quieter but still fully readable.
- Segmented controls should have a clearly selected segment, not two nearly identical buttons.
- If two actions are not peers, do not style them as peers.

Preferred segmented control shell:

```tsx
<div class="grid h-8 grid-cols-2 rounded-lg bg-[var(--surface)] p-0.5">
```

Preferred segment states:

- Selected: `bg-[var(--surface-selected)] text-[var(--text)]`
- Selected may also use an inset ring or inner shadow to separate it from the track.
- Unselected: `text-[var(--text-faint)] hover:text-[var(--text-strong)]`

Second-pass refinement:

- Utility action blocks inside inspectors should stay slightly quieter than editing controls.
- If add buttons or setup actions compete with the main editing content, shorten them or flatten their surface treatment before reducing their text contrast.

### Lists

- List rows should use the same row height and left alignment as parameter rows.
- Reorder handles, visibility toggles, and delete actions must live in stable columns.
- Avoid mixing editing controls into list rows unless they are needed at scan speed.

Preferred list row shell:

```tsx
<div class="grid h-8 grid-cols-[16px_minmax(0,1fr)_16px_16px] items-center gap-2 rounded-md px-2">
```

Second-pass refinement:

- Keep list rows calmer than the controls below them. The list should establish context, not dominate the panel.
- Use subtle surface fills for default rows and reserve the strongest emphasis for the selected row.
- Separate trailing row actions from titles with spacing or a quiet divider when they start to read as part of the label.
- Avoid full-strength borders on every row. A quiet inset ring or low-contrast border is usually enough for default state.

## Accessibility Rules

- Body text and row labels should target normal text contrast, not decorative contrast.
- Do not communicate state with color alone.
- Numeric output must not jump horizontally as values change.
- Icons must support labels, not replace them.
- Keyboard focus must be obvious on every interactive element.
- Density must never reduce hit targets below the standard control height.

Tailwind focus rule:

- Every interactive control should have a visible focus style such as `focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--border-active)]`.

## Rework Checklist

Use this checklist when updating the current UI or adding a new one:

- Does every row align to the shared columns?
- Do all controls use the standard heights?
- Are section breaks created with spacing instead of extra boxes?
- Is there exactly one obvious active signal?
- Are labels, values, and tracks easy to scan in a vertical pass?
- Does the screen still make sense to a first-time user with no domain knowledge?
- Does the implementation mostly use Tailwind utilities plus existing semantic tokens, without adding screen-specific CSS for layout?
- Can the screen afford to remove more borders without losing clarity?
- Do utility/setup actions stay visually below the importance of the editing content?
- Are selected states obvious because they are stronger, or only because everything else is too loud?

## Immediate Application To The Current Inspector

- Tighten the panel around a strict three-column system.
- Reduce border noise and let section spacing carry more structure.
- Make `Edit` and `Presets` clearly different in state.
- Standardize all slider labels, values, and track bounds.
- Give `Curves` more vertical emphasis when expanded.
- Treat the top adjustment stack as a list pattern, not as another control group.
- Replace repeated ad hoc row layouts with one shared Tailwind row recipe.
- Keep the layer list visually calmer than the parameter controls.
- Tighten the parameter label-to-track spacing so sliders read as compact units.
- Use stronger selected-state contrast before adding more borders.
