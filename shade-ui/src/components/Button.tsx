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
    "onTouchStart",
    "onTouchMove",
    "onTouchEnd",
    "onTouchCancel",
    "onMouseDown",
    "onMouseUp",
    "onMouseLeave",
    "onClick",
    "disabled",
    "type",
  ]);
  const [pressed, setPressed] = createSignal(false);
  let buttonRef!: HTMLButtonElement;
  let activeTouch:
    | {
        identifier: number;
        startX: number;
        startY: number;
      }
    | null = null;
  let dispatchingSyntheticClick = false;
  let suppressNativeClickUntil = 0;

  const clearPressed = () => {
    activeTouch = null;
    setPressed(false);
  };

  const findTouch = (touches: TouchList, identifier: number) => {
    for (let index = 0; index < touches.length; index += 1) {
      const touch = touches.item(index);
      if (touch?.identifier === identifier) {
        return touch;
      }
    }
    return null;
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
      onTouchStart={(event) => {
        local.onTouchStart?.(event);
        if (event.defaultPrevented || local.disabled || event.touches.length !== 1) {
          clearPressed();
          return;
        }
        const touch = event.touches.item(0);
        if (!touch) {
          throw new Error("touch interaction requires an active touch point");
        }
        activeTouch = {
          identifier: touch.identifier,
          startX: touch.clientX,
          startY: touch.clientY,
        };
        setPressed(true);
      }}
      onTouchMove={(event) => {
        local.onTouchMove?.(event);
        if (!activeTouch) {
          return;
        }
        const touch = findTouch(event.touches, activeTouch.identifier);
        if (!touch) {
          return;
        }
        if (
          Math.hypot(
            touch.clientX - activeTouch.startX,
            touch.clientY - activeTouch.startY,
          ) > BUTTON_MOVE_THRESHOLD_PX
        ) {
          clearPressed();
        }
      }}
      onTouchEnd={(event) => {
        local.onTouchEnd?.(event);
        if (!activeTouch) {
          return;
        }
        const touch = findTouch(event.changedTouches, activeTouch.identifier);
        if (!touch) {
          return;
        }
        const releasedInside = buttonRef.contains(
          document.elementFromPoint(touch.clientX, touch.clientY),
        );
        const shouldTrigger = pressed() && releasedInside;
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
      onTouchCancel={(event) => {
        local.onTouchCancel?.(event);
        clearPressed();
      }}
      onMouseDown={(event) => {
        local.onMouseDown?.(event);
        if (event.defaultPrevented || local.disabled || event.button !== 0) {
          return;
        }
        setPressed(true);
      }}
      onMouseUp={(event) => {
        local.onMouseUp?.(event);
        setPressed(false);
      }}
      onMouseLeave={(event) => {
        local.onMouseLeave?.(event);
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
