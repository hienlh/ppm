import { describe, expect, it } from "bun:test";
import {
  SPLIT_ENTER_WIDTH, SPLIT_LEAVE_WIDTH, initialDesignPane, isDesignLayoutOverride, nextAutoSplit, resolveDesignLayout,
  type DesignLayoutInput,
} from "../../../src/web/lib/design/design-layout-mode";
import { defaultDesignViewPrefs, parseDesignViewPrefs, withLayout } from "../../../src/web/lib/design/design-view-prefs";

const base: DesignLayoutInput = { override: "auto", isPhone: false, autoSplit: true, pane: "canvas", expanded: false };
const resolve = (patch: Partial<DesignLayoutInput>) => resolveDesignLayout({ ...base, ...patch });

describe("auto split by the tab's own width", () => {
  it("splits at or above the upper threshold and goes single below the lower one, from either state", () => {
    for (const was of [true, false]) {
      expect(nextAutoSplit(SPLIT_ENTER_WIDTH, was)).toBe(true);
      expect(nextAutoSplit(1600, was)).toBe(true);
      expect(nextAutoSplit(SPLIT_LEAVE_WIDTH - 1, was)).toBe(false);
      expect(nextAutoSplit(450, was)).toBe(false);
    }
  });

  it("keeps the previous answer inside the band, so dragging a divider through it does not flicker", () => {
    for (const width of [SPLIT_LEAVE_WIDTH, 900, SPLIT_ENTER_WIDTH - 1]) {
      expect(nextAutoSplit(width, true)).toBe(true);
      expect(nextAutoSplit(width, false)).toBe(false);
    }
    // A drag that narrows past the lower threshold and back only re-splits past the upper one.
    let split = true;
    for (const width of [1000, 920, 870, 850, 870, 920, 939, 940]) {
      split = nextAutoSplit(width, split);
      if (width === 939) expect(split).toBe(false);
    }
    expect(split).toBe(true);
  });

  it("ignores a width that is not a measurement: a parked tab measures 0", () => {
    for (const width of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(nextAutoSplit(width, true)).toBe(true);
      expect(nextAutoSplit(width, false)).toBe(false);
    }
  });
});

describe("resolving the layout", () => {
  it("auto follows the width and shows the pane toggle only when single", () => {
    expect(resolve({ autoSplit: true })).toMatchObject({ split: true, switcher: null, menuValue: "auto" });
    expect(resolve({ autoSplit: false })).toMatchObject({ split: false, pane: "canvas", switcher: "toolbar", menuValue: "auto" });
    expect(resolve({ autoSplit: false, pane: "chat" })).toMatchObject({ split: false, pane: "chat" });
  });

  it("a pinned layout holds at any width", () => {
    expect(resolve({ override: "split", autoSplit: false }).split).toBe(true);
    for (const autoSplit of [true, false]) {
      expect(resolve({ override: "canvas", autoSplit, pane: "canvas" })).toMatchObject({ split: false, switcher: "toolbar", menuValue: "canvas" });
      expect(resolve({ override: "chat", autoSplit, pane: "chat" })).toMatchObject({ split: false, menuValue: "chat" });
    }
  });

  it("the menu names the pane on screen when a single pane is pinned and the user peeks at the other", () => {
    expect(resolve({ override: "canvas", pane: "chat" }).menuValue).toBe("chat");
    expect(resolve({ override: "chat", pane: "canvas" }).menuValue).toBe("canvas");
    expect(resolve({ override: "auto", autoSplit: false, pane: "chat" }).menuValue).toBe("auto");
  });

  it("a phone is always one pane with its bottom bar, whatever this device pinned for wider windows", () => {
    for (const override of ["auto", "split", "canvas", "chat"] as const) {
      expect(resolve({ isPhone: true, override, autoSplit: true, pane: "chat" }))
        .toMatchObject({ split: false, pane: "chat", switcher: "phone" });
    }
  });

  it("expanded shows the canvas pane, whose element it is, and no switcher", () => {
    expect(resolve({ expanded: true, autoSplit: false, pane: "chat" })).toMatchObject({ split: false, pane: "canvas", switcher: null, expanded: true });
    expect(resolve({ expanded: true, isPhone: true, pane: "chat" })).toMatchObject({ pane: "canvas", switcher: null });
    expect(resolve({ expanded: true, autoSplit: true })).toMatchObject({ split: true, switcher: null });
  });

  it("a single-pane tab opens on the canvas unless the chat is pinned", () => {
    expect(initialDesignPane("auto")).toBe("canvas");
    expect(initialDesignPane("split")).toBe("canvas");
    expect(initialDesignPane("canvas")).toBe("canvas");
    expect(initialDesignPane("chat")).toBe("chat");
  });
});

describe("the remembered layout", () => {
  it("defaults to auto and rejects anything that is not a layout", () => {
    expect(defaultDesignViewPrefs().layout).toBe("auto");
    for (const layout of ["tabs", 3, null, "Split", ""]) {
      expect(isDesignLayoutOverride(layout)).toBe(false);
      expect(parseDesignViewPrefs(JSON.stringify({ layout })).layout).toBe("auto");
    }
  });

  it("round-trips a pick without touching the rest of the prefs", () => {
    const prefs = { ...defaultDesignViewPrefs(), chatPercent: 45, frames: { "p/a": "phone" as const } };
    const next = withLayout(prefs, "chat");
    expect(parseDesignViewPrefs(JSON.stringify(next))).toEqual({ ...prefs, layout: "chat" });
  });
});

describe("a design in a floating window", () => {
  it("puts the chat in its column beside the canvas whatever the width or the pinned layout", () => {
    for (const override of ["auto", "split", "canvas", "chat"] as const) {
      for (const autoSplit of [true, false]) {
        const layout = resolve({ windowed: true, override, autoSplit, pane: "chat" });
        expect(layout).toMatchObject({ windowed: true, windowChat: true, split: true, switcher: null });
      }
    }
  });

  it("shows the canvas alone when the chat column is closed or the canvas is expanded", () => {
    expect(resolve({ windowed: true, windowChat: false })).toMatchObject({ split: false, pane: "canvas", windowChat: false });
    expect(resolve({ windowed: true, expanded: true })).toMatchObject({ split: false, pane: "canvas", windowChat: false });
  });

  it("is never a window on a phone, and outside one keeps the ordinary rules", () => {
    expect(resolve({ windowed: true, isPhone: true })).toMatchObject({ windowed: false, switcher: "phone" });
    expect(resolve({})).toMatchObject({ windowed: false, windowChat: false, split: true });
  });
});
