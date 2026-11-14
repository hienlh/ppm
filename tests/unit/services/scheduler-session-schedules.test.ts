/**
 * Session schedules in the scheduler: a fire is recorded as pending and handed to the deliverer,
 * never run; fires before delivery coalesce; a fire missed while PPM was off is delivered once.
 * Prompt schedules keep their own rule: nothing missed is caught up.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { openTestDb, setDb } from "../../../src/services/db.service.ts";
import { SchedulerService } from "../../../src/services/scheduler-core.ts";
import {
  clearSessionSchedulePaused,
  countSessionSchedules,
  deleteSessionSchedulesForTarget,
  getDueSchedules,
  getEarliestFireAt,
  getSchedule,
  insertSchedule,
  listScheduleRuns,
  listSessionSchedulesForTarget,
  retargetSessionSchedules,
  setSessionSchedulePaused,
  updateSchedule,
} from "../../../src/services/scheduler-db.service.ts";
import { setSessionScheduleDueHandler } from "../../../src/services/session-schedules/session-schedule-due.ts";
import type { NewSchedule } from "../../../src/types/scheduler.ts";

let runnerCalls = 0;
const runner = {
  ensureScheduleSession: () => Promise.resolve("sess-new"),
  runScheduleOnce: () => { runnerCalls++; return Promise.resolve({ status: "done" as const, output: "" }); },
  runScriptTick: () => { runnerCalls++; return Promise.resolve(); },
};
const noScripts = {
  prepare: () => Promise.resolve(), sync: () => {}, restart: () => Promise.resolve(),
  isRunning: () => false, stopAll: () => {},
};

const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const isFuture = (iso: string | null) => iso !== null && Date.parse(iso) > Date.now();

function sessionSchedule(over: Partial<NewSchedule> = {}): number {
  return insertSchedule({
    name: "remind", cron_expr: "*/5 * * * *", provider_id: "claude-agent-sdk", project_path: "/tmp/p",
    prompt: "check the deploy", kind: "session", target_session_id: "target-session-1",
    next_fire_at: ago(60_000), ...over,
  });
}

let heard: number[];
let scheduler: SchedulerService;

beforeEach(() => {
  setDb(openTestDb());
  runnerCalls = 0;
  heard = [];
  setSessionScheduleDueHandler((id) => { heard.push(id); });
  scheduler = new SchedulerService(runner, noScripts);
});

afterEach(() => {
  scheduler.stop();
  setSessionScheduleDueHandler(null);
});

describe("a session schedule coming due", () => {
  it("records a pending fire at its scheduled time, moves on, and runs nothing", async () => {
    const due = ago(60_000);
    const id = sessionSchedule({ next_fire_at: due });
    scheduler.tick();
    await Bun.sleep(5);

    const s = getSchedule(id)!;
    expect(s.pending_since).toBe(due);
    expect(isFuture(s.next_fire_at)).toBe(true);
    expect(heard).toEqual([id]);
    expect(runnerCalls).toBe(0);
    expect(listScheduleRuns(id)).toHaveLength(0);
    expect(scheduler.isRunning(id)).toBe(false);
  });

  it("coalesces fires that pass before delivery into the one already pending", () => {
    const first = ago(600_000);
    const id = sessionSchedule({ next_fire_at: first });
    scheduler.tick();
    updateSchedule(id, { next_fire_at: ago(300_000) });
    scheduler.tick();
    updateSchedule(id, { next_fire_at: ago(1_000) });
    scheduler.tick();

    expect(getSchedule(id)!.pending_since).toBe(first);
    expect(heard).toEqual([id, id, id]);
    expect(runnerCalls).toBe(0);
  });

  it("fires a one-shot once: pending, no next fire, kept until delivered", () => {
    const id = sessionSchedule({ recurring: false });
    scheduler.tick();
    const s = getSchedule(id)!;
    expect(s.recurring).toBe(0);
    expect(s.pending_since).not.toBeNull();
    expect(s.next_fire_at).toBeNull();

    scheduler.tick();
    expect(heard).toEqual([id]);
    expect(getEarliestFireAt()).toBeNull();
  });

  it("skips a paused schedule without waking the timer for it, and an off one", () => {
    const paused = sessionSchedule();
    setSessionSchedulePaused(paused, "The chat was deleted");
    const off = sessionSchedule({ enabled: false });
    expect(getDueSchedules(new Date().toISOString())).toHaveLength(0);
    expect(getEarliestFireAt()).toBeNull();

    scheduler.tick();
    expect(heard).toEqual([]);
    expect(getSchedule(paused)!.pending_since).toBeNull();
    expect(getSchedule(off)!.pending_since).toBeNull();
  });

  it("survives a deliverer that throws or rejects", async () => {
    const id = sessionSchedule();
    setSessionScheduleDueHandler(() => { throw new Error("boom"); });
    expect(() => scheduler.tick()).not.toThrow();
    setSessionScheduleDueHandler(() => Promise.reject(new Error("later boom")));
    updateSchedule(id, { next_fire_at: ago(1_000) });
    expect(() => scheduler.tick()).not.toThrow();
    await Bun.sleep(5);
    expect(getSchedule(id)!.pending_since).not.toBeNull();
  });

  it("run-now queues a fire for the chat instead of running it, and refuses a paused one", () => {
    const id = sessionSchedule({ next_fire_at: new Date(Date.now() + 3_600_000).toISOString() });
    const before = getSchedule(id)!.next_fire_at;
    expect(scheduler.runJobNow(id)).toEqual({ runId: null, wasRunning: false });
    const s = getSchedule(id)!;
    expect(s.pending_since).not.toBeNull();
    expect(s.next_fire_at).toBe(before);
    expect(heard).toEqual([id]);
    expect(runnerCalls).toBe(0);

    setSessionSchedulePaused(id, "The chat was deleted");
    expect(() => scheduler.runJobNow(id)).toThrow("paused");
  });
});

