/**
 * The pure half of mouse-mode drag and drop: when a touch after a tap may drag, and that the
 * left button goes down once, at the drag's start, no sooner than the host's double-click time.
 */
import { describe, expect, it } from "bun:test";
import {
  beginDoubleTapDrag, pressDragButton, releaseDragButton, dragPressDelay,
  DOUBLE_TAP_WINDOW_MS, DOUBLE_CLICK_GUARD_MS,
} from "../../../src/web/components/remote-desktop/remote-desktop-double-tap-drag.ts";

const START = { xFrac: 0.2, yFrac: 0.3 };
const NOW = { xFrac: 0.6, yFrac: 0.4 };

describe("double tap drag", () => {
  it("only a touch within the window after a left-click tap may drag", () => {
    expect(beginDoubleTapDrag(null, 1000, START)).toBeNull();
    expect(beginDoubleTapDrag(1000, 1000 + DOUBLE_TAP_WINDOW_MS + 1, START)).toBeNull();
    expect(beginDoubleTapDrag(1000, 1000 + DOUBLE_TAP_WINDOW_MS, START)).toEqual({
      startCursor: START, earliestDownAt: 1000 + DOUBLE_CLICK_GUARD_MS, downSent: false,
    });
  });

  it("the press waits out the host's double-click time, counted from the tap", () => {
    expect(DOUBLE_CLICK_GUARD_MS).toBeGreaterThan(500); // Windows' default double-click time
    const drag = beginDoubleTapDrag(1000, 1100, START)!;
    expect(dragPressDelay(drag, 1100)).toBe(DOUBLE_CLICK_GUARD_MS - 100);
    expect(dragPressDelay(drag, 1000 + DOUBLE_CLICK_GUARD_MS + 5)).toBe(0);
  });

  it("presses once, at the start, then moves the host cursor to the virtual one", () => {
    const drag = beginDoubleTapDrag(1000, 1100, START)!;
    expect(pressDragButton(drag, NOW)).toEqual([
      { type: "pointer", ...START, button: "left", down: true },
      { type: "pointer", ...NOW, button: null, down: null },
    ]);
    expect(pressDragButton(drag, NOW)).toEqual([]);
    expect(releaseDragButton(drag, NOW)).toEqual([{ type: "pointer", ...NOW, button: "left", down: false }]);
  });

  it("a release before the press was sent presses first", () => {
    const drag = beginDoubleTapDrag(1000, 1100, START)!;
    const msgs = releaseDragButton(drag, NOW);
    expect(msgs.map((m) => m.down)).toEqual([true, null, false]);
  });
});
