import { describe, it, expect, beforeEach } from "bun:test";
import { openTestDb, setDb } from "../../../src/services/db.service.ts";
import { ScheduleBusyError, SchedulerService, nextFireAt, wakeDelay } from "../../../src/services/scheduler-core.ts";
import {
  insertSchedule,
  listScheduleRuns,
  getSchedule,
  setScheduleSessionId,
  updateSchedule,
} from "../../../src/services/scheduler-db.service.ts";
import type { Schedule, RunResult } from "../../../src/types/scheduler.ts";

// Controllable runner seam — no module mocking needed (constructor injection)
let resolveRun: ((r: RunResult) => void) | null = null;
let runnerCalls = 0;
const mockRunner = {
  ensureScheduleSession: (s: Schedule) => Promise.resolve(s.session_id ?? "sess-new"),
  runScheduleOnce: () => {
    runnerCalls++;
    return new Promise<RunResult>((resolve) => { resolveRun = resolve; });
  },
  runScriptTick: () => Promise.resolve(),
};

/** No always-on schedule in these tests. */
const noScripts = {
  prepare: () => Promise.resolve(), sync: () => {}, restart: () => Promise.resolve(),
  isRunning: () => false, stopAll: () => {},
};

/** Flush microtasks — execute() awaits ensureScheduleSession before calling the runner. */
const settle = () => Bun.sleep(5);

const finishRun = async (result: Partial<RunResult> = {}) => {
  await settle(); // ensure runScheduleOnce was reached and resolveRun assigned
  resolveRun!({ status: "done", output: "ok", ...result });
  await Bun.sleep(10); // let execute() finally blocks settle
};

function makeDueSchedule(): number {
  const id = insertSchedule({
    name: "due-job",
    cron_expr: "*/5 * * * *",
    provider_id: "claude-agent-sdk",
    project_path: "/tmp/p",
    prompt: "go",
    next_fire_at: new Date(Date.now() - 60_000).toISOString(),
  });
  setScheduleSessionId(id, "sess-1");
  return id;
}

