import { describe, it, expect } from "bun:test";
import {
  isCodexUsageLimit,
  codexErrorMessage,
  parseCodexUsageLimitReset,
} from "../../../src/providers/codex-app-server/codex-usage-limit.ts";

/** The refusal exactly as codex sent it when the 5-hour bucket ran out. */
const REAL_REFUSAL =
  "You've hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit " +
  "https://chatgpt.com/codex/settings/usage to purchase more credits or try again at 4:21 PM.";

describe("codex usage-limit detection", () => {
  it("recognises the refusal codex actually sends", () => {
    expect(isCodexUsageLimit(REAL_REFUSAL)).toBe(true);
  });

  it("recognises the other wordings of the same refusal", () => {
    expect(isCodexUsageLimit("You have hit your rate limit for this account")).toBe(true);
    expect(isCodexUsageLimit("Usage limit reached for gpt-5")).toBe(true);
    expect(isCodexUsageLimit("You have reached your usage limit")).toBe(true);
  });

  it("leaves unrelated failures alone", () => {
    // Each of these contains "limit" and none of them is fixed by switching account —
    // treating one as a quota refusal would park a working account for hours.
    expect(isCodexUsageLimit("context window limit exceeded")).toBe(false);
    expect(isCodexUsageLimit("file exceeds the size limit")).toBe(false);
    expect(isCodexUsageLimit("no rollout found for thread id abc")).toBe(false);
    expect(isCodexUsageLimit("")).toBe(false);
  });
});

describe("codex error message extraction", () => {
  it("reads the nested error shape", () => {
    expect(codexErrorMessage({ error: { message: "boom", code: -32600 } })).toBe("boom");
  });

  it("falls back to a flat message", () => {
    expect(codexErrorMessage({ message: "flat" })).toBe("flat");
  });

  it("yields empty string for shapes it does not recognise", () => {
    expect(codexErrorMessage(null)).toBe("");
    expect(codexErrorMessage({ error: { code: 1 } })).toBe("");
    expect(codexErrorMessage("just a string")).toBe("");
  });
});

describe("codex usage-limit reset parsing", () => {
  it("reads an absolute time out of the real refusal", () => {
    const reset = parseCodexUsageLimitReset(REAL_REFUSAL);
    expect(reset?.text).toBe("4:21 PM");
    expect(reset?.atMs).toBeGreaterThan(Date.now());
    const at = new Date(reset!.atMs!);
    expect(at.getHours()).toBe(16);
    expect(at.getMinutes()).toBe(21);
  });

  it("points at tomorrow when the time has already passed today", () => {
    const now = new Date();
    // One hour ago, phrased the way codex phrases it.
    const past = new Date(now.getTime() - 60 * 60 * 1000);
    const hh = past.getHours() % 12 === 0 ? 12 : past.getHours() % 12;
    const ampm = past.getHours() < 12 ? "AM" : "PM";
    const reset = parseCodexUsageLimitReset(`try again at ${hh}:${String(past.getMinutes()).padStart(2, "0")} ${ampm}.`);
    expect(reset?.atMs).toBeGreaterThan(Date.now());
  });

  it("reads a relative window", () => {
    const reset = parseCodexUsageLimitReset("Usage limit reached — try again in 3 hours.");
    expect(reset?.text).toBe("in 3 hours");
    const hoursOut = (reset!.atMs! - Date.now()) / 3_600_000;
    expect(hoursOut).toBeGreaterThan(2.9);
    expect(hoursOut).toBeLessThan(3.1);
  });

  it("reads the 'resets at' phrasing too", () => {
    const reset = parseCodexUsageLimitReset("Quota resets at 9am");
    expect(new Date(reset!.atMs!).getHours()).toBe(9);
  });

  it("returns null when the refusal names no reset", () => {
    // The caller treats this as "park for the default window", not "do not park" — so it
    // must be distinguishable from a parsed time rather than quietly defaulted here.
    expect(parseCodexUsageLimitReset("You've hit your usage limit.")).toBeNull();
  });
});
