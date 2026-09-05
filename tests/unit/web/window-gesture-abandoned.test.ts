/**
 * The guard that keeps a window close from throwing.
 *
 * Pressing a caption button starts a titlebar drag; closing the window unmounts the frame
 * before the pointer is released, and the recogniser still delivers a terminating event with
 * no memo. Every close logged a TypeError until the handlers bailed out on that shape.
 */
import { describe, it, expect } from "bun:test";
import { gestureAbandoned } from "../../../src/web/components/floating-window/use-window-gesture-context";

describe("gestureAbandoned", () => {
  it("is false on the first event, which is where the rect is captured", () => {
    expect(gestureAbandoned(true, undefined)).toBe(false);
  });

  it("is false for a normal continuation carrying its rect", () => {
    expect(gestureAbandoned(false, { x: 0, y: 0, w: 10, h: 10 })).toBe(false);
  });

  it("is true for a trailing event whose window is already gone", () => {
    expect(gestureAbandoned(false, undefined)).toBe(true);
  });
});
