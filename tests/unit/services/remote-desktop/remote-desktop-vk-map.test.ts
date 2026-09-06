import { describe, it, expect } from "bun:test";
import { codeToVk, MODIFIER_VK_CODES } from "../../../../src/services/remote-desktop/remote-desktop-vk-map.ts";

describe("codeToVk", () => {
  it("maps letters and digits", () => {
    expect(codeToVk("KeyA")).toBe(0x41);
    expect(codeToVk("KeyZ")).toBe(0x5a);
    expect(codeToVk("Digit0")).toBe(0x30);
    expect(codeToVk("Digit9")).toBe(0x39);
  });

  it("maps modifiers and arrows", () => {
    expect(codeToVk("ShiftLeft")).toBe(0xa0);
    expect(codeToVk("ControlRight")).toBe(0xa3);
    expect(codeToVk("ArrowUp")).toBe(0x26);
  });

  it("returns null for an unmapped code rather than guessing", () => {
    expect(codeToVk("SomeMadeUpCode")).toBeNull();
  });

  it("every modifier VK is itself resolvable from some code", () => {
    const resolved = new Set(
      ["ShiftLeft", "ShiftRight", "ControlLeft", "ControlRight", "AltLeft", "AltRight", "MetaLeft", "MetaRight"]
        .map(codeToVk),
    );
    for (const vk of MODIFIER_VK_CODES) expect(resolved.has(vk)).toBe(true);
  });
});
