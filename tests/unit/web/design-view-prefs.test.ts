import { describe, expect, it } from "bun:test";
import {
  DEFAULT_CHAT_PERCENT, MAX_CHAT_PERCENT, MAX_REMEMBERED_FRAMES, MIN_CHAT_PERCENT,
  clampChatPercent, defaultDesignViewPrefs, designFrameKey, parseDesignViewPrefs, withChatPercent, withFrame, withoutVariant, withVariant,
} from "../../../src/web/lib/design/design-view-prefs";

describe("design view prefs", () => {
  it("falls back to the defaults for nothing, garbage or the wrong shape", () => {
    for (const raw of [null, "", "{", "null", "[]", "42", '"x"']) {
      expect(parseDesignViewPrefs(raw)).toEqual(defaultDesignViewPrefs());
    }
  });

  it("clamps the chat share into its range and rejects non-numbers", () => {
    expect(clampChatPercent(5)).toBe(MIN_CHAT_PERCENT);
    expect(clampChatPercent(99)).toBe(MAX_CHAT_PERCENT);
    expect(clampChatPercent(41.6)).toBe(42);
    expect(clampChatPercent("50")).toBe(DEFAULT_CHAT_PERCENT);
    expect(clampChatPercent(Number.NaN)).toBe(DEFAULT_CHAT_PERCENT);
    expect(parseDesignViewPrefs(JSON.stringify({ chatPercent: 1000 })).chatPercent).toBe(MAX_CHAT_PERCENT);
  });

  it("keeps only valid frames from a stored blob", () => {
    const prefs = parseDesignViewPrefs(JSON.stringify({ frames: { "p/a": "phone", "p/b": "watch", "p/c": 3 } }));
    expect(prefs.frames).toEqual({ "p/a": "phone" });
  });

  it("remembers the variant on screen per design, dropping stored junk", () => {
    const junk = parseDesignViewPrefs(JSON.stringify({ variants: { "p/a": "variant-2.html", "p/b": 4, "p/c": "x".repeat(500) } }));
    expect(junk.variants).toEqual({ "p/a": "variant-2.html" });
    let prefs = defaultDesignViewPrefs();
    for (let i = 0; i < MAX_REMEMBERED_FRAMES + 3; i++) prefs = withVariant(prefs, designFrameKey("p", `d${i}`), "variant-2.html");
    prefs = withVariant(prefs, designFrameKey("p", "d5"), "variant-3.html");
    const keys = Object.keys(prefs.variants);
    expect(keys).toHaveLength(MAX_REMEMBERED_FRAMES);
    expect(keys[keys.length - 1]).toBe("p/d5");
    expect(prefs.variants["p/d5"]).toBe("variant-3.html");
    const forgotten = withoutVariant(prefs, "p/d5");
    expect(forgotten.variants["p/d5"]).toBeUndefined();
    expect(Object.keys(forgotten.variants)).toHaveLength(MAX_REMEMBERED_FRAMES - 1);
    expect(withoutVariant(forgotten, "p/none")).toBe(forgotten);
    expect(parseDesignViewPrefs(JSON.stringify(prefs))).toEqual(prefs);
  });

  it("round-trips and remembers the newest frames only", () => {
    let prefs = defaultDesignViewPrefs();
    for (let i = 0; i < MAX_REMEMBERED_FRAMES + 5; i++) prefs = withFrame(prefs, designFrameKey("p", `d${i}`), "tablet");
    prefs = withFrame(prefs, designFrameKey("p", "d10"), "slide"); // touched again → newest
    const keys = Object.keys(prefs.frames);
    expect(keys).toHaveLength(MAX_REMEMBERED_FRAMES);
    expect(keys).not.toContain("p/d0");
    expect(keys[keys.length - 1]).toBe("p/d10");
    expect(parseDesignViewPrefs(JSON.stringify(withChatPercent(prefs, 55)))).toEqual({ ...prefs, chatPercent: 55 });
  });
});

describe("the design window's chat column width", () => {
  it("defaults, clamps and round-trips", async () => {
    const m = await import("../../../src/web/lib/design/design-view-prefs");
    expect(m.parseDesignViewPrefs(null).windowChatWidth).toBe(m.DEFAULT_WINDOW_CHAT_WIDTH);
    expect(m.parseDesignViewPrefs(JSON.stringify({ windowChatWidth: 9999 })).windowChatWidth).toBe(m.MAX_WINDOW_CHAT_WIDTH);
    expect(m.parseDesignViewPrefs(JSON.stringify({ windowChatWidth: 10 })).windowChatWidth).toBe(m.MIN_WINDOW_CHAT_WIDTH);
    expect(m.parseDesignViewPrefs(JSON.stringify({ windowChatWidth: "wide" })).windowChatWidth).toBe(m.DEFAULT_WINDOW_CHAT_WIDTH);
    const next = m.withWindowChatWidth(m.defaultDesignViewPrefs(), 333.4);
    expect(m.parseDesignViewPrefs(JSON.stringify(next)).windowChatWidth).toBe(333);
  });
});
