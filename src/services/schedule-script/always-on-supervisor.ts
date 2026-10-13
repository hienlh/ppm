/**
 * Keeps the process of every enabled always-on script schedule running, the way systemd's
 * `Restart=always` kept the bots running: a process that exits for any reason other than PPM
 * stopping it — a crash, a script that returned, one that stopped answering its heartbeat —
 * starts again after 5, 10, 20, 40, 80, 160, then every 300 s, back to 5 s once a process has
 * lived 10 minutes. Turning a schedule off, deleting it, editing it or restarting it stops the
 * process and waits for it to be gone before anything starts again: never two at once.
 * Each process's life is one run row, from start to exit, holding its log.
 */
import type { Schedule } from "../../types/scheduler.ts";
import { createLogger } from "../logger.ts";
import { getSchedule, getSchedules, insertFinishedRun, insertScheduleRun } from "../scheduler-db.service.ts";
import {
  closeLeftoverRuns, closeLifeRun, entryStatus, fingerprint, isAlwaysOn, newEntry, type AlwaysOnStatus, type Entry,
} from "./always-on-entry.ts";
import { reconcileLeftovers, retryBlocked } from "./instance-guard.ts";
import { cleanupAiTurns } from "./schedule-chat-db.ts";
import { launchScript, type Launch, type Launched } from "./script-launch.ts";
import { setLastError, setRestarts } from "./script-runtime-db.ts";
import type { ScriptExit } from "./script-process.ts";

export type { AlwaysOnState, AlwaysOnStatus } from "./always-on-entry.ts";

const log = createLogger("scheduler");

export const BACKOFF_MS = [5, 10, 20, 40, 80, 160, 300].map((s) => s * 1000);
/** A process that lived this long was not crash-looping: the next restart waits 5 s again. */
export const STABLE_MS = 10 * 60_000;
export const HEARTBEAT_TIMEOUT_MS = 60_000;

export interface Clock {
  now(): number;
  /** Run `fn` after `ms`; returns a cancel. */
  after(ms: number, fn: () => void): () => void;
}

const realClock: Clock = {
  now: () => Date.now(),
  after: (ms, fn) => {
    const timer = setTimeout(fn, ms);
    return () => clearTimeout(timer);
  },
};

export class AlwaysOnSupervisor {
  private entries = new Map<number, Entry>();
  private shutDown = false;

  constructor(private launch: Launch = launchScript, private clock: Clock = realClock) {}

  /** Once, before any script schedule starts: what the previous server left behind is settled. */
  async prepare(): Promise<void> {
    cleanupAiTurns();
    closeLeftoverRuns();
    await reconcileLeftovers();
  }

  /** Start, stop or restart processes so that they match the schedules as saved now. */
  sync(): void {
    if (this.shutDown) return;
    const wanted = new Map(getSchedules().filter((s) => isAlwaysOn(s) && s.enabled).map((s) => [s.id, s]));
    for (const [id, entry] of [...this.entries]) {
      const schedule = wanted.get(id);
      if (!schedule) void this.stopEntry(id, "it was turned off", "remove");
      else if (entry.state === "stopping") entry.then = "restart";
      else if (fingerprint(schedule) !== entry.fingerprint) {
        if (entry.state === "running") void this.stopEntry(id, "it was edited", "restart");
        else this.start(schedule);
      }
    }
    for (const schedule of wanted.values()) if (!this.entries.has(schedule.id)) this.start(schedule);
  }

  /** Stop the process and start it again at once, with the backoff back at its start. */
  async restart(id: number): Promise<void> {
    const schedule = getSchedule(id);
    if (!schedule || !isAlwaysOn(schedule)) throw new Error(`Schedule ${id} is not an always-on script`);
    if (!schedule.enabled) throw new Error("Turn the schedule on to start it");
    await retryBlocked(id);
    const entry = this.entries.get(id);
    if (entry) entry.crashes = 0;
    if (entry?.run) return this.stopEntry(id, "it was restarted", "restart");
    entry?.cancelRestart?.();
    this.start(schedule);
  }

  /** Stop the process and wait until it is gone, for a schedule about to be deleted. */
  stop(id: number): Promise<void> {
    return this.stopEntry(id, "it was deleted", "remove");
  }

