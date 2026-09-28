/**
 * The per-model weekly limits and the reset credits must survive a trip through the
 * snapshot table, or they vanish whenever usage is served from storage instead of a
 * live fetch — i.e. right after every restart.
 */
import { describe, it, expect } from "bun:test";
import { writeStoredUsage, readStoredUsage } from "../../../src/services/provider-usage/usage-snapshot-store.ts";
import { scopedBucket } from "../../../src/shared/usage-extra.ts";
import type { UsageInfo } from "../../../src/types/chat.ts";

const weekly = (u: number) => ({ utilization: u, resetsAt: "2026-10-04T02:20:16.000Z", resetsInMinutes: null, resetsInHours: 1, windowHours: 168 });

describe("usage snapshot extras", () => {
  it("stores and reads back Fable's weekly limit and Codex reset credits", () => {
    const id = `acct-${crypto.randomUUID()}`;
    const usage: UsageInfo = {
      weekly: weekly(0.34),
      weeklyScoped: [scopedBucket({ label: "Fable", utilization: 0.03, resetsAt: "2026-10-01T09:00:00Z" })],
      resetCredits: { available: 3, nextExpiresAt: "2026-10-27T01:21:20.000Z", title: "Full reset (Weekly + 5 hr)" },
    };
    writeStoredUsage("codex", id, usage);
    const back = readStoredUsage("codex", id)!;
    expect(back.weeklyScoped?.map((b) => [b.label, b.utilization])).toEqual([["Fable", 0.03]]);
    expect(back.resetCredits).toEqual(usage.resetCredits);
  });

  it("writes a new row when only a credit was spent", () => {
    const id = `acct-${crypto.randomUUID()}`;
    writeStoredUsage("codex", id, { weekly: weekly(0), resetCredits: { available: 2 } });
    writeStoredUsage("codex", id, { weekly: weekly(0), resetCredits: { available: 1 } });
    expect(readStoredUsage("codex", id)?.resetCredits?.available).toBe(1);
  });
});
