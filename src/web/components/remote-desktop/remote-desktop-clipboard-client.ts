/**
 * The browser half of clipboard sync: which key combos mean copy/paste, and how to put text on
 * the *client's* clipboard when `navigator.clipboard` is not there.
 *
 * `navigator.clipboard` is **secure-context only**, and PPM is routinely reached over plain HTTP
 * on a LAN — so on the common deployment the async clipboard API does not exist at all and the
 * host→client direction has to fall back to a real user gesture. Even in a secure context
 * `writeText` rejects when the document is not focused, so the fallback is not dead code there.
 */

/** Ctrl/Cmd+V. This is the one keydown the input capture must *not* `preventDefault()`:
 *  cancelling that keydown cancels the browser's paste default action, and with it the `paste`
 *  event — measured, not assumed (with the guard removed the event simply never fires). */
export function isPasteCombo(e: Pick<KeyboardEvent, "code" | "ctrlKey" | "metaKey">): boolean {
  return e.code === "KeyV" && (e.ctrlKey || e.metaKey);
}

/** Ctrl/Cmd+C or +X — forwarded to the host normally; the client only uses this as the cue to
 *  ask for the host's clipboard a moment later. */
export function isCopyCombo(e: Pick<KeyboardEvent, "code" | "ctrlKey" | "metaKey">): boolean {
  return (e.code === "KeyC" || e.code === "KeyX") && (e.ctrlKey || e.metaKey);
}

/** How long to wait after forwarding a copy combo before asking the host for its clipboard.
 *  The keystroke still has to reach the host, be handled by the focused app, and land on the
 *  X/Win32 clipboard; reading too early just reads the previous contents. */
export const CLIPBOARD_READ_DELAY_MS = 350;

/** Put `text` on the client's clipboard from inside a click handler, without a secure context.
 *  Must be called synchronously from a user gesture — `execCommand` is ignored otherwise. */
export function copyTextWithGesture(text: string): boolean {
  const ta = document.createElement("textarea");
  ta.value = text;
  // Off-screen but still rendered and selectable: `display:none` / `visibility:hidden` give an
  // empty selection, and `execCommand("copy")` then copies *nothing* and still returns true.
  ta.style.cssText = "position:fixed;top:0;left:-9999px;opacity:0";
  // iOS Safari refuses to select a readonly textarea, so it is left writable and made
  // non-editable via `inputMode`/`readOnly`-free selection instead of a `readonly` attribute.
  ta.setAttribute("aria-hidden", "true");
  document.body.appendChild(ta);
  const previous = document.activeElement as HTMLElement | null;
  let ok = false;
  try {
    ta.focus({ preventScroll: true });
    ta.setSelectionRange(0, text.length); // iOS: `select()` alone is not enough
    ta.select();
    ok = document.execCommand("copy");
  } catch {
    ok = false;
  }
  ta.remove();
  // Give focus back, or the remote viewer stops receiving keystrokes after one manual copy.
  try { previous?.focus({ preventScroll: true }); } catch { /* element went away */ }
  return ok;
}

/** Try the modern API first, falling back to reporting "needs a gesture" to the caller so it can
 *  show a button. Never throws. */
export async function writeClientClipboard(text: string): Promise<boolean> {
  try {
    if (!navigator.clipboard?.writeText) return false;
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false; // insecure origin, denied permission, or an unfocused document
  }
}
