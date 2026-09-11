import { describe, it, expect } from "bun:test";
import {
  ALL_EVDEV_CODES, codeToEvdev, MODIFIER_EVDEV_CODES, X11_KEYCODE_OFFSET,
} from "../../../../src/services/remote-desktop/remote-desktop-evdev-key-map.ts";

describe("remote-desktop-evdev-key-map", () => {
  it("names physical switches, so the table is a rename rather than a layout lookup", () => {
    // These are the values verified against a live X server via evdev + X11_KEYCODE_OFFSET.
    expect(codeToEvdev("KeyA")).toBe(30);
    expect(codeToEvdev("Escape")).toBe(1);
    expect(codeToEvdev("Enter")).toBe(28);
    expect(codeToEvdev("MetaLeft")).toBe(125);
    expect(codeToEvdev("F5")).toBe(63);
  });

  it("keeps the X11 offset at 8 — the whole XTEST path is built on evdev + 8", () => {
    expect(X11_KEYCODE_OFFSET).toBe(8);
    expect(codeToEvdev("KeyA")! + X11_KEYCODE_OFFSET).toBe(38);
    expect(codeToEvdev("Escape")! + X11_KEYCODE_OFFSET).toBe(9);
  });

  it("returns null for an unmapped code instead of guessing a wrong key", () => {
    expect(codeToEvdev("MediaPlayPause")).toBeNull();
    expect(codeToEvdev("")).toBeNull();
    expect(codeToEvdev("Lang1")).toBeNull();
  });

  it("lists every modifier, so a lost keyup can always be force-released", () => {
    const expected = ["ShiftLeft", "ShiftRight", "ControlLeft", "ControlRight",
      "AltLeft", "AltRight", "MetaLeft", "MetaRight"].map((c) => codeToEvdev(c));
    expect([...MODIFIER_EVDEV_CODES].sort((a, b) => a - b)).toEqual(expected.sort((a, b) => a! - b!));
  });

  it("ALL_EVDEV_CODES covers the table with no duplicates — a uinput device declares each key", () => {
    // An undeclared key is dropped by the kernel silently, so this list gates what uinput sends.
    expect(new Set(ALL_EVDEV_CODES).size).toBe(ALL_EVDEV_CODES.length);
    for (const code of ["KeyA", "F12", "ArrowUp", "MetaRight", "NumpadEnter"]) {
      expect(ALL_EVDEV_CODES).toContain(codeToEvdev(code)!);
    }
  });
});
