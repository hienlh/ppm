import { describe, it, expect } from "bun:test";
import { codeToCgKey, CGKEY_MODIFIER_FLAG, MODIFIER_CGKEY_CODES } from "../../../../src/services/remote-desktop/remote-desktop-cg-key-map.ts";
import { codeToVk } from "../../../../src/services/remote-desktop/remote-desktop-vk-map.ts";

describe("remote-desktop-cg-key-map", () => {
  it("maps the ANSI keycodes the Windows table maps, minus the keys a Mac does not have", () => {
    // Everything the win32 backend accepts should type the same key on a Mac, except these.
    const macHasNoKey = new Set(["ContextMenu", "Pause", "ScrollLock"]);
    const probe = [
      "KeyA", "KeyZ", "Digit0", "Digit9", "Enter", "Tab", "Space", "Backspace", "Escape",
      "ArrowLeft", "ArrowUp", "ArrowRight", "ArrowDown", "Home", "End", "PageUp", "PageDown",
      "Delete", "Insert", "F1", "F12", "Semicolon", "Quote", "Backquote", "Slash", "Backslash",
      "BracketLeft", "BracketRight", "Comma", "Period", "Minus", "Equal", "Numpad0", "Numpad9",
      "NumpadAdd", "NumpadEnter", "ContextMenu", "Pause", "ScrollLock",
    ];
    for (const code of probe) {
      if (macHasNoKey.has(code)) expect(codeToCgKey(code)).toBeNull();
      else expect(codeToCgKey(code)).not.toBeNull();
    }
    // KeyA is keycode 0 — a falsy value that must still count as mapped.
    expect(codeToCgKey("KeyA")).toBe(0);
    expect(codeToVk("KeyA")).not.toBeNull();
  });

  it("uses Command for Meta and Option for Alt, each with its CGEventFlags bit", () => {
    expect(codeToCgKey("MetaLeft")).toBe(0x37);
    expect(codeToCgKey("AltLeft")).toBe(0x3a);
    expect(CGKEY_MODIFIER_FLAG[0x37]).toBe(0x00100000); // kCGEventFlagMaskCommand
    expect(CGKEY_MODIFIER_FLAG[0x3a]).toBe(0x00080000); // kCGEventFlagMaskAlternate
    expect(CGKEY_MODIFIER_FLAG[0x38]).toBe(0x00020000); // Shift
    expect(CGKEY_MODIFIER_FLAG[0x3b]).toBe(0x00040000); // Control
  });

  it("release list covers every modifier keycode that carries a flag", () => {
    expect([...MODIFIER_CGKEY_CODES].sort()).toEqual(Object.keys(CGKEY_MODIFIER_FLAG).map(Number).sort());
  });

  it("returns null for unknown codes rather than guessing", () => {
    expect(codeToCgKey("Unidentified")).toBeNull();
    expect(codeToCgKey("")).toBeNull();
  });
});
