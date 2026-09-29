import { useEffect, useRef } from "react";

/**
 * Calls `onEscape` when the Escape key is pressed while the component is
 * mounted — the standard way to dismiss a modal dialog from the keyboard.
 * Pass `enabled = false` to suspend it (e.g. while a submit is in flight).
 */
export function useEscapeKey(onEscape: () => void, enabled = true): void {
  const callback = useRef(onEscape);
  callback.current = onEscape;

  useEffect(() => {
    if (!enabled) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented) callback.current();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [enabled]);
}
