import { describe, it, expect } from "bun:test";
import {
  enterDragDepth,
  leaveDragDepth,
  resetDragDepth,
  type DragDepthCounter,
} from "../../../src/web/components/os-explorer/dnd/drag-depth-counter.ts";

describe("enterDragDepth / leaveDragDepth", () => {
  it("becomes true only on the 0->1 enter and the 1->0 leave", () => {
    const counter: DragDepthCounter = { current: 0 };
    expect(enterDragDepth(counter, true)).toBe(true);
    expect(counter.current).toBe(1);
    expect(enterDragDepth(counter, true)).toBe(false); // nested child's own enter
    expect(counter.current).toBe(2);
    expect(leaveDragDepth(counter, true)).toBe(false); // nested child's own leave
    expect(counter.current).toBe(1);
    expect(leaveDragDepth(counter, true)).toBe(true);
    expect(counter.current).toBe(0);
  });

  it("a rejected drag kind never increments or decrements the counter", () => {
    const counter: DragDepthCounter = { current: 0 };
    expect(enterDragDepth(counter, false)).toBe(false);
    expect(counter.current).toBe(0);
    expect(leaveDragDepth(counter, false)).toBe(false);
    expect(counter.current).toBe(0);
  });

  it("a drag kind that never incremented the counter cannot drive it negative on leave", () => {
    // The exact regression this module fixes: an entry drag passing over the OS-upload
    // background must not decrement a counter only the OS-upload drag ever increments.
    const counter: DragDepthCounter = { current: 0 };
    leaveDragDepth(counter, true);
    leaveDragDepth(counter, true);
    expect(counter.current).toBe(0);
    // ...so a real drag afterwards still reaches 1 on its first enter, not -1.
    expect(enterDragDepth(counter, true)).toBe(true);
    expect(counter.current).toBe(1);
  });

  it("clamps at zero even if enter/leave calls are unbalanced", () => {
    const counter: DragDepthCounter = { current: 1 };
    leaveDragDepth(counter, true);
    leaveDragDepth(counter, true);
    expect(counter.current).toBe(0);
  });
});

describe("resetDragDepth", () => {
  it("zeroes the counter regardless of its current value", () => {
    const counter: DragDepthCounter = { current: 3 };
    resetDragDepth(counter);
    expect(counter.current).toBe(0);
  });
});
