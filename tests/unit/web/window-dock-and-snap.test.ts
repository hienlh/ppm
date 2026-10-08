// Run in Docker if the host segfaults: docker run --rm -v "$PWD":/app -w /app oven/bun bun test tests/unit/web/window-dock-and-snap.test.ts
//
// The window states the status-bar dock is built on: snapping to the right, minimizing into
// the dock and coming back in the state the window left, and how the dock squeezes its
// chips when the bar is narrow.
import { beforeEach, describe, expect, it } from "bun:test";

const memStore: Record<string, string> = {};
(globalThis as unknown as { localStorage: Storage }).localStorage = {
  getItem: (k: string) => memStore[k] ?? null,
  setItem: (k: string, v: string) => { memStore[k] = v; },
  removeItem: (k: string) => { delete memStore[k]; },
  clear: () => { for (const k of Object.keys(memStore)) delete memStore[k]; },
  key: () => null,
  length: 0,
} as Storage;

const { displayedRect, snapRect, wantsSnap, MIN_SIZE, SNAP_TRIGGER } = await import("../../../src/web/components/floating-window/window-geometry");
const { planDock } = await import("../../../src/web/components/floating-window/window-dock-layout");
const { frontWindowId, useWindowStore, windowsInOpenOrder } = await import("../../../src/web/components/floating-window/window-store");
const { loadWindowRects, saveWindowRects } = await import("../../../src/web/components/floating-window/window-persistence");

const BOUNDS = { w: 1600, h: 900 };

describe("snapping to the right", () => {
  it("fills the full height and the right share of the width", () => {
    const r = snapRect(BOUNDS);
    expect(r.y).toBe(0);
    expect(r.h).toBe(BOUNDS.h);
    expect(r.x + r.w).toBe(BOUNDS.w);
    expect(r.w).toBe(880);
  });

  it("never gets narrower than a window may be", () => {
    expect(snapRect({ w: 500, h: 400 }).w).toBe(MIN_SIZE.w);
  });

  it("arms only once the window's right edge is dragged well past the layer's", () => {
    const at = (x: number) => ({ x, y: 50, w: 600, h: 400 });
    const start = at(200);
    expect(wantsSnap(at(BOUNDS.w - 600), start, BOUNDS)).toBe(false);
    expect(wantsSnap(at(BOUNDS.w - 600 + SNAP_TRIGGER), start, BOUNDS)).toBe(false);
    expect(wantsSnap(at(BOUNDS.w - 600 + SNAP_TRIGGER + 1), start, BOUNDS)).toBe(true);
  });

  it("does not snap a window that already hangs off the right edge when it is pulled back in", () => {
    const parked = { x: BOUNDS.w - 100, y: 50, w: 600, h: 400 };
    expect(wantsSnap(parked, parked, BOUNDS)).toBe(false);
    expect(wantsSnap({ ...parked, x: parked.x - 300 }, parked, BOUNDS)).toBe(false);
    // Pushed further out on purpose, it still snaps.
    expect(wantsSnap({ ...parked, x: parked.x + SNAP_TRIGGER + 1 }, parked, BOUNDS)).toBe(true);
  });

  it("draws a snapped or maximized window by its state and keeps the restore rect", () => {
    const rect = { x: 10, y: 20, w: 500, h: 300 };
    expect(displayedRect("normal", rect, BOUNDS)).toEqual(rect);
    expect(displayedRect("maximized", rect, BOUNDS)).toEqual({ x: 0, y: 0, w: 1600, h: 900 });
    expect(displayedRect("snapped", rect, BOUNDS)).toEqual(snapRect(BOUNDS));
  });
});

