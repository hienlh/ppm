/**
 * Forwards typing from a hidden `<input>` to the shared connection, so a toolbar "Keyboard"
 * button can bring up the phone's soft keyboard without a physical keyboard ever being attached.
 *
 * The decisions live in `remote-desktop-soft-keyboard.ts`: the input's value is a mirror, and
 * every change to it (composition updates included) goes to the host as Backspaces + text the
 * moment it happens. This file only wires DOM events to it and keeps the caret at the end.
 *
 * A paste is taken from the `paste` event rather than `beforeinput`: Chromium reports it as
 * `insertFromPaste` with the text in `data` and a *null* `dataTransfer`, which is the opposite of
 * what the spec's contenteditable case describes — `clipboardData` is the one place every browser
 * agrees on. `preventDefault()` there also stops the `beforeinput` that would follow. With
 * clipboard sync off there is no paste handler, and the pasted text is absorbed into the buffer
 * without being typed: nothing leaves the device.
 */
import { useEffect, useRef, useCallback } from "react";
import { SoftKeyboardForwarder, type Send } from "./remote-desktop-soft-keyboard";

export interface UseRemoteDesktopVirtualKeyboardResult {
  inputRef: React.RefObject<HTMLInputElement | null>;
  /** Focus the hidden input, which brings up the soft keyboard on a touch device. */
  show: () => void;
}

export function useRemoteDesktopVirtualKeyboard(
  sendMessage: Send,
  enabled: boolean,
  /** Text pasted into the hidden input, for the caller to route through the host clipboard. */
  onPasteText?: (text: string) => void,
  /** A sticky Ctrl/Alt/Win from the key bar is down: a typed letter is sent as a key code. */
  comboHeld?: () => boolean,
): UseRemoteDesktopVirtualKeyboardResult {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const comboHeldRef = useRef(comboHeld);
  comboHeldRef.current = comboHeld;

  useEffect(() => {
    const input = inputRef.current;
    if (!input || !enabled) return;

    const forwarder = new SoftKeyboardForwarder(sendMessage, () => comboHeldRef.current?.() ?? false);
    let composing = false;
    let absorbNext = false;

    const caretToEnd = () => {
      try { input.setSelectionRange(input.value.length, input.value.length); } catch { /* not focusable yet */ }
    };
    const write = (value: string | null) => {
      if (value === null) return;
      input.value = value;
      caretToEnd();
    };
    write(forwarder.reset());

    // A lost keyup (blur, tab hidden, WS drop) must not leave a modifier logically held on the
    // host — force a release on every path that could lose the matching keyup.
    const releaseAll = () => sendMessage({ type: "releaseAll" });
    const onKeyDown = (e: KeyboardEvent) => { if (forwarder.keyDown(e)) e.preventDefault(); };
    const onKeyUp = (e: KeyboardEvent) => {
      if (forwarder.keyUp(e)) e.preventDefault();
      if (!composing) caretToEnd();
    };
    const onCompositionStart = () => { composing = true; };
    const onCompositionEnd = () => {
      composing = false;
      // Chrome fires the last `input` before this; whatever it held is already sent, and this
      // is the first moment the buffer may be rewritten.
      write(forwarder.input(input.value, false));
    };
    const onBeforeInput = (e: InputEvent) => {
      if (e.inputType === "insertFromPaste" || e.inputType === "insertFromDrop") absorbNext = true;
    };
    const onInput = (e: Event) => {
      if (absorbNext) { absorbNext = false; write(forwarder.absorb(input.value)); return; }
      const stillComposing = composing || (e as InputEvent).isComposing === true;
      write(forwarder.input(input.value, stillComposing));
    };
    const onPaste = (e: ClipboardEvent) => {
      const text = e.clipboardData?.getData("text/plain");
      if (!text || !onPasteText) return;
      e.preventDefault(); // suppresses the `insertFromPaste` beforeinput that would double it
      onPasteText(text);
    };
    const onFocus = () => { composing = false; write(forwarder.reset()); };
    const onBlur = () => releaseAll();
    const onVisibilityChange = () => { if (document.hidden) releaseAll(); };

    input.addEventListener("keydown", onKeyDown);
    input.addEventListener("keyup", onKeyUp);
    input.addEventListener("compositionstart", onCompositionStart);
    input.addEventListener("compositionend", onCompositionEnd);
    input.addEventListener("beforeinput", onBeforeInput);
    input.addEventListener("input", onInput);
    input.addEventListener("paste", onPaste);
    input.addEventListener("focus", onFocus);
    input.addEventListener("blur", onBlur);
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      input.removeEventListener("keydown", onKeyDown);
      input.removeEventListener("keyup", onKeyUp);
      input.removeEventListener("compositionstart", onCompositionStart);
      input.removeEventListener("compositionend", onCompositionEnd);
      input.removeEventListener("beforeinput", onBeforeInput);
      input.removeEventListener("input", onInput);
      input.removeEventListener("paste", onPaste);
      input.removeEventListener("focus", onFocus);
      input.removeEventListener("blur", onBlur);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      releaseAll();
    };
  }, [enabled, sendMessage, onPasteText]);

  const show = useCallback(() => {
    const input = inputRef.current;
    if (!input) return;
    // Android hides the keyboard on Back without blurring the input, and focusing an element
    // that already has focus does not bring the keyboard back — so let go of it first.
    if (document.activeElement === input) input.blur();
    input.focus();
  }, []);

  return { inputRef, show };
}
