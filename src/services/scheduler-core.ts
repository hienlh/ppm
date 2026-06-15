/** Scheduler core: 60s tick, concurrency guard, run lifecycle.
 * Runner is constructor-injected so tests instantiate with mocks (no module mocking),
 * and importing this module never pulls the chat/provider/SDK chain. */
import { Cron } from "croner";
import {
  getSchedules,
  getSchedule,
  getDueSchedules,
  updateSchedule,
  insertScheduleRun,
  updateScheduleRun,
  cleanupScheduleRuns,
} from "./scheduler-db.service.ts";
import type { Schedule, RunResult } from "../types/scheduler.ts";

const TICK_MS = 60_000;

export interface SchedulerRunner {
  ensureScheduleSession(schedule: Schedule): Promise<string>;
  runScheduleOnce(schedule: Schedule, sessionId: string): Promise<RunResult>;
}

export function nextFireAt(cronExpr: string): string | null {
  return new Cron(cronExpr).nextRun()?.toISOString() ?? null;
}

export class SchedulerService {
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  // Refcount, not a Set: run-now can overlap a tick-run for the same id, and the
  // first finisher must not drop the guard while the second is still executing.
  private active = new Map<number, number>();

  constructor(private runner: SchedulerRunner) {}

  start(): void {
    if (this.tickTimer) return;
    cleanupScheduleRuns();
    // Recompute next_fire_at from now — missed runs during downtime are not caught up
    for (const s of getSchedules(true)) {
      try {
        updateSchedule(s.id, { next_fire_at: nextFireAt(s.cron_expr) });
      } catch (e) {
        console.warn(`[scheduler] invalid cron for schedule ${s.id} (${s.name}): ${(e as Error).message}`);
      }
    }
    this.tickTimer = setInterval(() => this.tick(), TICK_MS);
    console.log("[scheduler] started");
  }

  stop(): void {
    if (this.tickTimer) { clearInterval(this.tickTimer); this.tickTimer = null; }
    // In-flight runs finish naturally
  }

  isRunning(id: number): boolean {
    return (this.active.get(id) ?? 0) > 0;
  }

  listActive(): number[] {
    return [...this.active.keys()];
  }

  /** One scheduler pass — public so tests can drive it without fake timers. */
  tick(): void {
    let due: Schedule[];
    try {
      due = getDueSchedules(new Date().toISOString());
    } catch (e) {
      console.warn(`[scheduler] tick query failed: ${(e as Error).message}`);
      return;
    }
    for (const schedule of due) {
      if (this.isRunning(schedule.id)) {
        console.log(`[scheduler] skipped ${schedule.id} (${schedule.name}) — previous run still active`);
        const runId = insertScheduleRun(schedule.id, schedule.session_id, "skipped");
        updateScheduleRun(runId, { ended_at: new Date().toISOString() });
        continue;
      }
      this.fire(schedule);
    }
  }

  /** Start one run. Creates the run row synchronously; execution is fire-and-forget. */
  fire(schedule: Schedule): number {
    this.active.set(schedule.id, (this.active.get(schedule.id) ?? 0) + 1);
    const runId = insertScheduleRun(schedule.id, schedule.session_id, "running");
    void this.execute(schedule, runId).catch((e) => {
      console.warn(`[scheduler] run ${runId} crashed: ${(e as Error).message}`);
    });
    return runId;
  }

  /** Manual trigger (CLI/API). Bypasses the concurrency guard by explicit user action. */
  runJobNow(id: number): { runId: number; wasRunning: boolean } {
    const schedule = getSchedule(id);
    if (!schedule) throw new Error(`Schedule ${id} not found`);
    const wasRunning = this.isRunning(id);
    const runId = this.fire(schedule);
    return { runId, wasRunning };
  }

  private async execute(schedule: Schedule, runId: number): Promise<void> {
    try {
      const sessionId = await this.runner.ensureScheduleSession(schedule);
      if (sessionId !== schedule.session_id) {
        updateScheduleRun(runId, { session_id: sessionId });
        schedule = { ...schedule, session_id: sessionId };
      }
      const result = await this.runner.runScheduleOnce(schedule, sessionId);
      updateScheduleRun(runId, {
        status: result.status,
        output_truncated: result.output || null,
        context_window_pct: result.contextWindowPct ?? null,
        cost_usd: result.costUsd ?? null,
        error: result.error ?? null,
        rotated_to_session_id: result.rotatedToSessionId ?? null,
        ended_at: new Date().toISOString(),
      });
    } catch (e) {
      updateScheduleRun(runId, {
        status: "error",
        error: (e as Error).message,
        ended_at: new Date().toISOString(),
      });
    } finally {
      const count = (this.active.get(schedule.id) ?? 1) - 1;
      if (count <= 0) this.active.delete(schedule.id);
      else this.active.set(schedule.id, count);
      try {
        updateSchedule(schedule.id, {
          last_run_at: new Date().toISOString(),
          next_fire_at: nextFireAt(schedule.cron_expr),
        });
      } catch (e) {
        console.warn(`[scheduler] failed to advance schedule ${schedule.id}: ${(e as Error).message}`);
      }
    }
  }
}