  /**
   * PPM is going away and cannot wait: every process is told to stop (and dies with PPM's
   * stdin anyway), and each one's run row is closed with the log it has so far.
   */
  stopAll(reason: string): void {
    this.shutDown = true;
    for (const entry of this.entries.values()) {
      entry.cancelRestart?.();
      if (!entry.run) continue;
      entry.state = "stopping";
      entry.then = "remove";
      closeLifeRun(entry, entry.run, null);
      void entry.run.child.stop(reason);
    }
  }

  isRunning(id: number): boolean {
    return this.entries.get(id)?.state === "running";
  }

  status(id: number): AlwaysOnStatus | null {
    const entry = this.entries.get(id);
    return entry ? entryStatus(entry) : null;
  }

  private start(schedule: Schedule): void {
    let entry = this.entries.get(schedule.id);
    if (!entry) this.entries.set(schedule.id, (entry = newEntry()));
    entry.cancelRestart?.();
    entry.cancelRestart = null;
    entry.restartAt = null;
    entry.fingerprint = fingerprint(schedule);
    const run = this.launch(schedule, { heartbeatTimeoutMs: HEARTBEAT_TIMEOUT_MS });
    if ("error" in run) {
      // Not retried on a timer: nothing changes until the schedule is edited or restarted.
      entry.state = "failed";
      entry.lastError = run.error;
      log.warn(`Schedule ${schedule.id} (${schedule.name}) could not start: ${run.error}`);
      insertFinishedRun(schedule.id, { status: "error", startedAt: this.clock.now(), output: "", error: run.error });
      setLastError(schedule.id, run.error);
      return;
    }
    entry.state = "running";
    entry.run = run;
    entry.startedAt = this.clock.now();
    entry.runId = insertScheduleRun(schedule.id, null, "running");
    log.info(`Schedule ${schedule.id} (${schedule.name}) started: pid ${run.child.pid}`);
    void run.child.exited.then((exit) => this.onExit(schedule.id, entry, run, exit));
  }

  private onExit(id: number, entry: Entry, run: Launched, exit: ScriptExit): void {
    if (entry.run !== run) return;
    entry.run = null;
    const stopping = entry.state === "stopping";
    const error = stopping || !exit.error ? null : run.mask(exit.error);
    closeLifeRun(entry, run, error);
    if (stopping) {
      entry.resolveStopped?.();
      entry.stopped = entry.resolveStopped = null;
      const schedule = entry.then === "restart" && !this.shutDown ? getSchedule(id) : null;
      if (schedule && isAlwaysOn(schedule) && schedule.enabled) this.start(schedule);
      else this.entries.delete(id);
      return;
    }
    if (this.clock.now() - entry.startedAt >= STABLE_MS) entry.crashes = 0;
    const delay = BACKOFF_MS[Math.min(entry.crashes, BACKOFF_MS.length - 1)]!;
    entry.crashes++;
    entry.state = "restarting";
    entry.lastError = error;
    entry.restartAt = this.clock.now() + delay;
    setRestarts(id, entry.crashes);
    setLastError(id, error);
    log.warn(`Schedule ${id} exited (${error?.split("\n")[0] ?? "the script returned"}); starting it again in ${delay / 1000} s`);
    entry.cancelRestart = this.clock.after(delay, () => {
      entry.cancelRestart = null;
      const schedule = getSchedule(id);
      if (schedule && isAlwaysOn(schedule) && schedule.enabled && !this.shutDown) this.start(schedule);
      else this.entries.delete(id);
    });
  }

  private stopEntry(id: number, reason: string, then: Entry["then"]): Promise<void> {
    const entry = this.entries.get(id);
    if (!entry) return Promise.resolve();
    if (entry.state === "stopping") {
      if (then === "restart") entry.then = "restart";
      else if (entry.then === "restart") entry.then = "remove";
      return entry.stopped ?? Promise.resolve();
    }
    if (entry.run) {
      entry.state = "stopping";
      entry.then = then;
      entry.stopped = new Promise((resolve) => { entry.resolveStopped = resolve; });
      log.info(`Schedule ${id}: stopping its process because ${reason}`);
      void entry.run.child.stop(reason);
      return entry.stopped;
    }
    // Waiting to restart, or failed to start: there is no process to wait for.
    entry.cancelRestart?.();
    const schedule = then === "restart" ? getSchedule(id) : null;
    if (schedule && isAlwaysOn(schedule) && schedule.enabled) this.start(schedule);
    else this.entries.delete(id);
    return Promise.resolve();
  }
}
