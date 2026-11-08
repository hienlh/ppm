/** Scheduler core: a timer armed for the next due schedule, concurrency guard, run lifecycle.
 * Runner is constructor-injected so tests instantiate with mocks (no module mocking),
 * and importing this module never pulls the chat/provider/SDK chain. */
import {
  getSchedules,
  getSchedule,
  getDueSchedules,
  getEarliestFireAt,
  updateSchedule,
  insertScheduleRun,
  updateScheduleRun,
  cleanupScheduleRuns,
} from "./scheduler-db.service.ts";
import type { AlwaysOnScripts, Schedule, SchedulerRunner } from "../types/scheduler.ts";
import { createLogger } from "./logger.ts";
import { executePromptRun } from "./scheduler-prompt-run.ts";
import { MAX_SLEEP_MS, nextFireAt, wakeDelay } from "./scheduler-timing.ts";

export { nextFireAt, wakeDelay };
export type { AlwaysOnScripts, SchedulerRunner };

const log = createLogger("scheduler");

/** A script tick asked to run while its previous one still is: two at once never run. */
export class ScheduleBusyError extends Error {}

export class SchedulerService {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private started = false;
  private ready: Promise<void> = Promise.resolve();
  // Refcount, not a Set: run-now can overlap a tick-run for the same id, and the
  // first finisher must not drop the guard while the second is still executing.
  private active = new Map<number, number>();

  constructor(private runner: SchedulerRunner, private alwaysOn: AlwaysOnScripts) {}

  start(): void {
    if (this.started) return;
    this.started = true;
    cleanupScheduleRuns();
    // Recompute next_fire_at from now — missed runs during downtime are not caught up
    for (const s of getSchedules(true)) {
      if (s.mode !== "tick") continue;
      try {
        updateSchedule(s.id, { next_fire_at: nextFireAt(s.cron_expr) });
      } catch (e) {
        log.warn(`invalid cron for schedule ${s.id} (${s.name}): ${(e as Error).message}`);
      }
    }
    this.ready = this.alwaysOn.prepare()
      .catch((e) => log.error("settling script processes left by the previous server failed:", e))
      .then(() => this.alwaysOn.sync());
    this.arm();
    log.info("started");
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    this.alwaysOn.stopAll("PPM stopped");
    log.info("stopped");
    // In-flight prompt runs finish naturally; script processes die with PPM's stdin.
  }

  /** Look again at the schedules as saved — after anything that may have changed them. */
  rearm(): void {
    if (!this.started) return;
    this.arm();
    void this.ready.then(() => this.alwaysOn.sync());
  }

  /** Sleep until the earliest due schedule, a minute at most, then tick and arm again. */
  private arm(): void {
    if (this.timer) clearTimeout(this.timer);
    let delay = MAX_SLEEP_MS;
    try {
      delay = wakeDelay(getEarliestFireAt());
    } catch (e) {
      log.warn(`could not read when the next schedule is due: ${(e as Error).message}`);
    }
    this.timer = setTimeout(() => {
      this.timer = null;
      this.tick();
      if (this.started) this.arm();
    }, delay);
  }