describe("starting PPM", () => {
  it("delivers a session fire missed while PPM was off exactly once, however many restarts follow", () => {
    const missed = ago(3 * 3_600_000);
    const id = sessionSchedule({ next_fire_at: missed });
    scheduler.start();

    let s = getSchedule(id)!;
    expect(s.pending_since).toBe(missed);
    expect(isFuture(s.next_fire_at)).toBe(true);
    expect(heard).toEqual([id]);

    // Restarted before the fire was delivered: still the one pending fire, handed over again.
    scheduler.stop();
    const again = new SchedulerService(runner, noScripts);
    again.start();
    s = getSchedule(id)!;
    expect(s.pending_since).toBe(missed);
    expect(heard).toEqual([id, id]);
    again.stop();
    expect(runnerCalls).toBe(0);
  });

  it("does not catch up a prompt schedule", async () => {
    const id = insertSchedule({
      name: "prompt", cron_expr: "*/5 * * * *", provider_id: "claude-agent-sdk", project_path: "/tmp/p",
      prompt: "go", next_fire_at: ago(3 * 3_600_000),
    });
    scheduler.start();
    await Bun.sleep(5);
    const s = getSchedule(id)!;
    expect(isFuture(s.next_fire_at)).toBe(true);
    expect(s.pending_since).toBeNull();
    expect(runnerCalls).toBe(0);
    expect(listScheduleRuns(id)).toHaveLength(0);
    expect(heard).toEqual([]);
  });

  it("catches up a missed one-shot once and leaves it with no next fire", () => {
    const id = sessionSchedule({ recurring: false });
    scheduler.start();
    expect(getSchedule(id)!.next_fire_at).toBeNull();
    scheduler.stop();
    const again = new SchedulerService(runner, noScripts);
    again.start();
    again.stop();
    const s = getSchedule(id)!;
    expect(s.next_fire_at).toBeNull();
    expect(s.pending_since).not.toBeNull();
  });

  it("leaves a one-shot whose fire is still ahead as it is", () => {
    const ahead = new Date(Date.now() + 3_600_000).toISOString();
    const id = sessionSchedule({ recurring: false, next_fire_at: ahead });
    scheduler.start();
    expect(getSchedule(id)!.next_fire_at).toBe(ahead);
    expect(heard).toEqual([]);
  });

  it("leaves a paused schedule alone, and hands over no pending fire for it", () => {
    const missed = ago(60_000);
    const id = sessionSchedule({ next_fire_at: missed });
    setSessionSchedulePaused(id, "The chat was deleted");
    scheduler.start();
    const s = getSchedule(id)!;
    expect(s.next_fire_at).toBe(missed);
    expect(s.pending_since).toBeNull();
    expect(heard).toEqual([]);

    clearSessionSchedulePaused(id, new Date(Date.now() + 60_000).toISOString());
    expect(getSchedule(id)!.paused_reason).toBeNull();
  });
});

describe("session schedule rows by chat", () => {
  it("lists, counts, follows a renamed chat and deletes with it", () => {
    const a = sessionSchedule();
    const b = sessionSchedule({ target_session_id: "other-session-2" });
    insertSchedule({ name: "p", cron_expr: "*/5 * * * *", provider_id: "x", project_path: "/p", prompt: "go" });

    expect(listSessionSchedulesForTarget("target-session-1").map((s) => s.id)).toEqual([a]);
    expect(countSessionSchedules("target-session-1")).toBe(1);

    expect(retargetSessionSchedules("target-session-1", "renamed-session-3")).toBe(1);
    expect(retargetSessionSchedules("renamed-session-3", "renamed-session-3")).toBe(0);
    expect(getSchedule(a)!.target_session_id).toBe("renamed-session-3");

    expect(deleteSessionSchedulesForTarget("renamed-session-3")).toBe(1);
    expect(getSchedule(a)).toBeNull();
    expect(getSchedule(b)).not.toBeNull();
  });
});
