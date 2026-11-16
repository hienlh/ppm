/**
 * The chat's task quick view: which task it shows as rows are clicked, what Escape closes (the
 * quick view first, the list only on the second press), and where the desktop popover goes —
 * beside the list when there is room, flipped to the other side or below/above when there is
 * not, never outside the viewport.
 */
import { describe, expect, it } from "bun:test";
import { NO_PEEK, taskPeekStep } from "../../../../src/web/lib/ppm-tasks/task-peek-state";
import { placeTaskPeek, type PeekBox, type PeekSide } from "../../../../src/web/lib/ppm-tasks/task-peek-placement";

describe("taskPeekStep", () => {
  it("shows the clicked task, moves to another, and hides it on a second click of the same row (desktop)", () => {
    let s = taskPeekStep(NO_PEEK, { type: "row", taskId: "a", toggle: true });
    expect(s).toEqual({ state: { taskId: "a" }, closeList: false });
    s = taskPeekStep(s.state, { type: "row", taskId: "b", toggle: true });
    expect(s.state.taskId).toBe("b");
    s = taskPeekStep(s.state, { type: "row", taskId: "b", toggle: true });
    expect(s.state.taskId).toBeNull();
    expect(s.closeList).toBe(false);
  });

  it("keeps the task on a repeated tap where rows do not toggle (the phone's page)", () => {
    const s = taskPeekStep({ taskId: "a" }, { type: "row", taskId: "a", toggle: false });
    expect(s.state.taskId).toBe("a");
  });

  it("closes the quick view on the first Escape and the list only on the second", () => {
    const first = taskPeekStep({ taskId: "a" }, { type: "escape" });
    expect(first).toEqual({ state: NO_PEEK, closeList: false });
    const second = taskPeekStep(first.state, { type: "escape" });
    expect(second.closeList).toBe(true);
  });

  it("goes back to the list without closing it", () => {
    expect(taskPeekStep({ taskId: "a" }, { type: "back" })).toEqual({ state: NO_PEEK, closeList: false });
  });
});

describe("placeTaskPeek", () => {
  const LIST_SIDES: PeekSide[] = ["right", "left", "bottom", "top"];
  const box = (left: number, top: number, width: number, height: number): PeekBox => ({ left, top, width, height });
  const size = { width: 340, height: 420 };
  const inside = (p: { left: number; top: number; width: number; maxHeight: number }, vw: number, vh: number) => {
    expect(p.left).toBeGreaterThanOrEqual(8);
    expect(p.top).toBeGreaterThanOrEqual(8);
    expect(p.left + p.width).toBeLessThanOrEqual(vw - 8);
    expect(p.top + p.maxHeight).toBeLessThanOrEqual(vh - 8);
  };

  it("goes to the right of the list, lined up with the clicked row, on a wide screen", () => {
    const list = box(300, 380, 520, 400);
    const row = box(300, 500, 520, 28);
    const p = placeTaskPeek({ avoid: list, align: row, size, viewport: { width: 1440, height: 900 }, sides: LIST_SIDES });
    expect(p).toMatchObject({ side: "right", mode: "fit", left: 828, top: 472, width: 340, maxHeight: 420 });
    inside(p, 1440, 900);
  });

  it("is pushed up so it ends inside the viewport when the row is near the bottom", () => {
    const p = placeTaskPeek({ avoid: box(300, 380, 520, 400), align: box(300, 740, 520, 28), size, viewport: { width: 1440, height: 900 }, sides: LIST_SIDES });
    expect(p.side).toBe("right");
    expect(p.top).toBe(900 - 8 - 420);
  });

  it("flips to the left when the right has no room", () => {
    const p = placeTaskPeek({ avoid: box(420, 380, 520, 400), align: box(420, 500, 520, 28), size, viewport: { width: 1000, height: 900 }, sides: LIST_SIDES });
    expect(p).toMatchObject({ side: "left", mode: "fit", left: 420 - 8 - 340 });
    inside(p, 1000, 900);
  });

  it("goes below when neither side has room and below does", () => {
    const p = placeTaskPeek({ avoid: box(140, 60, 520, 300), align: box(140, 100, 520, 28), size, viewport: { width: 800, height: 900 }, sides: LIST_SIDES });
    expect(p).toMatchObject({ side: "bottom", mode: "fit", top: 368, left: 140 });
    inside(p, 800, 900);
  });

  it("goes above the list (the chat's list sits at the bottom) when that is the only room", () => {
    const p = placeTaskPeek({ avoid: box(140, 470, 520, 330), align: box(140, 600, 520, 28), size, viewport: { width: 800, height: 900 }, sides: LIST_SIDES });
    expect(p).toMatchObject({ side: "top", mode: "fit", top: 470 - 8 - 420 });
  });

  it("shrinks into the side with some room before covering the list", () => {
    // 280px to the left, nothing to the right, too little above or below for the whole peek: the
    // left side takes a narrower one.
    const p = placeTaskPeek({ avoid: box(296, 330, 500, 470), align: box(296, 600, 500, 28), size, viewport: { width: 800, height: 900 }, sides: LIST_SIDES });
    expect(p).toMatchObject({ side: "left", mode: "shrink", width: 280, left: 8 });
    expect(p.left + p.width).toBeLessThanOrEqual(296 - 8);
  });

  it("shrinks into the roomier of above and below, not the first in order", () => {
    // A list low in an 800 px chat: 204px below it (over the composer), 275px above it.
    const p = placeTaskPeek({ avoid: box(292, 291, 496, 389), align: box(292, 360, 496, 28), size: { width: 340, height: 500 }, viewport: { width: 800, height: 900 }, sides: LIST_SIDES });
    expect(p).toMatchObject({ side: "top", mode: "shrink", maxHeight: 275, top: 8 });
  });

  it("covers part of what it sits beside rather than leave the viewport when nothing has room", () => {
    const p = placeTaskPeek({ avoid: box(20, 20, 380, 600), align: box(20, 40, 380, 28), size, viewport: { width: 420, height: 640 }, sides: LIST_SIDES });
    expect(p.mode).toBe("overlap");
    inside(p, 420, 640);
  });

  it("scrolls inside when the peek is taller than the viewport", () => {
    const p = placeTaskPeek({ avoid: box(300, 100, 520, 300), align: box(300, 120, 520, 28), size: { width: 340, height: 1200 }, viewport: { width: 1440, height: 700 }, sides: LIST_SIDES });
    expect(p).toMatchObject({ side: "right", maxHeight: 700 - 16, top: 8 });
  });

  it("opens above a chip in the composer, else below a chip at the top of the chat", () => {
    const sides: PeekSide[] = ["top", "bottom", "right", "left"];
    const low = placeTaskPeek({ avoid: box(500, 820, 160, 28), align: box(500, 820, 160, 28), size, viewport: { width: 1440, height: 900 }, sides });
    expect(low).toMatchObject({ side: "top", left: 500, top: 820 - 8 - 420 });
    const high = placeTaskPeek({ avoid: box(500, 60, 160, 28), align: box(500, 60, 160, 28), size, viewport: { width: 1440, height: 900 }, sides });
    expect(high).toMatchObject({ side: "bottom", top: 96 });
  });
});
