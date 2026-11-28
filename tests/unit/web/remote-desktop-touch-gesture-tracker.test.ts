/**
 * Where a phone tap or two-finger tap lands on the host. A two-finger tap is a right click: in
 * MOUSE mode it must click where the virtual cursor sits (it used to click the point between
 * the fingers, so the menu opened somewhere else and the host cursor jumped away from the
 * marker), and in TOUCH mode it clicks between the fingers, through any pinch-zoom and pan.
 * Coordinates are CSS pixels, the unit touch events report whatever the phone's
 * devicePixelRatio is, so no ratio appears anywhere here.
 */
import { describe, expect, it } from "bun:test";
import {
  beginSingleTouch, beginTwoFingerTouch, resolveSingleTouchEnd, resolveTwoFingerEnd,
  advanceTwoFingerTouch, resolveLongPress, advanceSingleTouch, TAP_MAX_DURATION_MS,
} from "../../../src/web/components/remote-desktop/remote-desktop-touch-gesture-tracker.ts";
import { letterboxedContentRect } from "../../../src/web/components/remote-desktop/remote-desktop-coords.ts";

/** A 390x700 phone stage showing a 1920x1080 capture: letterboxed top and bottom. */
const BOX = { left: 0, top: 0, width: 390, height: 700 };
const VIDEO = letterboxedContentRect(BOX, 1920, 1080);
const IDENTITY = { scale: 1, panX: 0, panY: 0 };
const ZOOMED = { scale: 2, panX: 40, panY: -30 };
const CURSOR = { xFrac: 0.8, yFrac: 0.25 };

/** The screen point at which a capture fraction is drawn under `transform` (the forward map). */
function screenPoint(xFrac: number, yFrac: number, t: { scale: number; panX: number; panY: number }) {
  const cx = VIDEO.left + VIDEO.width / 2;
  const cy = VIDEO.top + VIDEO.height / 2;
  const bx = VIDEO.left + xFrac * VIDEO.width;
  const by = VIDEO.top + yFrac * VIDEO.height;
  return { x: cx + t.panX + t.scale * (bx - cx), y: cy + t.panY + t.scale * (by - cy) };
}

function rightClickAt(msgs: Record<string, unknown>[]) {
  expect(msgs).toHaveLength(2);
  expect(msgs[0]).toMatchObject({ type: "pointer", button: "right", down: true });
  expect(msgs[1]).toMatchObject({ type: "pointer", button: "right", down: false });
  expect(msgs[1]!.xFrac).toBe(msgs[0]!.xFrac);
  return { xFrac: msgs[0]!.xFrac as number, yFrac: msgs[0]!.yFrac as number };
}

/** A two-finger tap with both fingers either side of `mid`, 60px apart. */
function twoFingerTapAround(mid: { x: number; y: number }, scale: number) {
  return beginTwoFingerTouch({ x: mid.x - 30, y: mid.y }, { x: mid.x + 30, y: mid.y }, scale);
}

describe("two-finger tap = right click", () => {
  it("mouse mode clicks at the virtual cursor, not between the fingers", () => {
    const fingers = screenPoint(0.2, 0.7, IDENTITY);
    const track = twoFingerTapAround(fingers, 1);
    const at = rightClickAt(resolveTwoFingerEnd(track, VIDEO, IDENTITY, "mouse", CURSOR));
    expect(at).toEqual(CURSOR);
  });

  it("mouse mode clicks at the virtual cursor while zoomed and panned", () => {
    const fingers = screenPoint(0.3, 0.4, ZOOMED);
    const track = twoFingerTapAround(fingers, ZOOMED.scale);
    const at = rightClickAt(resolveTwoFingerEnd(track, VIDEO, ZOOMED, "mouse", CURSOR));
    expect(at).toEqual(CURSOR);
  });

  it("touch mode clicks between the fingers", () => {
    const fingers = screenPoint(0.2, 0.7, IDENTITY);
    const at = rightClickAt(resolveTwoFingerEnd(twoFingerTapAround(fingers, 1), VIDEO, IDENTITY, "touch", CURSOR));
    expect(at.xFrac).toBeCloseTo(0.2, 6);
    expect(at.yFrac).toBeCloseTo(0.7, 6);
  });

  it("touch mode maps the point between the fingers back through zoom and pan", () => {
    const fingers = screenPoint(0.65, 0.35, ZOOMED);
    const at = rightClickAt(resolveTwoFingerEnd(twoFingerTapAround(fingers, 2), VIDEO, ZOOMED, "touch", CURSOR));
    expect(at.xFrac).toBeCloseTo(0.65, 6);
    expect(at.yFrac).toBeCloseTo(0.35, 6);
  });

  it("a pinch or a scroll is not a right click, in either mode", () => {
    for (const mode of ["mouse", "touch"] as const) {
      const track = beginTwoFingerTouch({ x: 100, y: 300 }, { x: 160, y: 300 }, 1);
      advanceTwoFingerTouch(track, { x: 60, y: 300 }, { x: 200, y: 300 }, IDENTITY);
      expect(track.gesture).toBe("pinch");
      expect(resolveTwoFingerEnd(track, VIDEO, IDENTITY, mode, CURSOR)).toEqual([]);
    }
  });

  it("two fingers held longer than a tap are not a right click", () => {
    const track = twoFingerTapAround({ x: 200, y: 350 }, 1);
    track.startTime -= TAP_MAX_DURATION_MS + 50;
    expect(resolveTwoFingerEnd(track, VIDEO, IDENTITY, "mouse", CURSOR)).toEqual([]);
    expect(resolveTwoFingerEnd(track, VIDEO, IDENTITY, "touch", CURSOR)).toEqual([]);
  });
});

