/**
 * Every key the phone's key bar can send must exist on the host side, or the button does
 * nothing and says nothing: the Windows map had no Print Screen until the bar offered it.
 */
import { describe, expect, it } from "bun:test";
import {
  MODIFIERS, FUNCTION_KEYS, F_KEYS, COMBOS,
} from "../../../src/web/components/remote-desktop/remote-desktop-mobile-key-bar.tsx";
import { codeToVk } from "../../../src/services/remote-desktop/remote-desktop-vk-map.ts";
import { codeToEvdev } from "../../../src/services/remote-desktop/remote-desktop-evdev-key-map.ts";

const codes = [
  ...MODIFIERS.map((k) => k.code),
  ...FUNCTION_KEYS.map((k) => k.code),
  ...F_KEYS.map((k) => k.code),
  ...COMBOS.flatMap((c) => c.codes),
];

describe("mobile key bar keys", () => {
  it("offers F1 to F12, Alt+F4, Print Screen and Ctrl+Shift+Esc", () => {
    expect(F_KEYS.map((k) => k.code)).toEqual(["F1", "F2", "F3", "F4", "F5", "F6", "F7", "F8", "F9", "F10", "F11", "F12"]);
    const combos = Object.fromEntries(COMBOS.map((c) => [c.label, c.codes]));
    expect(combos["Alt+F4"]).toEqual(["AltLeft", "F4"]);
    expect(combos["PrtSc"]).toEqual(["PrintScreen"]);
    expect(combos["Ctrl+Shift+Esc"]).toEqual(["ControlLeft", "ShiftLeft", "Escape"]);
  });

  it("every key is known to a Windows host", () => {
    expect(codes.filter((c) => codeToVk(c) === null)).toEqual([]);
  });

  it("every key is known to a Linux host", () => {
    expect(codes.filter((c) => codeToEvdev(c) === null)).toEqual([]);
  });
});
