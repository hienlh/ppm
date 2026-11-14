/** Cron fires read in a schedule's own time zone, and the one-shot rule for what follows a fire. */
import { describe, expect, it } from "bun:test";
import { Cron } from "croner";
import { followingFireAt, nextFireAt } from "../../../src/services/scheduler-timing.ts";

const at = (iso: string) => new Date(iso);

describe("nextFireAt with a time zone", () => {
  it("keeps 09:00 London across the spring change: 09:00 GMT, then 09:00 BST an hour earlier in UTC", () => {
    // BST starts at 01:00 UTC on 29 March 2026.
    expect(nextFireAt("0 9 * * *", "Europe/London", at("2026-03-27T12:00:00Z"))).toBe("2026-03-28T09:00:00.000Z");
    expect(nextFireAt("0 9 * * *", "Europe/London", at("2026-03-28T12:00:00Z"))).toBe("2026-03-29T08:00:00.000Z");
  });

  it("keeps 09:00 London across the autumn change", () => {
    // BST ends at 01:00 UTC on 25 October 2026.
    expect(nextFireAt("0 9 * * *", "Europe/London", at("2026-10-23T12:00:00Z"))).toBe("2026-10-24T08:00:00.000Z");
    expect(nextFireAt("0 9 * * *", "Europe/London", at("2026-10-24T12:00:00Z"))).toBe("2026-10-25T09:00:00.000Z");
  });

  it("reads the cron in a zone far from UTC", () => {
    expect(nextFireAt("0 9 * * *", "Asia/Saigon", at("2026-11-14T00:00:00Z"))).toBe("2026-11-14T02:00:00.000Z");
  });

  it("with no zone, fires exactly as before: in the machine's own", () => {
    const from = at("2026-11-14T00:00:00Z");
    const local = new Cron("30 7 * * 1").nextRun(from)!.toISOString();
    expect(nextFireAt("30 7 * * 1", undefined, from)).toBe(local);
    expect(nextFireAt("30 7 * * 1", null, from)).toBe(local);
  });

  it("throws on an expression that does not parse", () => {
    expect(() => nextFireAt("not a cron", "Europe/London")).toThrow();
  });
});

describe("followingFireAt", () => {
  const base = { cron_expr: "0 9 * * *", timezone: "Europe/London" };
  const from = at("2026-03-28T12:00:00Z");

  it("a one-shot session schedule has no fire after its first", () => {
    expect(followingFireAt({ ...base, kind: "session", recurring: 0 }, from)).toBeNull();
  });

  it("a recurring session schedule moves on to its next match", () => {
    expect(followingFireAt({ ...base, kind: "session", recurring: 1 }, from)).toBe("2026-03-29T08:00:00.000Z");
  });

  it("only a session schedule can be one-shot", () => {
    expect(followingFireAt({ ...base, kind: "prompt", recurring: 0 }, from)).toBe("2026-03-29T08:00:00.000Z");
  });
});