describe("minimizing into the dock", () => {
  beforeEach(() => {
    for (const k of Object.keys(memStore)) delete memStore[k];
    useWindowStore.setState({ windows: {}, bounds: BOUNDS, restored: true, snapPreviewId: null });
  });

  const open = () => useWindowStore.getState().open("explorer");
  const state = (id: string) => useWindowStore.getState().windows[id]!.state;

  it("lists windows in the order they were opened, whatever their stacking", () => {
    const a = open();
    const b = open();
    const c = open();
    useWindowStore.getState().focus(a);
    expect(windowsInOpenOrder(useWindowStore.getState().windows).map((w) => w.id)).toEqual([a, b, c]);
  });

  it("never treats a minimized window as the one in front", () => {
    const a = open();
    const b = open();
    expect(frontWindowId(useWindowStore.getState().windows)).toBe(b);
    useWindowStore.getState().setState(b, "minimized");
    expect(frontWindowId(useWindowStore.getState().windows)).toBe(a);
    useWindowStore.getState().setState(a, "minimized");
    expect(frontWindowId(useWindowStore.getState().windows)).toBeNull();
  });

  it("comes back in the state it was minimized from", () => {
    const a = open();
    useWindowStore.getState().setState(a, "snapped");
    useWindowStore.getState().setState(a, "minimized");
    expect(useWindowStore.getState().windows[a]!.restoreTo).toBe("snapped");
    useWindowStore.getState().restore(a);
    expect(state(a)).toBe("snapped");
    expect(useWindowStore.getState().windows[a]!.restoreTo).toBeUndefined();
  });

  it("is brought back by any opener that focuses it", () => {
    const a = open();
    open();
    useWindowStore.getState().setState(a, "minimized");
    useWindowStore.getState().focus(a);
    expect(state(a)).toBe("normal");
    expect(frontWindowId(useWindowStore.getState().windows)).toBe(a);
  });

  it("works like a taskbar: the chip in front minimizes, any other comes forward", () => {
    const a = open();
    const b = open();
    useWindowStore.getState().activateFromDock(b);
    expect(state(b)).toBe("minimized");
    useWindowStore.getState().activateFromDock(b);
    expect(state(b)).toBe("normal");
    expect(frontWindowId(useWindowStore.getState().windows)).toBe(b);
    useWindowStore.getState().activateFromDock(a);
    expect(frontWindowId(useWindowStore.getState().windows)).toBe(a);
    expect(state(b)).toBe("normal");
  });

  it("minimizes everything at once and remembers each window's state", () => {
    const a = open();
    const b = open();
    useWindowStore.getState().setState(a, "maximized");
    useWindowStore.getState().minimizeAll();
    expect([state(a), state(b)]).toEqual(["minimized", "minimized"]);
    useWindowStore.getState().restore(a);
    expect(state(a)).toBe("maximized");
  });

  it("survives a reload with its open order and its way back", () => {
    const a = open();
    open();
    useWindowStore.getState().setState(a, "snapped");
    useWindowStore.getState().setState(a, "minimized");
    saveWindowRects(Object.values(useWindowStore.getState().windows));
    const loaded = loadWindowRects(BOUNDS);
    const restored = loaded.find((w) => w.id === a)!;
    expect(restored.state).toBe("minimized");
    expect(restored.restoreTo).toBe("snapped");
    expect(loaded.map((w) => w.opened).sort()).toEqual([0, 1]);
  });
});

describe("squeezing the dock", () => {
  const base = { iconWidth: 26, gap: 2, moreWidth: 40, maxChips: 8 };

  it("shows every title when there is room", () => {
    expect(planDock({ ...base, available: 600, fullWidths: [120, 120, 120], frontIndex: 1 })).toEqual({ mode: "full", hidden: [] });
  });

  it("drops the titles of the windows behind first, keeping the front one's", () => {
    // 3 x 120 + gaps = 364 > 300; front title + two icons = 120 + 26 + 26 + 4 = 176.
    expect(planDock({ ...base, available: 300, fullWidths: [120, 120, 120], frontIndex: 0 })).toEqual({ mode: "compact", hidden: [] });
  });

  it("folds the newest chips into +N, never the one in front", () => {
    const plan = planDock({ ...base, available: 230, fullWidths: Array(6).fill(120), frontIndex: 5 });
    expect(plan.hidden).not.toContain(5);
    expect(plan.hidden.length).toBeGreaterThan(0);
    // Folded from the newest end: the oldest windows stay in the row.
    expect(Math.min(...plan.hidden)).toBeGreaterThan(0);
  });

  it("folds past the chip limit even when the row would fit", () => {
    const plan = planDock({ ...base, maxChips: 3, available: 5000, fullWidths: Array(5).fill(60), frontIndex: 0 });
    expect(plan.hidden).toEqual([4, 3]);
  });

  it("takes the title off the front chip too when only a sliver of it would show", () => {
    const plan = planDock({ ...base, available: 120, fullWidths: Array(4).fill(140), frontIndex: 0 });
    expect(plan.mode).toBe("tight");
    expect(plan.hidden).not.toContain(0);
  });

  it("has nothing to plan with no windows", () => {
    expect(planDock({ ...base, available: 100, fullWidths: [], frontIndex: -1 })).toEqual({ mode: "full", hidden: [] });
  });
});
