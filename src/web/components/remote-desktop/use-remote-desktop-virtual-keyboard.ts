/**
 * Forwards typing from a hidden `<input>` to the shared connection, so a toolbar "Keyboard"
 * button can bring up the phone's soft keyboard without a physical keyboard ever being attached.
 *
 * Two paths, because soft keyboards are not keyboards:
 * - A keydown with a real `code` (hardware keyboard, iOS for many keys) is forwarded as a
 *   layout-independent `key` message and `preventDefault`-ed, exactly like
 *   `use-remote-input-capture.ts` — that also suppresses the `beforeinput` that would follow.
 * - A paste is taken from the `paste` event rather than `beforeinput`: Chromium reports it as
 *   `insertFromPaste` with the text in `data` and a *null* `dataTransfer`, which is the opposite
 *   of what the spec's contenteditable case describes — `clipboardData` is the one place every
 *   browser agrees on. `preventDefault()` there also stops the `beforeinput` that would follow.
 * - Android soft keyboards send keydown with `code === ""` / keyCode 229 and put the actual
 *   characters in `beforeinput` (`insertText`) or, for predictive/IME entry, in a composition
 *   that only settles at `compositionend`. Those go up as `{ type: "text" }`, which the host
 *   types as Unicode — accents and CJK survive, no `code` mapping involved. Backspace/Enter
 *   arrive as `deleteContentBackward` / `insertLineBreak` and are mapped back to `key` events
 *   so a host without a text path still handles them.
 */
import { useEffect, useRef, useCallback } from "react";

export interface UseRemoteDesktopVirtualKeyboardResult {
  inputRef: React.RefObject<HTMLInputElement | null>;
  /** Focus the hidden input, which brings up the soft keyboard on a touch device. */
  show: () => void;
}

type Send = (msg: Record<string, unknown>) => void;

/** `beforeinput` → messages. Exported for unit tests; returns whether the event was consumed. */
export function forwardBeforeInput(inputType: string, data: string | null, send: Send): boolean {
  const tap = (code: string) => { send({ type: "key", code, down: true }); send({ type: "key", code, down: false }); };
  switch (inputType) {
    case "insertText":
      if (data) send({ type: "text", text: data });
      return true;
    case "insertLineBreak":
    case "insertParagraph":
      tap("Enter");
      return true;
    case "deleteContentBackward":
      tap("Backspace");
      return true;
    case "deleteContentForward":
      tap("Delete");
      return true;
    default:
      // insertCompositionText & friends: let the composition run; compositionend sends it.
      return false;
  }
}

export function useRemoteDesktopVirtualKeyboard(
  sendMessage: Send,
  enabled: boolean,
  /** Text pasted into the hidden input, for the caller to route through the host clipboard. */
  onPasteText?: (text: string) => void,
): UseRemoteDesktopVirtualKeyboardResult {
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    const input = inputRef.current;
    if (!input || !enabled) return;

    // A lost keyup (blur, tab hidden, WS drop) must not leave a modifier logically held on the
    // host — force a release on every path that could lose the matching keyup.
    const releaseAll = () => sendMessage({ type: "releaseAll" });
    const hasCode = (e: KeyboardEvent) => e.code !== "" && e.key !== "Unidentified";
    const onKeyDown = (e: KeyboardEvent) => {
      if (!hasCode(e)) return; // soft keyboard: the character comes via beforeinput
      e.preventDefault();
      sendMessage({ type: "key", code: e.code, down: true });
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (!hasCode(e)) return;
      e.preventDefault();
      sendMessage({ type: "key", code: e.code, down: false });
    };
    const onBeforeInput = (e: InputEvent) => {
      if (forwardBeforeInput(e.inputType, e.data, sendMessage)) e.preventDefault();
    };
    const onCompositionEnd = (e: CompositionEvent) => {
      if (e.data) sendMessage({ type: "text", text: e.data });
      input.value = ""; // the composed text landed in the input; the host already has it
    };
    const onPaste = (e: ClipboardEvent) => {
      const text = e.clipboardData?.getData("text/plain");
      if (!text || !onPasteText) return;
      e.preventDefault(); // suppresses the `insertFromPaste` beforeinput that would double it
      onPasteText(text);
    };
    const onBlur = () => releaseAll();
    const onVisibilityChange = () => { if (document.hidden) releaseAll(); };

    input.addEventListener("keydown", onKeyDown);
    input.addEventListener("keyup", onKeyUp);
    input.addEventListener("beforeinput", onBeforeInput);
    input.addEventListener("compositionend", onCompositionEnd);
    input.addEventListener("paste", onPaste);
    input.addEventListener("blur", onBlur);
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      input.removeEventListener("keydown", onKeyDown);
      input.removeEventListener("keyup", onKeyUp);
      input.removeEventListener("beforeinput", onBeforeInput);
      input.removeEventListener("compositionend", onCompositionEnd);
      input.removeEventListener("paste", onPaste);
      input.removeEventListener("blur", onBlur);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      releaseAll();
    };
  }, [enabled, sendMessage, onPasteText]);

  const show = useCallback(() => inputRef.current?.focus(), []);

  return { inputRef, show };
}
