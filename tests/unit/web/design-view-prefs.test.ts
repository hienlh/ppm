import { describe, expect, it } from "bun:test";
import {
  DEFAULT_CHAT_PERCENT, MAX_CHAT_PERCENT, MAX_REMEMBERED_FRAMES, MIN_CHAT_PERCENT,
  clampChatPercent, defaultDesignViewPrefs, designFrameKey, parseDesignViewPrefs, withChatPercent, withFrame,
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
