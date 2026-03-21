import { createSignal, JSX, mergeProps, splitProps } from "solid-js";

const BUTTON_MOVE_THRESHOLD_PX = 10;
const SYNTHETIC_CLICK_SUPPRESSION_MS = 750;

type ButtonProps = JSX.ButtonHTMLAttributes<HTMLButtonElement> & {
  ref?: (element: HTMLButtonElement) => void;
};

export function Button(props: ButtonProps) {
  const merged = mergeProps({ type: "button" as const }, props);
  const [local, rest] = splitProps(merged, [
    "ref",
    "onPointerDown",
    "onPointerMove",
    "onPointerUp",
    "onPointerCancel",
    "onClick",
    "disabled",
    "type",
  ]);
  const [pressed, setPressed] = createSignal(false);
  let buttonRef!: HTMLButtonElement;
  let activePointer:
    | {
        pointerId: number;
        pointerType: string;
        startX: number;
        startY: number;
      }
    | null = null;
  let dispatchingSyntheticClick = false;
  let suppressNativeClickUntil = 0;

  const clearPressed = () => {
    activePointer = null;
    setPressed(false);
  };

  return (
    <button
      {...rest}
      ref={(element) => {
        buttonRef = element;
        local.ref?.(element);
      }}
      type={local.type}
      disabled={local.disabled}
      data-pressed={pressed() ? "true" : undefined}
      onPointerDown={(event) => {
        local.onPointerDown?.(event);
        if (
          event.defaultPrevented ||
          !event.isPrimary ||
          event.button !== 0 ||
          local.disabled
        ) {
          return;
        }
        activePointer = {
          pointerId: event.pointerId,
          pointerType: event.pointerType,
          startX: event.clientX,
          startY: event.clientY,
        };
        setPressed(true);
      }}
      onPointerMove={(event) => {
        local.onPointerMove?.(event);
        if (!activePointer || activePointer.pointerId !== event.pointerId) {
          return;
        }
        if (
          Math.hypot(
            event.clientX - activePointer.startX,
            event.clientY - activePointer.startY,
          ) > BUTTON_MOVE_THRESHOLD_PX
        ) {
          clearPressed();
        }
      }}
      onPointerUp={(event) => {
        local.onPointerUp?.(event);
        if (!activePointer || activePointer.pointerId !== event.pointerId) {
          return;
        }
        const releasedInside = buttonRef.contains(event.target as Node);
        const pointerType = activePointer.pointerType;
        const shouldTrigger = pressed() && releasedInside && pointerType !== "mouse";
        clearPressed();
        if (!shouldTrigger) {
          return;
        }
        suppressNativeClickUntil =
          performance.now() + SYNTHETIC_CLICK_SUPPRESSION_MS;
        dispatchingSyntheticClick = true;
        buttonRef.click();
        dispatchingSyntheticClick = false;
        event.preventDefault();
      }}
      onPointerCancel={(event) => {
        local.onPointerCancel?.(event);
        clearPressed();
      }}
      onClick={(event) => {
        if (dispatchingSyntheticClick) {
          local.onClick?.(event);
          return;
        }
        if (suppressNativeClickUntil >= performance.now()) {
          event.preventDefault();
          event.stopPropagation();
          return;
        }
        local.onClick?.(event);
      }}
    />
  );
}