describe("scheduler-core SchedulerService", () => {
  let scheduler: SchedulerService;

  beforeEach(() => {
    setDb(openTestDb());
    runnerCalls = 0;
    resolveRun = null;
    scheduler = new SchedulerService(mockRunner, noScripts);
  });

  it("nextFireAt computes a future ISO timestamp", () => {
    const next = nextFireAt("*/5 * * * *");
    expect(next).not.toBeNull();
    expect(new Date(next!).getTime()).toBeGreaterThan(Date.now());
  });

  it("tick fires due schedules and records a done run", async () => {
    const id = makeDueSchedule();
    scheduler.tick();
    expect(scheduler.isRunning(id)).toBe(true); // active set is synchronous
    await settle();
    expect(runnerCalls).toBe(1);

    await finishRun({ contextWindowPct: 33, costUsd: 0.01 });
    expect(scheduler.isRunning(id)).toBe(false);

    const runs = listScheduleRuns(id);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.status).toBe("done");
    expect(runs[0]!.cost_usd).toBe(0.01);

    // next_fire_at advanced into the future
    const s = getSchedule(id)!;
    expect(new Date(s.next_fire_at!).getTime()).toBeGreaterThan(Date.now() - 1000);
    expect(s.last_run_at).not.toBeNull();
  });

  it("a fire that comes while the previous run is active inserts a skipped row, not a second run", async () => {
    const id = makeDueSchedule();
    scheduler.tick();
    // The next fire comes round while the first run is still pending.
    updateSchedule(id, { next_fire_at: new Date(Date.now() - 1000).toISOString() });
    scheduler.tick();
    await settle();
    expect(runnerCalls).toBe(1);

    const runs = listScheduleRuns(id);
    expect(runs.map((r) => r.status).sort()).toEqual(["running", "skipped"]);
    await finishRun();
  });

  it("runJobNow bypasses the guard and reports wasRunning", async () => {
    const id = makeDueSchedule();
    scheduler.tick();
    await settle();
    const firstResolve = resolveRun!;
    const { runId, wasRunning } = scheduler.runJobNow(id);
    expect(wasRunning).toBe(true);
    expect(runId).toBeGreaterThan(0);
    await settle();
    expect(runnerCalls).toBe(2);
    firstResolve({ status: "done", output: "ok" });
    await finishRun();
  });

  it("keeps the guard while a second overlapping run is still active", async () => {
    const id = makeDueSchedule();
    scheduler.tick();
    await settle();
    const firstResolve = resolveRun!;
    scheduler.runJobNow(id); // overlap: refcount = 2
    await settle();

    firstResolve({ status: "done", output: "ok" }); // first finisher decrements to 1
    await Bun.sleep(10);
    expect(scheduler.isRunning(id)).toBe(true); // second run still guards the id

    await finishRun();
    expect(scheduler.isRunning(id)).toBe(false);
  });

  it("runJobNow throws for unknown schedule", () => {
    expect(() => scheduler.runJobNow(9999)).toThrow("not found");
  });

  it("records error run when runner reports failure", async () => {
    const id = makeDueSchedule();
    scheduler.tick();
    await finishRun({ status: "error", error: "kaboom" });
    const runs = listScheduleRuns(id);
    expect(runs[0]!.status).toBe("error");
    expect(runs[0]!.error).toBe("kaboom");
  });

  it("records error run when ensureScheduleSession rejects", async () => {
    const id = makeDueSchedule();
    const failing = new SchedulerService({
      ensureScheduleSession: () => Promise.reject(new Error("no session")),
      runScheduleOnce: mockRunner.runScheduleOnce,
      runScriptTick: mockRunner.runScriptTick,
    }, noScripts);
    failing.tick();
    await Bun.sleep(10);
    const runs = listScheduleRuns(id);
    expect(runs[0]!.status).toBe("error");
    expect(runs[0]!.error).toBe("no session");
    expect(failing.isRunning(id)).toBe(false);
  });

  it("a tick moves the schedule on to its next fire at once, not when the run ends", async () => {
    const id = makeDueSchedule();
    scheduler.tick();
    // Still running, and already not due: otherwise every wake-up would find it due again.
    expect(scheduler.isRunning(id)).toBe(true);
    expect(new Date(getSchedule(id)!.next_fire_at!).getTime()).toBeGreaterThan(Date.now());
    scheduler.tick();
    expect(listScheduleRuns(id)).toHaveLength(1);
    await finishRun();
  });

  it("a due schedule whose cron no longer parses stops being due instead of spinning", async () => {
    const id = makeDueSchedule();
    updateSchedule(id, { cron_expr: "not a cron" });
    scheduler.tick();
    expect(getSchedule(id)!.next_fire_at).toBeNull();
    await finishRun();
  });

  it("start() wakes for a schedule due in a few hundred ms, not at the next minute", async () => {
    const fired: number[] = [];
    const timed = new SchedulerService({
      ensureScheduleSession: (s: Schedule) => { fired.push(Date.now()); return Promise.resolve(s.session_id ?? "sess-new"); },
      runScheduleOnce: () => Promise.resolve({ status: "done", output: "" }),
      runScriptTick: mockRunner.runScriptTick,
    }, noScripts);
    timed.start();
    try {
      const due = Date.now() + 300;
      makeDueSchedule();
      updateSchedule(1, { next_fire_at: new Date(due).toISOString() });
      timed.rearm();
      await Bun.sleep(700);
      expect(fired).toHaveLength(1);
      expect(fired[0]! - due).toBeGreaterThanOrEqual(-5);
      expect(fired[0]! - due).toBeLessThan(250);
    } finally {
      timed.stop();
    }
  });
});

