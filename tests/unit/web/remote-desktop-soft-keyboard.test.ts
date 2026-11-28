/**
 * The phone keyboard → host messages, replayed from the event sequences real keyboards produce.
 *
 * What each keyboard does to a plain `<input type=text>` (Chrome on Android, Safari on iOS):
 * - Gboard composes every word: `keydown` 229/"Unidentified", then the value grows letter by
 *   letter inside a composition that is committed at the space bar (or rewritten by
 *   autocorrect). Its Backspace and Enter come as key events with `code === ""`.
 * - Laban Key (Telex) and Gboard's Vietnamese layout rewrite the last letter: "a" then "â".
 * - The iOS keyboard sends `keydown` with a `code` for plain letters, and composes (marked text)
 *   for Vietnamese.
 *
 * The forwarder only sees the value after each event, so the tests drive it the way the hook
 * does: keydown → (value change → input) → keyup.
 */
import { describe, expect, it } from "bun:test";
import {
  KEYBOARD_PADDING as PAD, SoftKeyboardForwarder, codeForChar, textDiff, type KeyLike,
} from "../../../src/web/components/remote-desktop/remote-desktop-soft-keyboard";

function rig(comboHeld = () => false) {
  const sent: Record<string, unknown>[] = [];
  const f = new SoftKeyboardForwarder((m) => { sent.push(m); }, comboHeld);
  let value = f.reset();
  return {
    sent,
    get value() { return value; },
    /** The keyboard changed the field to `next` (an `input` event). */
    type(next: string, composing = false) {
      const back = f.input(next, composing);
      value = back ?? next;
    },
    key(e: Partial<KeyLike> & { key: string }) {
      return f.keyDown({ code: "", ...e });
    },
    keyUp(e: Partial<KeyLike> & { key: string }) {
      return f.keyUp({ code: "", ...e });
    },
    absorb(next: string) { value = f.absorb(next) ?? next; },
  };
}

const text = (t: string) => ({ type: "text", text: t });
const tap = (code: string) => [{ type: "key", code, down: true }, { type: "key", code, down: false }];
const ANDROID_IME = { key: "Unidentified", keyCode: 229 };

describe("Android, Gboard (composition)", () => {
  it("each letter of a composed word reaches the host as it is typed, not at the space bar", () => {
    const k = rig();
    for (const word of ["h", "he", "hel", "hell", "hello"]) {
      expect(k.key(ANDROID_IME)).toBe(false);
      k.type(PAD + word, true);
    }
    // Nothing waits for compositionend: five letters, five messages, in order.
    expect(k.sent).toEqual(["h", "e", "l", "l", "o"].map(text));
    k.type(PAD + "hello", false); // compositionend: nothing new
    k.type(PAD + "hello ", false); // space commits
    expect(k.sent.at(-1)).toEqual(text(" "));
  });

  it("autocorrect rewriting the word becomes Backspaces plus the corrected tail", () => {
    const k = rig();
    for (const w of ["h", "he", "hel", "helo"]) k.type(PAD + w, true);
    k.sent.length = 0;
    k.type(PAD + "hello ", false); // Gboard commits its correction with the space
    expect(k.sent).toEqual([...tap("Backspace"), text("lo ")]);
  });

  it("Vietnamese Telex inside a composition: only the changed letter is retyped", () => {
    const k = rig();
    for (const w of ["v", "vi", "vie", "viê", "viêt", "việt"]) k.type(PAD + w, true);
    expect(k.sent).toEqual([
      text("v"), text("i"), text("e"),
      ...tap("Backspace"), text("ê"),
      text("t"),
      ...tap("Backspace"), ...tap("Backspace"), text("ệt"),
    ]);
  });

  it("Backspace in a field that looks empty still reaches the host, and the padding refills", () => {
    const k = rig();
    // Gboard's Backspace: a key event with no code, which the forwarder leaves to the value.
    expect(k.key({ key: "Backspace", keyCode: 8 })).toBe(false);
    for (let i = 0; i < 5; i++) k.type(k.value.slice(0, -1));
    expect(k.sent).toEqual(Array.from({ length: 5 }, () => tap("Backspace")).flat());
    expect(k.value).toBe(PAD); // refilled once it ran low, without telling the host
  });

  it("Enter with no code is sent as Enter, once", () => {
    const k = rig();
    expect(k.key({ key: "Enter", keyCode: 13 })).toBe(true);
    expect(k.keyUp({ key: "Enter", keyCode: 13 })).toBe(false);
    expect(k.sent).toEqual(tap("Enter"));
  });

  it("the buffer is never rewritten mid-composition, only after it", () => {
    const k = rig();
    const long = "a".repeat(250);
    k.type(PAD + long, true);
    expect(k.value).toBe(PAD + long);
    k.type(PAD + long, false);
    expect(k.value).toBe(PAD);
    expect(k.sent).toEqual([text(long)]);
  });
});

