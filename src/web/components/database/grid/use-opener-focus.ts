/**
 * Where the focus goes when a dialog the grid opened closes. Radix hands it to the dialog's
 * Trigger, and a dialog a key opened — Ctrl+S, Ctrl+End in the form — has none: the focus then
 * lands on the page, where none of the grid's keys reach. This goes back to whatever had the
 * focus when the dialog opened.
 */
import { useCallback, useState } from "react";

/** For `onCloseAutoFocus`; called in the dialog's first render, before its own focus moves anything. */
export function useOpenerFocus(): (e: Event) => void {
  const [opener] = useState(() => document.activeElement);
  return useCallback((e: Event) => {
    if (!(opener instanceof HTMLElement)) return;
    e.preventDefault();
    opener.focus({ preventScroll: true });
  }, [opener]);
}