describe("scheduler-core with script schedules", () => {
  let ticks: Schedule[];
  let finishTick: (() => void) | null;
  let calls: string[];
  let scheduler: SchedulerService;

  const alwaysOn = {
    prepare: async () => { calls.push("prepare"); await Bun.sleep(20); calls.push("prepared"); },
    sync: () => { calls.push("sync"); },
    restart: async (id: number) => { calls.push(`restart ${id}`); },
    isRunning: (id: number) => calls.includes(`running ${id}`),
    stopAll: (reason: string) => { calls.push(`stopAll ${reason}`); },
  };

  function makeScript(fields: Partial<Parameters<typeof insertSchedule>[0]> = {}): number {
    return insertSchedule({
      name: "script-job", cron_expr: "*/5 * * * * *", provider_id: "mock", project_path: "/tmp/p", prompt: "",
      kind: "script", mode: "tick", script: "export default async () => {}",
      next_fire_at: new Date(Date.now() - 1000).toISOString(), ...fields,
    });
  }

  beforeEach(() => {
    setDb(openTestDb());
    ticks = [];
    finishTick = null;
    calls = [];
    scheduler = new SchedulerService({
      ...mockRunner,
      runScriptTick: (schedule: Schedule) => {
        ticks.push(schedule);
        return new Promise<void>((resolve) => { finishTick = resolve; });
      },
    }, alwaysOn);
  });

  it("runs a due script tick, keeps no skipped row while it runs, and moves last_run_at on", async () => {
    const id = makeScript();
    scheduler.tick();
    expect(scheduler.isRunning(id)).toBe(true);
    await settle();
    expect(ticks.map((t) => t.id)).toEqual([id]);

    updateSchedule(id, { next_fire_at: new Date(Date.now() - 1000).toISOString() });
    scheduler.tick();
    await settle();
    expect(ticks).toHaveLength(1);
    expect(listScheduleRuns(id)).toEqual([]);

    finishTick!();
    await settle();
    expect(scheduler.isRunning(id)).toBe(false);
    expect(getSchedule(id)!.last_run_at).not.toBeNull();
    expect(listScheduleRuns(id)).toEqual([]);
  });

  it("refuses run-now for a script tick still running, and starts one that is not", async () => {
    const id = makeScript({ next_fire_at: null });
    expect(scheduler.runJobNow(id)).toEqual({ runId: null, wasRunning: false });
    expect(() => scheduler.runJobNow(id)).toThrow(ScheduleBusyError);
    await settle();
    expect(ticks).toHaveLength(1);
    finishTick!();
  });

  it("never fires an always-on schedule from the timer; run-now restarts it, or refuses while it is off", async () => {
    const id = makeScript({ mode: "always-on", cron_expr: "" });
    scheduler.tick();
    await settle();
    expect(ticks).toEqual([]);
    expect(getSchedule(id)!.next_fire_at).toBeNull();

    expect(scheduler.runJobNow(id)).toEqual({ runId: null, wasRunning: false });
    await settle();
    expect(calls).toContain(`restart ${id}`);

    updateSchedule(id, { enabled: 0 });
    expect(() => scheduler.runJobNow(id)).toThrow("Turn the schedule on to start it");
  });

  it("settles leftovers before starting always-on processes, syncs on every change, stops them all on stop()", async () => {
    scheduler.start();
    try {
      scheduler.rearm(); // a change before the leftovers are settled waits for them too
      await Bun.sleep(40);
      expect(calls).toEqual(["prepare", "prepared", "sync", "sync"]);
    } finally {
      scheduler.stop();
    }
    expect(calls.at(-1)).toBe("stopAll PPM stopped");
  });
});

describe("wakeDelay", () => {
  const now = Date.parse("2026-10-12T10:00:00.000Z");
  it("sleeps until the earliest fire", () => {
    expect(wakeDelay("2026-10-12T10:00:05.000Z", now)).toBe(5000);
  });
  it("never sleeps more than a minute, so a clock jump is caught", () => {
    expect(wakeDelay("2026-10-12T11:00:00.000Z", now)).toBe(60_000);
    expect(wakeDelay(null, now)).toBe(60_000);
  });
  it("a fire already due wakes almost at once, but not in a tight loop", () => {
    expect(wakeDelay("2026-10-12T09:59:00.000Z", now)).toBe(20);
  });
});
