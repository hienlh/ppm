/**
 * The limits on PPM Assistant messages to manager chats, over a fake clock: six an hour and twenty
 * a day per Assistant session in turns nobody started, never refilled by the user's messages; the
 * pair limit, restarted by them; one pause per run-out, lifted by the user's next message and
 * surviving a restart; quiet hours; duplicates dropped for an hour; secrets recognised.
 */
import { describe, expect, it } from "bun:test";
import { createAssistantSendGuards, looksLikeSecret, QUIET_HOURS_REFUSAL } from "../../../src/services/session-collab/assistant-send-guards.ts";
import { UNATTENDED_SENDS_PER_DAY, UNATTENDED_SENDS_PER_HOUR } from "../../../src/shared/assistant-limits.ts";

const A = "assistant-1";
const M = "manager-1";
const N = "manager-2";
const MIN = 60_000;

function guards(start = Date.parse("2026-11-10T01:00:00Z")) {
  const clock = { now: start, quiet: false, stored: null as string | null };
  const events: string[] = [];
  const make = () => createAssistantSendGuards({
    now: () => clock.now,
    quiet: () => clock.quiet,
    load: () => clock.stored,
    save: (json) => { clock.stored = json; },
    announce: (e) => events.push(e.type === "paused" ? `paused:${e.reason}` : "resumed"),
  });
  return { g: make(), make, clock, events };
}

describe("what survives a restart", () => {
  it("keeps the pair counts, until the user writes", () => {
    const { g, make } = guards();
    expect(g.reserveUnattended(A, M, 2).ok).toBe(true);
    expect(g.reserveUnattended(A, M, 2).ok).toBe(true);
    const restarted = make();
    expect(restarted.reserveUnattended(A, M, 2)).toMatchObject({ ok: false, reason: "pair" });
    restarted.userWrote(A);
    expect(make().reserveUnattended(A, M, 2).ok).toBe(true);
  });

  it("holds a message when quiet hours cannot be read", () => {
    const g = createAssistantSendGuards({
      now: () => Date.parse("2026-11-10T01:00:00Z"), quiet: () => { throw new Error("settings unreadable"); },
      load: () => null, save: () => {},
    });
    expect(g.reserveUnattended(A, M, 20)).toMatchObject({ ok: false, reason: "quiet", message: QUIET_HOURS_REFUSAL });
  });
});

describe("unattended budgets", () => {
  it("allows six an hour, then refuses and pauses once, whatever the managers", () => {
    const { g, clock, events } = guards();
    for (let i = 0; i < UNATTENDED_SENDS_PER_HOUR; i++) {
      expect(g.reserveUnattended(A, i % 2 ? M : N, 20).ok).toBe(true);
      clock.now += MIN;
    }
    const seventh = g.reserveUnattended(A, M, 20);
    expect(seventh).toMatchObject({ ok: false, reason: "hour", pausedNow: true });
    expect(g.reserveUnattended(A, N, 20)).toMatchObject({ ok: false, reason: "paused", pausedNow: false });
    expect(events).toEqual(["paused:hour"]);
    expect(g.usage(A)).toEqual({ hour: 6, day: 6 });
  });

  it("lifts the pause on the user's message but never refills the budget", () => {
    const { g, clock, events } = guards();
    for (let i = 0; i < UNATTENDED_SENDS_PER_HOUR; i++) g.reserveUnattended(A, M, 100);
    g.reserveUnattended(A, M, 100);
    g.userWrote(A);
    expect(g.isPaused(A)).toBe(false);
    // Still six in the last hour: the next one pauses again, and says so again.
    expect(g.reserveUnattended(A, M, 100)).toMatchObject({ ok: false, reason: "hour", pausedNow: true });
    expect(events).toEqual(["paused:hour", "resumed", "paused:hour"]);
    // An hour on, the window has moved; the pause still waits for the user.
    clock.now += 61 * MIN;
    expect(g.reserveUnattended(A, M, 100).ok).toBe(false);
    g.userWrote(A);
    expect(g.reserveUnattended(A, M, 100).ok).toBe(true);
  });

  it("caps a rolling day at twenty, and keeps the count across a restart", () => {
    const { g, make, clock } = guards();
    let sent = 0;
    while (sent < UNATTENDED_SENDS_PER_DAY) {
      if (g.reserveUnattended(A, M, 1000).ok) sent++;
      clock.now += 11 * MIN;
    }
    clock.now += 61 * MIN;
    const restarted = make();
    expect(restarted.usage(A).day).toBe(UNATTENDED_SENDS_PER_DAY);
    expect(restarted.reserveUnattended(A, M, 1000)).toMatchObject({ ok: false, reason: "day" });
    // The pause is kept too: a restart is not the user replying.
    expect(make().isPaused(A)).toBe(true);
    clock.now += 24 * 60 * MIN;
    const later = make();
    later.userWrote(A);
    expect(later.reserveUnattended(A, M, 1000).ok).toBe(true);
  });

  it("holds a pair to its limit until the user writes in either chat", () => {
    const { g, clock } = guards();
    expect(g.reserveUnattended(A, M, 2).ok).toBe(true);
    clock.now += 20 * MIN;
    expect(g.reserveUnattended(A, M, 2).ok).toBe(true);
    clock.now += 20 * MIN;
    expect(g.reserveUnattended(A, M, 2)).toMatchObject({ ok: false, reason: "pair", pausedNow: true });
    g.userWrote(M);
    // The manager's pair restarted, but only the user writing to the Assistant lifts its pause.
    expect(g.reserveUnattended(A, M, 2)).toMatchObject({ ok: false, reason: "paused" });
    g.userWrote(A);
    expect(g.reserveUnattended(A, M, 2).ok).toBe(true);
  });

  it("gives a reservation back when the message was not delivered", () => {
    const { g } = guards();
    const r = g.reserveUnattended(A, M, 1);
    if (!r.ok) throw new Error("refused");
    r.release();
    r.release();
    expect(g.usage(A).hour).toBe(0);
    expect(g.reserveUnattended(A, M, 1).ok).toBe(true);
  });

  it("refuses during quiet hours without counting or pausing", () => {
    const { g, clock, events } = guards();
    clock.quiet = true;
    expect(g.reserveUnattended(A, M, 20)).toEqual({ ok: false, reason: "quiet", message: QUIET_HOURS_REFUSAL, pausedNow: false });
    expect(g.usage(A).hour).toBe(0);
    expect(events).toEqual([]);
  });
});

describe("duplicates", () => {
  it("drops the same text to the same manager within the hour, then lets it through", () => {
    const { g, clock } = guards();
    expect(g.claimBody(A, M, "status?")).not.toBeNull();
    expect(g.claimBody(A, M, "  status?\n")).toBeNull();
    expect(g.claimBody(A, N, "status?")).not.toBeNull();
    clock.now += 61 * MIN;
    expect(g.claimBody(A, M, "status?")).not.toBeNull();
  });

  it("frees a claim whose message never went", () => {
    const { g } = guards();
    const release = g.claimBody(A, M, "status?")!;
    release();
    expect(g.claimBody(A, M, "status?")).not.toBeNull();
  });
});

describe("looksLikeSecret", () => {
  it("knows the shapes PPM hides from Telegram", () => {
    expect(looksLikeSecret("use AKIAABCDEFGHIJKLMNOP to deploy")).toBe(true);
    expect(looksLikeSecret("key sk_live_abcdefghijklmnop")).toBe(true);
    expect(looksLikeSecret("Server=db;Pwd=hunter2;")).toBe(true);
    expect(looksLikeSecret("What is the status of NX-1234?")).toBe(false);
  });
});