describe("Android, Laban Key (replace instead of compose)", () => {
  it("'aa' → 'â': the replaced letter is deleted on the host and the new one typed", () => {
    const k = rig();
    k.type(PAD + "a");
    k.type(PAD + "");
    k.type(PAD + "â");
    expect(k.sent).toEqual([text("a"), ...tap("Backspace"), text("â")]);
  });

  it("one replacement in a single change (delete + insert in one input)", () => {
    const k = rig();
    k.type(PAD + "Vie");
    k.type(PAD + "Viê");
    expect(k.sent).toEqual([text("Vie"), ...tap("Backspace"), text("ê")]);
  });
});

describe("iOS keyboard", () => {
  it("a letter with a code still goes as text (code says nothing about shift or layout)", () => {
    const k = rig();
    expect(k.key({ key: "A", code: "KeyA", keyCode: 65 })).toBe(false);
    k.type(PAD + "A");
    expect(k.keyUp({ key: "A", code: "KeyA" })).toBe(false);
    expect(k.sent).toEqual([text("A")]);
  });

  it("Vietnamese marked text composes like Gboard", () => {
    const k = rig();
    expect(k.key({ key: "d", keyCode: 229, isComposing: true })).toBe(false);
    for (const w of ["d", "dd", "đ", "đo", "đô", "đôi"]) k.type(PAD + w, true);
    k.type(PAD + "đôi ", false);
    // Replaying the messages on an empty host line leaves exactly what the phone shows.
    let host = "";
    for (const m of k.sent) {
      if (m.type === "text") host += m.text as string;
      else if (m.down === true) host = host.slice(0, -1);
    }
    expect(host).toBe("đôi ");
  });
});

describe("hardware keys and chords", () => {
  it("arrows from a hardware keyboard go down on keydown and up on keyup", () => {
    const k = rig();
    expect(k.key({ key: "ArrowLeft", code: "ArrowLeft" })).toBe(true);
    expect(k.keyUp({ key: "ArrowLeft", code: "ArrowLeft" })).toBe(true);
    expect(k.sent).toEqual(tap("ArrowLeft"));
  });

  it("Ctrl+C from a hardware keyboard is a chord of key codes", () => {
    const k = rig();
    k.key({ key: "Control", code: "ControlLeft" });
    expect(k.key({ key: "c", code: "KeyC", ctrlKey: true })).toBe(true);
    k.keyUp({ key: "c", code: "KeyC" });
    k.keyUp({ key: "Control", code: "ControlLeft" });
    expect(k.sent).toEqual([
      { type: "key", code: "ControlLeft", down: true }, { type: "key", code: "KeyC", down: true },
      { type: "key", code: "KeyC", down: false }, { type: "key", code: "ControlLeft", down: false },
    ]);
  });

  it("a sticky Ctrl from the key bar turns a typed letter into its key code", () => {
    const k = rig(() => true);
    k.type(PAD + "c");
    k.type(PAD + "cé"); // not a chord-able character: stays text
    expect(k.sent).toEqual([...tap("KeyC"), text("é")]);
  });
});

describe("paste with clipboard sync off", () => {
  it("is absorbed: nothing reaches the host", () => {
    const k = rig();
    k.absorb(PAD + "secret token");
    expect(k.sent).toEqual([]);
    expect(k.value).toBe(PAD);
    k.type(PAD + "x");
    expect(k.sent).toEqual([text("x")]);
  });
});

describe("textDiff", () => {
  it("never splits a surrogate pair", () => {
    expect(textDiff("a😀", "a😃")).toEqual({ backspaces: 1, text: "😃" });
    expect(textDiff("a😀b", "a")).toEqual({ backspaces: 2, text: "" });
  });

  it("codeForChar covers letters, digits and space only", () => {
    expect(codeForChar("z")).toBe("KeyZ");
    expect(codeForChar("7")).toBe("Digit7");
    expect(codeForChar(" ")).toBe("Space");
    expect(codeForChar("ê")).toBeNull();
  });
});
