/**
 * Which keyboard events become `key` messages, and which are left to the hidden text field.
 *
 * A character goes to the page as text — through `beforeinput` while nothing is composing, and
 * through `compositionupdate`/`compositionend` while an IME is (Unikey/EVKey on a PC, Gboard or
 * Laban Key on a phone). A key code cannot say which Vietnamese letter Telex produced, so only
 * keys with no character of their own travel as keys: Enter, Backspace, arrows, Tab, Escape,
 * function keys, and anything held with Ctrl/Cmd/Alt as a shortcut.
 *
 * Ctrl/Cmd+V is never forwarded: `preventDefault` on that keydown would cancel the `paste`
 * event, which is the only way to read the viewer's clipboard on a plain-HTTP origin (CLAUDE.md,
 * "preventDefault() on the Ctrl+V keydown cancels the paste event").
 */
import type { KeyModifiers, WebBrowserClientMessage } from "../../../shared/web-browser-protocol";

export type KeyLike = Pick<KeyboardEvent, "key" | "code" | "location" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey" | "repeat" | "isComposing" | "keyCode">;

export function keyModifiers(e: KeyLike): KeyModifiers {
  return { alt: e.altKey, ctrl: e.ctrlKey, meta: e.metaKey, shift: e.shiftKey };
}

export function isPasteKey(e: KeyLike): boolean {
  return (e.ctrlKey || e.metaKey) && !e.altKey && (e.code === "KeyV" || e.key.toLowerCase() === "v");
}

export function isCopyKey(e: KeyLike): boolean {
  return (e.ctrlKey || e.metaKey) && !e.altKey && (e.code === "KeyC" || e.code === "KeyX");
}

/** The message for this key, or null when the text field (or the IME) should handle it. */
export function keyMessage(e: KeyLike, down: boolean): WebBrowserClientMessage | null {
  if (e.isComposing || e.key === "Process" || e.keyCode === 229 || e.key === "Dead" || e.key === "Unidentified") return null;
  if (isPasteKey(e)) return null;
  const shortcut = e.ctrlKey || e.metaKey || e.altKey;
  if (e.key.length === 1 && !shortcut) return null;
  return {
    type: "key",
    down,
    key: e.key.slice(0, 64),
    code: e.code.slice(0, 64),
    location: e.location,
    modifiers: keyModifiers(e),
    repeat: e.repeat,
  };
}

/**
 * A `beforeinput` from the text field as a message. Returns null for what the composition
 * events carry instead (`insertCompositionText` and friends).
 */
export function beforeInputMessages(inputType: string, data: string | null): WebBrowserClientMessage[] | null {
  const tap = (key: string): WebBrowserClientMessage[] => [
    { type: "key", down: true, key, code: key, location: 0, modifiers: {}, repeat: false },
    { type: "key", down: false, key, code: key, location: 0, modifiers: {}, repeat: false },
  ];
  switch (inputType) {
    case "insertText":
    case "insertReplacementText":
      return data ? [{ type: "text", text: data }] : [];
    case "insertLineBreak":
    case "insertParagraph":
      return tap("Enter");
    case "deleteContentBackward":
      return tap("Backspace");
    case "deleteContentForward":
      return tap("Delete");
    default:
      return null;
  }
}
