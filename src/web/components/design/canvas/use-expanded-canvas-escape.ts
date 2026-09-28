import { useEffect, useRef } from "react";

/**
 * Esc leaves the expanded canvas — after anything nearer the user has had its turn: an open
 * menu or dialog closes itself on that press, and so does the element picker, which listens
 * for the same key. `busy` is read when the key arrives, so it sees the state that listener
 * is about to leave.
 *
 * A key pressed inside the canvas frame never reaches this window; the close button is the
 * way out from there, and the only one on a touch screen.
 */
export function useExpandedCanvasEscape(expanded: boolean, exit: () => void, busy: () => boolean) {
  const busyRef = useRef(busy);
  busyRef.current = busy;
  const exitRef = useRef(exit);
  exitRef.current = exit;

  useEffect(() => {
    if (!expanded) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      if (document.querySelector('[role="dialog"], [role="menu"], [role="listbox"]')) return;
      if (busyRef.current()) return;
      exitRef.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [expanded]);
}