  /** A tick run in progress, or an always-on process running. */
  isRunning(id: number): boolean {
    return (this.active.get(id) ?? 0) > 0 || this.alwaysOn.isRunning(id);
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
      log.warn(`tick query failed: ${(e as Error).message}`);
      return;
    }
    for (const schedule of due) {
      this.advance(schedule);
      if (schedule.mode !== "tick") continue;
      if (this.isRunning(schedule.id)) {
        // A script ticking every few seconds would bury its history under these rows.
        if (schedule.kind === "script") continue;
        log.info(`skipped ${schedule.id} (${schedule.name}) — previous run still active`);
        const runId = insertScheduleRun(schedule.id, schedule.session_id, "skipped");
        updateScheduleRun(runId, { ended_at: new Date().toISOString() });
        continue;
      }
      this.fire(schedule);
    }
  }

  /**
   * Move a due schedule on to its next fire before it runs. Left in the past for as long as the
   * run lasts, it would be "due" at every wake-up, and the timer would wake at once each time.
   * A cron that no longer parses gets no next fire, so it stops being due rather than spinning.
   */
  private advance(schedule: Schedule): void {
    let next: string | null = null;
    try {
      if (schedule.mode === "tick") next = nextFireAt(schedule.cron_expr);
    } catch (e) {
      log.warn(`invalid cron for schedule ${schedule.id} (${schedule.name}): ${(e as Error).message}`);
    }
    try {
      updateSchedule(schedule.id, { next_fire_at: next });
    } catch (e) {
      log.warn(`failed to advance schedule ${schedule.id}: ${(e as Error).message}`);
    }
  }

  /** Start one run, fire-and-forget. A prompt's run row is made here; a script tick makes its own at the end, if any. */
  fire(schedule: Schedule, trigger = "tick"): number | null {
    this.active.set(schedule.id, (this.active.get(schedule.id) ?? 0) + 1);
    if (schedule.kind === "script") {
      log.debug(`Schedule ${schedule.id} (${schedule.name}) fired (${trigger})`);
      void this.ready.then(() => this.runner.runScriptTick(schedule))
        .catch((e) => log.error(`Schedule ${schedule.id} (${schedule.name}) tick crashed:`, e))
        .finally(() => this.afterRun(schedule));
      return null;
    }
    const runId = insertScheduleRun(schedule.id, schedule.session_id, "running");
    log.info(`Schedule ${schedule.id} (${schedule.name}) fired: run ${runId} (${trigger})`);
    void executePromptRun(this.runner, schedule, runId)
      // The run's outcome could not be recorded, so its row may still say "running".
      .catch((e) => log.error(`run ${runId} crashed:`, e))
      .finally(() => this.afterRun(schedule));
    return runId;
  }

  /**
   * Manual trigger (CLI/API). A prompt runs even over its previous run, by explicit user action;
   * a script tick never does (ScheduleBusyError); an always-on script is restarted.
   */
  runJobNow(id: number): { runId: number | null; wasRunning: boolean } {
    const schedule = getSchedule(id);
    if (!schedule) throw new Error(`Schedule ${id} not found`);
    const wasRunning = this.isRunning(id);
    if (schedule.kind === "script" && schedule.mode === "always-on") {
      if (!schedule.enabled) throw new Error("Turn the schedule on to start it");
      void this.ready.then(() => this.alwaysOn.restart(id))
        .catch((e) => log.warn(`Schedule ${id} could not be restarted: ${(e as Error).message}`));
      return { runId: null, wasRunning };
    }
    if (wasRunning && schedule.kind === "script") throw new ScheduleBusyError("This schedule is running now");
    return { runId: this.fire(schedule, wasRunning ? "manual, previous run still active" : "manual"), wasRunning };
  }

  /** Every run, kept or not, moves last_run_at on and the next fire after it. */
  private afterRun(schedule: Schedule): void {
    const count = (this.active.get(schedule.id) ?? 1) - 1;
    if (count <= 0) this.active.delete(schedule.id);
    else this.active.set(schedule.id, count);
    try {
      // Read again: the cron may have been edited while this ran, or the schedule deleted.
      const current = getSchedule(schedule.id);
      if (current) {
        let next: string | null | undefined;
        if (current.mode === "tick" && current.enabled) {
          try { next = nextFireAt(current.cron_expr); } catch { next = null; }
        }
        updateSchedule(schedule.id, { last_run_at: new Date().toISOString(), ...(next !== undefined && { next_fire_at: next }) });
      }
      this.rearm();
    } catch (e) {
      log.warn(`failed to advance schedule ${schedule.id}: ${(e as Error).message}`);
    }
  }
}
