/**
 * What the phone's soft keyboard typed, turned into messages for the host — kept free of the DOM
 * so real event sequences from Gboard, Laban Key and the iOS keyboard can be replayed in tests.
 *
 * The hidden input is a *mirror*: whatever its value becomes, the host is sent the difference
 * (Backspaces for what went, text for what came), on every `input` event, composing or not.
 * Three things made reading individual events lose keys and lag:
 *
 * - Gboard composes every word, so the characters live in `insertCompositionText` until the
 *   word is committed. Waiting for `compositionend` held each word back until the space bar
 *   (the "lag"), and a Telex or autocorrect rewrite inside it never reached the host as such.
 *   Diffing the value sends each letter as it appears and turns a rewrite ("vieet" → "viêt",
 *   "helo" → "hello") into the few Backspaces and characters that make the host match.
 * - An IME-generated key event has scancode 0, so Chrome on Android reports Backspace and Enter
 *   with `code === ""`. A Backspace in an empty field fires no `beforeinput` at all, and Enter in
 *   a single-line input never does — both were dropped. The value now always starts with
 *   `KEYBOARD_PADDING`, so a Backspace always deletes something the diff can see, and Enter (and
 *   the other named keys) is recognised by `key` when `code` is empty.
 * - Clearing the value inside `compositionend` reset the IME mid-stream; the buffer is now only
 *   rewritten while no composition is open, and only when it runs low or grows long.
 *
 * Printable characters always go as text, never as a key code: a soft keyboard's `code` (when it
 * has one) says nothing about shift state or layout, and a Vietnamese keyboard builds "ệ" from
 * several keys. The exception is a chord: a hardware Ctrl/Alt/Meta held on the event, or a
 * sticky modifier from the key bar (`comboHeld`), turns a letter or digit into its key code so
 * Ctrl+C is Ctrl+C rather than Ctrl plus the Unicode character "c".
 */

export type Send = (msg: Record<string, unknown>) => void;

/** Zero-width spaces before the caret: something for Backspace to delete in a field that looks
 *  empty, and a word boundary, so the keyboard never composes or autocorrects across it. */
export const KEYBOARD_PADDING = "​".repeat(8);
/** Refill the padding once fewer than this many are left (Backspace pressed on an empty host line). */
const REFILL_BELOW = 4;
/** Start over once the buffer is this long, so the keyboard's view of the text stays short. */
const RESET_ABOVE = 200;

/** Keys a soft keyboard sends as events rather than text, by `KeyboardEvent.key`. Their `code`
 *  is the same string, which is what the host's key table is keyed by. */
const NAMED_KEYS: ReadonlySet<string> = new Set([
  "Enter", "Tab", "Escape", "Delete", "Insert", "Home", "End", "PageUp", "PageDown",
  "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown",
  ...Array.from({ length: 12 }, (_, i) => `F${i + 1}`),
]);

const MODIFIER_CODES: Readonly<Record<string, string>> = {
  Shift: "ShiftLeft", Control: "ControlLeft", Alt: "AltLeft", Meta: "MetaLeft",
};

/** The fields of a `KeyboardEvent` this file reads. */
export interface KeyLike {
  key: string;
  code: string;
  keyCode?: number;
  isComposing?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  metaKey?: boolean;
}

/** The host key code for a character a chord can use, or null for anything else. */
export function codeForChar(ch: string): string | null {
  if (/^[a-z]$/i.test(ch)) return `Key${ch.toUpperCase()}`;
  if (/^[0-9]$/.test(ch)) return `Digit${ch}`;
  if (ch === " ") return "Space";
  return null;
}

function isHighSurrogate(unit: number): boolean {
  return unit >= 0xd800 && unit <= 0xdbff;
}

/** How to get from `prev` to `next` by typing at the end: Backspaces (one per code point, as a
 *  host deletes an emoji in one press) then text. The split never cuts a surrogate pair. */
export function textDiff(prev: string, next: string): { backspaces: number; text: string } {
  let p = 0;
  const max = Math.min(prev.length, next.length);
  while (p < max && prev.charCodeAt(p) === next.charCodeAt(p)) p++;
  // The strings share a high surrogate but not the low half after it: the whole pair changed.
  if (p > 0 && isHighSurrogate(prev.charCodeAt(p - 1))) p--;
  return { backspaces: Array.from(prev.slice(p)).length, text: next.slice(p) };
}

function leadingPadding(value: string): number {
  let n = 0;
  while (n < value.length && value[n] === "​") n++;
  return n;
}

export class SoftKeyboardForwarder {
  /** What the host has been told the field holds. */
  private value = KEYBOARD_PADDING;
  /** Codes sent down by a keydown, so only those get a keyup. */
  private readonly down = new Set<string>();

  constructor(private readonly send: Send, private readonly comboHeld: () => boolean = () => false) {}

  /** Start over: the value the input should be given now. Sends nothing. */
  reset(): string {
    this.value = KEYBOARD_PADDING;
    return this.value;
  }

  private tap(code: string): void {
    this.send({ type: "key", code, down: true });
    this.send({ type: "key", code, down: false });
  }

  /** Returns whether the event was handled here (the caller then `preventDefault`s it). */
  keyDown(e: KeyLike): boolean {
    // Mid-composition the IME owns the key; its effect arrives as a value change.
    if (e.isComposing || e.keyCode === 229) return false;
    if (MODIFIER_CODES[e.key]) {
      // Only a hardware keyboard sends these, with a code; held down for a shortcut.
      if (e.code) { this.send({ type: "key", code: e.code, down: true }); this.down.add(e.code); }
      return false;
    }
    if ((e.ctrlKey || e.altKey || e.metaKey) && e.code) {
      this.send({ type: "key", code: e.code, down: true });
      this.down.add(e.code);
      return true;
    }
    // Backspace deletes a character of the buffer; the diff sends it, once.
    if (e.key === "Backspace") return false;
    if (!NAMED_KEYS.has(e.key)) return false; // a printable character: arrives as a value change
    if (e.code) {
      // A hardware key: down now, up on its keyup, so holding an arrow repeats on the host.
      this.send({ type: "key", code: e.code, down: true });
      this.down.add(e.code);
    } else {
      // An IME key event has no code and its keyup is not worth waiting for.
      this.tap(e.key);
    }
    return true;
  }

  keyUp(e: KeyLike): boolean {
    const code = e.code || MODIFIER_CODES[e.key] || "";
    if (!code || !this.down.has(code)) return false;
    this.down.delete(code);
    this.send({ type: "key", code, down: false });
    return true;
  }

  /** The input's value is now `next`. Sends the difference; returns a value to write back into
   *  the input when the buffer should start over, which is only ever done outside a composition. */
  input(next: string, composing: boolean): string | null {
    const { backspaces, text } = textDiff(this.value, next);
    this.value = next;
    for (let i = 0; i < backspaces; i++) this.tap("Backspace");
    if (text) {
      const code = backspaces === 0 && Array.from(text).length === 1 && this.comboHeld() ? codeForChar(text) : null;
      if (code) this.tap(code);
      else this.send({ type: "text", text });
    }
    if (composing) return null;
    if (leadingPadding(next) < REFILL_BELOW || next.length > RESET_ABOVE) return this.reset();
    return null;
  }

  /** Take `next` as the field's content without telling the host (a paste that must not leave
   *  the device). Returns the value to write back. */
  absorb(next: string): string | null {
    this.value = next;
    return this.reset();
  }
}
