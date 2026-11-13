import { describe, expect, it } from "bun:test";
import {
  claudeResetBlockedReason,
  claudeResetEarlyWarning,
  claudeResetGroups,
  claudeResetRefills,
  claudeResetResultMessage,
  claudeResetsLeft,
  parseClaudeLimitResets,
} from "../../../src/shared/claude-limit-resets.ts";
import { deserializeUsageExtra, serializeUsageExtra, usageExtraSignature } from "../../../src/shared/usage-extra.ts";
import type { ClaudeLimitResets } from "../../../src/types/chat.ts";

const NOW = Date.parse("2026-11-13T00:00:00Z");

/** The shape Anthropic answered on 2026-11-13 for an account with a full reset and two Fable resets. */
function grant(over: Record<string, unknown> = {}) {
  return {
    id: "full-reset-2611", label: "One full limit reset (November 2026)", resets_total: 1, resets_left: 1,
    starts_at: "2026-11-10T21:30:00+00:00", ends_at: "2026-12-10T22:00:00+00:00",
    clears: ["five_hour", "seven_day", "seven_day_overage_included"], paused: false, usable_now: true,
    use_requires_limit: false, percent_used: { five_hour: 16, seven_day: 34, seven_day_overage_included: 0 },
    blocking: [], arm: null, type: "full", unavailable_reason: null, gives_back_weekly: false,
    ...over,
  };
}
const fable = (id: string) => grant({
  id, label: "New model launch: one Fable reset", ends_at: "2027-03-09T07:59:00+00:00",
  clears: ["five_hour", "seven_day_overage_included"], percent_used: { five_hour: 16, seven_day_overage_included: 0 }, gives_back_weekly: true,
});
const payload = (block: Record<string, unknown>) => ({ five_hour: { utilization: 16 }, cedar_ember: block });
const eligible = (grants: unknown[], extra: Record<string, unknown> = {}) =>
  payload({ eligible: true, ineligible_reason: null, at_limit: false, exhausted: [], grants, next_grant_id: null, weekly_resets_at: null, cooldown_until: null, ...extra });

describe("parseClaudeLimitResets", () => {
  it("reads Anthropic's grants, a Fable give-back grouped as a Fable reset whatever its type", () => {
    const r = parseClaudeLimitResets(eligible([fable("launch-2610-fable"), grant(), fable("launch-2610-fable-6mo")]), NOW)!;
    expect(r.grants.map((g) => [g.id, g.kind])).toEqual([
      ["full-reset-2611", "full"], ["launch-2610-fable", "fable"], ["launch-2610-fable-6mo", "fable"],
    ]);
    expect(r.grants[0]).toMatchObject({ usableNow: true, useRequiresLimit: false, endsAt: "2026-12-10T22:00:00+00:00", percentUsed: { five_hour: 16, seven_day: 34 } });
    expect(claudeResetsLeft(r)).toBe(3);
  });

  it("offers nothing to an app Anthropic does not list resets to, or when none is left", () => {
    expect(parseClaudeLimitResets(payload({ eligible: false, ineligible_reason: "surface", grants: [] }))).toBeUndefined();
    expect(parseClaudeLimitResets({ five_hour: {} })).toBeUndefined();
    expect(parseClaudeLimitResets(eligible([grant({ resets_left: 0, usable_now: false })]), NOW)).toBeUndefined();
    expect(parseClaudeLimitResets(eligible([grant({ paused: true })]), NOW)).toBeUndefined();
    expect(parseClaudeLimitResets(eligible([grant({ ends_at: "2026-11-01T00:00:00Z" })]), NOW)).toBeUndefined();
    // An id the claim would refuse is dropped rather than offered.
    expect(parseClaudeLimitResets(eligible([grant({ id: "../x" })]), NOW)).toBeUndefined();
  });
});

describe("groups and reasons", () => {
  const resets = (grants: unknown[], extra: Record<string, unknown> = {}) => parseClaudeLimitResets(eligible(grants, extra), NOW)!;

  it("groups by kind, full first, and targets the first usable grant of each", () => {
    const groups = claudeResetGroups(resets([fable("f1"), grant(), fable("f2")]), NOW);
    expect(groups.map((g) => [g.kind, g.resetsLeft, g.target?.id])).toEqual([["full", 1, "full-reset-2611"], ["fable", 2, "f1"]]);
  });

  it("says why a reset cannot be used, in Claude Code's words", () => {
    const needsLimit = resets([grant({ usable_now: false, use_requires_limit: true })]);
    const [g] = claudeResetGroups(needsLimit, NOW);
    expect(g!.target).toBeUndefined();
    expect(g!.blockedReason).toBe("usable once you reach a limit it refills");
    const blocked = resets([grant({ usable_now: false, blocking: ["seven_day"] })]);
    expect(claudeResetBlockedReason(blocked.grants[0]!, blocked)).toBe("can't be used while you're at your weekly limit");
    const cooling = resets([grant()], { cooldown_until: "2026-11-13T00:01:00Z" });
    expect(claudeResetBlockedReason(cooling.grants[0]!, cooling)).toBe("a reset was just used, try again in a minute");
    const stuck = resets([fable("f1")].map((f) => ({ ...f, usable_now: false })), { at_limit: true, exhausted: ["seven_day_opus"] });
    expect(claudeResetBlockedReason(stuck.grants[0]!, stuck)).toBe("doesn't refill the limit you've reached");
  });

  it("names what a reset refills, and what using it early throws away", () => {
    const r = resets([grant(), fable("f1")]);
    expect(claudeResetRefills(r.grants[0]!)).toBe("5-hour and weekly limits");
    expect(claudeResetRefills(r.grants[1]!)).toBe("Fable and 5-hour limits");
    expect(claudeResetEarlyWarning(r.grants[0]!, r)).toBe("You still have 66% of your weekly limit left. Use your full reset anyway?");
    const atWall = resets([grant()], { at_limit: true, exhausted: ["five_hour"] });
    expect(claudeResetEarlyWarning(atWall.grants[0]!, atWall)).toBeNull();
  });

  it("words each claim answer, never claiming nothing was used when the answer never came", () => {
    expect(claudeResetResultMessage("Work", "reset", { kind: "fable", resetsLeft: 1 })).toBe("Work: Fable reset used. What Fable used is back in your weekly limit. 1 Fable reset left.");
    expect(claudeResetResultMessage("Work", "error")).toContain("couldn't tell whether the reset went through");
    expect(claudeResetResultMessage("Work", "unavailable", { reason: "reset_unconfirmed" })).toContain("couldn't confirm");
  });
});

describe("stored with the usage snapshot", () => {
  it("survives the JSON column, and a grant becoming unusable is a change worth a row", () => {
    const r = parseClaudeLimitResets(eligible([grant()]), NOW)!;
    const json = serializeUsageExtra({ limitResets: r });
    expect(deserializeUsageExtra(json).limitResets).toEqual(r);
    const spent: ClaudeLimitResets = { ...r, grants: [{ ...r.grants[0]!, usableNow: false }] };
    expect(usageExtraSignature(serializeUsageExtra({ limitResets: spent }))).not.toBe(usageExtraSignature(json));
    expect(usageExtraSignature(serializeUsageExtra({ limitResets: r }))).toBe(usageExtraSignature(json));
  });
});
