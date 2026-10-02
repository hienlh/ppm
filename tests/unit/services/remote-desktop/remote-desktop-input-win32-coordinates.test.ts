import { describe, expect, it } from "bun:test";
import { windowsAbsolutePointer } from "../../../../src/services/remote-desktop/remote-desktop-input-win32.ts";
import type { InputTargetRect } from "../../../../src/services/remote-desktop/remote-desktop-input-backend.ts";

// Decode the normalized SendInput grid back to physical pixels, independently of the
// monitor mapping. Endpoint assertions catch clicks leaking into an adjacent display.
function physical(x: number, y: number, target: InputTargetRect, desktop: InputTargetRect) {
  const absolute = windowsAbsolutePointer(x, y, target, desktop);
  return {
    x: desktop.x + Math.floor(absolute.x * desktop.width / 65536),
    y: desktop.y + Math.floor(absolute.y * desktop.height / 65536),
  };
}

describe("Windows selected-monitor pointer coordinates", () => {
  it("keeps each endpoint inside the selected screen when monitors touch", () => {
    const desktop = { x: 0, y: 0, width: 3840, height: 1080 };
    const left = { x: 0, y: 0, width: 1920, height: 1080 };
    const right = { ...left, x: 1920 };
    expect(physical(0, 0, left, desktop)).toEqual({ x: 0, y: 0 });
    expect(physical(1, 1, left, desktop)).toEqual({ x: 1919, y: 1079 });
    expect(physical(0, 0, right, desktop)).toEqual({ x: 1920, y: 0 });
    expect(physical(1, 1, right, desktop)).toEqual({ x: 3839, y: 1079 });
  });

  it("maps negative origins and unequal screen dimensions in physical pixels", () => {
    const desktop = { x: -2560, y: -1440, width: 6000, height: 2880 };
    const upperLeft = { x: -2560, y: -1440, width: 2560, height: 1440 };
    const primary = { x: 0, y: 0, width: 3440, height: 1440 };
    expect(physical(0, 0, upperLeft, desktop)).toEqual({ x: -2560, y: -1440 });
    expect(physical(1, 1, upperLeft, desktop)).toEqual({ x: -1, y: -1 });
    expect(physical(0.5, 0.5, upperLeft, desktop)).toEqual({ x: -1280, y: -720 });
    expect(physical(0.5, 0.5, primary, desktop)).toEqual({ x: 1720, y: 720 });
  });

  it("maps the upper and lower monitor independently in a stacked layout", () => {
    const desktop = { x: 0, y: -1440, width: 3440, height: 2880 };
    expect(physical(0.25, 0.5, { ...desktop, height: 1440 }, desktop)).toEqual({ x: 860, y: -720 });
    expect(physical(0.25, 0.5, { ...desktop, y: 0, height: 1440 }, desktop)).toEqual({ x: 860, y: 720 });
  });

  it("clamps out-of-range fractions to the selected monitor", () => {
    const desktop = { x: -1920, y: 0, width: 3840, height: 1080 };
    const target = { x: 0, y: 0, width: 1920, height: 1080 };
    expect(physical(-4, 8, target, desktop)).toEqual({ x: 0, y: 1079 });
    expect(physical(4, -8, target, desktop)).toEqual({ x: 1919, y: 0 });
  });

  it("preserves All displays normalization, including null targets", () => {
    const desktop = { x: -1920, y: -1080, width: 3840, height: 2160 };
    for (const target of [desktop, null]) {
      expect(windowsAbsolutePointer(0.5, 0.5, target, desktop)).toEqual({ x: 32768, y: 32768 });
      expect(windowsAbsolutePointer(-1, 2, target, desktop)).toEqual({ x: 0, y: 65535 });
    }
  });

  it("refuses selected-monitor clicks if virtual screen metrics are unavailable", () => {
    const target = { x: 0, y: 0, width: 1920, height: 1080 };
    expect(() => windowsAbsolutePointer(0.5, 0.5, target, { x: 0, y: 0, width: 0, height: 0 }))
      .toThrow("Cannot map pointer without display dimensions");
  });
});