describe("one-finger tap = left click", () => {
  it("mouse mode clicks at the cursor wherever the finger taps, zoomed or not", () => {
    for (const t of [IDENTITY, ZOOMED]) {
      const p = screenPoint(0.1, 0.9, t);
      const track = beginSingleTouch(p.x, p.y, VIDEO);
      const msgs = resolveSingleTouchEnd(track, p.x, p.y, "mouse", t, CURSOR);
      expect(msgs[0]).toMatchObject({ button: "left", down: true, ...CURSOR });
    }
  });

  it("touch mode clicks the tapped point, zoomed or not", () => {
    for (const t of [IDENTITY, ZOOMED]) {
      const p = screenPoint(0.42, 0.58, t);
      const track = beginSingleTouch(p.x, p.y, VIDEO);
      const [down] = resolveSingleTouchEnd(track, p.x, p.y, "touch", t, CURSOR);
      expect(down).toMatchObject({ button: "left", down: true });
      expect(down!.xFrac as number).toBeCloseTo(0.42, 6);
      expect(down!.yFrac as number).toBeCloseTo(0.58, 6);
    }
  });
});

describe("long press and the Right click button aim like a tap", () => {
  it("a long press right-clicks at the finger in touch mode and at the cursor in mouse mode, zoomed", () => {
    const p = screenPoint(0.3, 0.6, ZOOMED);
    const touchHold = resolveLongPress(beginSingleTouch(p.x, p.y, VIDEO), "touch", ZOOMED, CURSOR)!;
    expect(touchHold.at.xFrac).toBeCloseTo(0.3, 6);
    expect(touchHold.at.yFrac).toBeCloseTo(0.6, 6);
    expect(touchHold.messages[0]).toMatchObject({ button: "right", down: true });
    expect(resolveLongPress(beginSingleTouch(p.x, p.y, VIDEO), "mouse", ZOOMED, CURSOR)!.at).toEqual(CURSOR);
  });

  it("a hold that turned into a drag is not a long press, and a long press is not also a tap", () => {
    const dragged = beginSingleTouch(100, 100, VIDEO);
    advanceSingleTouch(dragged, 140, 100, "touch", IDENTITY, CURSOR);
    expect(resolveLongPress(dragged, "touch", IDENTITY, CURSOR)).toBeNull();
    const held = beginSingleTouch(100, 100, VIDEO);
    expect(resolveLongPress(held, "touch", IDENTITY, CURSOR)).not.toBeNull();
    expect(resolveSingleTouchEnd(held, 100, 100, "touch", IDENTITY, CURSOR)).toEqual([]);
    advanceSingleTouch(held, 160, 100, "touch", IDENTITY, CURSOR);
    expect(held.moved).toBe(false); // no left-button drag after the menu opened
  });

  it("an armed tap right-clicks where a tap would left-click, zoomed", () => {
    const p = screenPoint(0.7, 0.2, ZOOMED);
    const [down] = resolveSingleTouchEnd(beginSingleTouch(p.x, p.y, VIDEO), p.x, p.y, "touch", ZOOMED, CURSOR, "right");
    expect(down).toMatchObject({ button: "right", down: true });
    expect(down!.xFrac as number).toBeCloseTo(0.7, 6);
    const [mouseDown] = resolveSingleTouchEnd(beginSingleTouch(p.x, p.y, VIDEO), p.x, p.y, "mouse", ZOOMED, CURSOR, "right");
    expect(mouseDown).toMatchObject({ button: "right", ...CURSOR });
  });
});
