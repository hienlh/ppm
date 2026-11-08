/** What the always-on supervisor keeps per schedule, and the run row of each process's life. */
import type { Schedule } from "../../types/scheduler.ts";
import { getDb } from "../db.service.ts";
import { createLogger } from "../logger.ts";
import { updateScheduleRun } from "../scheduler-db.service.ts";
import type { Launched } from "./script-launch.ts";

const log = createLogger("scheduler");

export type AlwaysOnState = "running" | "stopping" | "restarting" | "failed";

export interface AlwaysOnStatus {
  state: AlwaysOnState;
  pid: number | null;
  since: string | null;
  restartAt: string | null;
  restarts: number;
  lastError: string | null;
}

export interface Entry {
  state: AlwaysOnState;
  run: Launched | null;
  /** Of the schedule the process was started from (or failed to start from). */
  fingerprint: string;
  startedAt: number;
  runId: number | null;
  crashes: number;
  cancelRestart: (() => void) | null;
  restartAt: number | null;
  lastError: string | null;
  /** What follows the exit of a process PPM is stopping. */
  then: "restart" | "remove";
  stopped: Promise<void> | null;
  resolveStopped: (() => void) | null;
}

export const isAlwaysOn = (s: Schedule) => s.kind === "script" && s.mode === "always-on";

/** What a running process was started from; a change means it runs out of date. The name is not part of it. */
export function fingerprint(s: Schedule): string {
  return [s.script, s.inputs_json, s.input_values_json, s.secrets_enc, s.project_path, s.provider_id, s.permission_mode].join("\0");
}

export function newEntry(): Entry {
  return {
    state: "failed", run: null, fingerprint: "", startedAt: 0, runId: null, crashes: 0, cancelRestart: null,
    restartAt: null, lastError: null, then: "remove", stopped: null, resolveStopped: null,
  };
}

export function entryStatus(e: Entry): AlwaysOnStatus {
  return {
    state: e.state,
    pid: e.run?.child.pid ?? null,
    since: e.run ? new Date(e.startedAt).toISOString() : null,
    restartAt: e.restartAt !== null ? new Date(e.restartAt).toISOString() : null,
    restarts: e.crashes,
    lastError: e.lastError,
  };
}

/** Ends the run row of a process's life with the log it printed. */
export function closeLifeRun(entry: Entry, run: Launched, error: string | null): void {
  if (entry.runId === null) return;
  try {
    updateScheduleRun(entry.runId, {
      status: error ? "error" : "done",
      output_truncated: run.log.output.toString() || null,
      error,
      cost_usd: run.costUsd() > 0 ? run.costUsd() : null,
      ended_at: new Date().toISOString(),
    });
  } catch (e) {
    log.warn(`could not record the end of run ${entry.runId}: ${(e as Error).message}`);
  }
  entry.runId = null;
}

/** A process that was running when the server went away has ended with it — not failed. */
export function closeLeftoverRuns(): void {
  getDb().query(
    `UPDATE schedule_runs SET status = 'done', ended_at = ? WHERE status = 'running'
       AND schedule_id IN (SELECT id FROM schedules WHERE kind = 'script')`,
  ).run(new Date().toISOString());
}
