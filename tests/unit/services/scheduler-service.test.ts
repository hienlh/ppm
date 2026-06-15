import { describe, it, expect, beforeEach } from "bun:test";
import { openTestDb, setDb } from "../../../src/services/db.service.ts";
import { SchedulerService, nextFireAt } from "../../../src/services/scheduler-core.ts";
import {
  insertSchedule,
  listScheduleRuns,
  getSchedule,
  setScheduleSessionId,
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
    scheduler = new SchedulerService(mockRunner);
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

  it("second tick during an active run inserts a skipped row, not a second run", async () => {
    const id = makeDueSchedule();
    scheduler.tick();
    scheduler.tick(); // first run still pending
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
    });
    failing.tick();
    await Bun.sleep(10);
    const runs = listScheduleRuns(id);
    expect(runs[0]!.status).toBe("error");
    expect(runs[0]!.error).toBe("no session");
    expect(failing.isRunning(id)).toBe(false);
  });
});
