/**
 * Keyboard focus for the history window.
 *
 * Opening the window makes the live list `inert`, and the turn chip that asked for the jump usually
 * sits in that list — so focus would fall to `<body>` and a keyboard user would land nowhere. On
 * open, focus moves to the window's scroller (where arrow keys and Page Up/Down then scroll it).
 * On close it goes back to what held it before, the way a dialog returns focus to its trigger —
 * but only when nothing else has it by then: leaving because a message was sent keeps the composer
 * focused.
 */
import { useLayoutEffect } from "react";

function lost(): boolean {
  const active = document.activeElement;
  return !active || active === document.body;
}

export function useHistoryWindowFocus(scrollEl: HTMLElement | null): void {
  useLayoutEffect(() => {
    if (!scrollEl) return;
    const before = document.activeElement instanceof HTMLElement && document.activeElement !== document.body
      ? document.activeElement
      : null;
    scrollEl.focus({ preventScroll: true });
    return () => {
      // After the commit that removes the window: the live list is no longer inert by then.
      requestAnimationFrame(() => {
        // A trigger in a hidden tab cannot take focus anyway (`focus()` on it does nothing).
        if (!lost() || !before?.isConnected || before.closest("[inert]")) return;
        before.focus({ preventScroll: true });
      });
    };
  }, [scrollEl]);
}
