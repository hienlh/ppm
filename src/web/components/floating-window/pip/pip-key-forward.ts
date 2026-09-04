/**
 * Forward keyboard events from a PiP window to the main window.
 *
 * The app's global shortcuts are bound once on the main `window` and cannot be
 * re-bound from outside, so events that originate in the PiP document are
 * cloned and re-dispatched there.
 *
 * Two limits are deliberate:
 * - `preventDefault()` on the clone does NOT suppress the original event's
 *   browser default inside the PiP. Forwarding is one-way; never rely on the
 *   clone to cancel anything.
 * - Targets that own their keyboard handling are skipped, so a shortcut does
 *   not fire while the user is typing. Monaco's EditContext host is a `div`
 *   (`.native-edit-context`), not an input, and xterm listens on its helper
 *   textarea — both must be in the skip list.
 */

const SKIP_SELECTOR = [
  "input",
  "textarea",
  "select",
  "[contenteditable]",
  ".native-edit-context",
  ".monaco-editor",
  ".xterm-helper-textarea",
].join(", ");

/** PiP-created nodes live in another realm, so `instanceof Element` is unsafe. */
function isEditableTarget(target: EventTarget | null): boolean {
  const el = target as Element | null;
  if (!el || typeof el.closest !== "function") return false;
  return el.closest(SKIP_SELECTOR) !== null;
}

/**
 * Clone `keydown`/`keyup` from `from` onto `to`. Returns an unsubscribe.
 * Only events originating in `from` are forwarded, so the main window never
 * sees its own events twice.
 */
export function forwardKeyEvents(from: Window, to: Window): () => void {
  const handler = (event: Event) => {
    const keyEvent = event as KeyboardEvent;
    if (isEditableTarget(keyEvent.target)) return;
    to.dispatchEvent(new KeyboardEvent(keyEvent.type, keyEvent));
  };
  from.addEventListener("keydown", handler);
  from.addEventListener("keyup", handler);
  return () => {
    from.removeEventListener("keydown", handler);
    from.removeEventListener("keyup", handler);
  };
}
