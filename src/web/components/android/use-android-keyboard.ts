/**
 * Typing into the guest, from a physical keyboard or a phone's soft one.
 *
 * Everything goes through one hidden, always-mounted `<textarea>` rather than through `keydown`
 * on the canvas, and that is not a mobile concession — it is the only source that carries what
 * was actually typed:
 *
 *  - A host IME (Telex, pinyin, any of them) composes several keystrokes into one character. The
 *    `keydown` events are the raw keys, so reading them types "Tieesng" where the user typed
 *    "Tiếng". `beforeinput` reports the composed text.
 *  - A phone's soft keyboard reports no useful key codes at all.
 *  - Chromium delivers a paste into a hidden input as `beforeinput`/`insertFromPaste` with the
 *    text in **`data`** and a null `dataTransfer` — the opposite of what the spec's
 *    contenteditable case describes (CLAUDE.md). Taking `data` covers both.
 *
 * The server then decides how to deliver it: ASCII is typed, anything else goes via the guest's
 * clipboard, because `sendKey.text` silently drops every non-ASCII character (measured, Phase 0).
 * Non-text keys — Enter, Backspace, the arrows, Escape, Tab — have no `beforeinput` that carries
 * them usefully, so those come from `keydown` and are the only thing that path is used for.
 */
import { useCallback, useEffect, useRef } from "react";
import type { AndroidClientMessage, AndroidGeometry } from "../../../shared/android-protocol";

/** `beforeinput` input types that mean "a key with no text", mapped to the w3c key name the
 *  emulator's `sendKey` takes. */
const INPUT_TYPE_KEYS: Record<string, string> = {
  deleteContentBackward: "Backspace",
  deleteContentForward: "Delete",
  insertLineBreak: "Enter",
  insertParagraph: "Enter",
};

/** Keys a `beforeinput` never reports, taken from `keydown` instead. */
const PASSTHROUGH_KEYS = new Set([
  "Enter", "Backspace", "Delete", "Tab", "Escape",
  "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight",
  "Home", "End", "PageUp", "PageDown",
]);

export interface UseAndroidKeyboardOptions {
  geometry: AndroidGeometry | null;
  enabled: boolean;
  send: (message: AndroidClientMessage) => void;
}

export interface AndroidKeyboardHandle {
  /** Attach to the hidden textarea the viewer renders. */
  inputRef: React.RefObject<HTMLTextAreaElement | null>;
  /** Give the guest the keystrokes — on desktop when the canvas is clicked, on mobile when the
   *  keyboard button is tapped (which is what raises the soft keyboard). */
  focus: () => void;
  blur: () => void;
}

export function useAndroidKeyboard(opts: UseAndroidKeyboardOptions): AndroidKeyboardHandle {
  const { geometry, enabled, send } = opts;
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  const geometryRef = useRef(geometry);
  geometryRef.current = geometry;
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;

  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;

    const onBeforeInput = (event: Event) => {
      const e = event as InputEvent;
      if (!enabledRef.current) return;
      // Nothing is ever allowed to accumulate in the textarea: it is a keystroke source, not a
      // field, and a growing value would make the caret and the undo stack real.
      e.preventDefault();

      const key = INPUT_TYPE_KEYS[e.inputType];
      if (key) {
        const g = geometryRef.current;
        if (g) send({ type: "key", geometryGeneration: g.generation, key, action: "press" });
        return;
      }
      const text = e.data ?? e.dataTransfer?.getData("text/plain") ?? "";
      if (!text) return;
      // `paste` and `text` reach the same server call; the distinction is kept on the wire so a
      // future paste-specific behaviour has somewhere to live.
      send(e.inputType === "insertFromPaste" ? { type: "paste", text } : { type: "text", text });
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (!enabledRef.current) return;
      if (!PASSTHROUGH_KEYS.has(event.key)) return;
      // Deliberately NOT preventDefault for everything: swallowing the whole keyboard would also
      // cancel the `beforeinput` the text path depends on, which is the exact trap
      // `use-remote-input-capture.ts` documents for Ctrl+V.
      event.preventDefault();
      const g = geometryRef.current;
      if (g) send({ type: "key", geometryGeneration: g.generation, key: event.key, action: "press" });
    };

    el.addEventListener("beforeinput", onBeforeInput);
    el.addEventListener("keydown", onKeyDown);
    return () => {
      el.removeEventListener("beforeinput", onBeforeInput);
      el.removeEventListener("keydown", onKeyDown);
    };
  }, [send]);

  const focus = useCallback(() => inputRef.current?.focus(), []);
  const blur = useCallback(() => inputRef.current?.blur(), []);

  return { inputRef, focus, blur };
}
