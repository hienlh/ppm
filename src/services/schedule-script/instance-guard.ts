/**
 * At most one child per script schedule, ever — the first rule of the bots these replace.
 *
 * In this process, a second start is refused while a child is alive. Across a server restart,
 * each child is recorded with its pid and a random token it carries in its environment
 * (`PPM_SCHEDULE_RUN`); before anything starts, `reconcileLeftovers()` looks at every recorded
 * child still alive. Provably ours → killed, and waited for. Provably someone else's (after a
 * reboot pids come round again) → forgotten. Unknowable and still alive after a wait → that
 * schedule is blocked rather than started a second time: zero instances beats two.
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createLogger } from "../logger.ts";
import { ScriptProcess, type SpawnScriptOptions } from "./script-process.ts";
import { clearRuntimeChild, recordExit, recordSpawn, runtimeRowsWithChild } from "./script-runtime-db.ts";

const log = createLogger("schedule-script");

const live = new Map<number, ScriptProcess>();
/** Schedules that must not start: the pid of a previous child that could not be stopped. */
const blocked = new Map<number, number>();

export const liveScript = (scheduleId: number): ScriptProcess | null => live.get(scheduleId) ?? null;
export const blockedBy = (scheduleId: number): number | null => blocked.get(scheduleId) ?? null;
export const liveScriptIds = (): number[] => [...live.keys()];

/** Start the schedule's child, or return null when one is already running or the schedule is blocked. */
export function startScript(scheduleId: number, opts: Omit<SpawnScriptOptions, "token">): ScriptProcess | null {
  if (live.has(scheduleId) || blocked.has(scheduleId)) return null;
  const token = randomUUID();
  const child = new ScriptProcess({ ...opts, token });
  live.set(scheduleId, child);
  recordSpawn(scheduleId, child.pid, token);
  void child.exited.then(() => {
    if (live.get(scheduleId) === child) live.delete(scheduleId);
    try { recordExit(scheduleId, token); } catch (e) { log.warn(`could not record the exit of schedule ${scheduleId}'s child:`, e); }
  });
  return child;
}

/** Abort every child's `ctx.signal`; for a shutdown, which cannot wait. Their stdin closes when PPM exits. */
export function signalAllScripts(reason: string): void {
  for (const child of live.values()) void child.stop(reason);
}

export type Ownership = "ours" | "not-ours" | "unknown";

/** Whether the live process `pid` is a child PPM started with `token`. */
export function ownership(pid: number, token: string): Ownership {
  const marker = `PPM_SCHEDULE_RUN=${token}`;
  if (process.platform === "linux") {
    try {
      return readFileSync(`/proc/${pid}/environ`, "utf8").split("\0").includes(marker) ? "ours" : "not-ours";
    } catch (e) {
      // EACCES: another user's process, which a child of ours never is. ENOENT: gone meanwhile.
      const code = (e as NodeJS.ErrnoException).code;
      return code === "EACCES" || code === "ENOENT" ? "not-ours" : "unknown";
    }
  }
  if (process.platform === "darwin") {
    const ps = Bun.spawnSync(["ps", "-E", "-p", String(pid), "-o", "command="]);
    if (ps.exitCode !== 0) return "unknown";
    return ps.stdout.toString().includes(marker) ? "ours" : "not-ours";
  }
  return "unknown";
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

async function waitGone(pid: number, ms: number): Promise<boolean> {
  const until = Date.now() + ms;
  while (isAlive(pid)) {
    if (Date.now() >= until) return false;
    await Bun.sleep(50);
  }
  return true;
}

/** Decide about one recorded child; true when the schedule is free to start. */
async function settleLeftover(
  scheduleId: number, pid: number, token: string | null, waits: LeftoverWaits, owner: typeof ownership,
): Promise<boolean> {
  if (!isAlive(pid)) return true;
  const verdict = token ? owner(pid, token) : "unknown";
  if (verdict === "not-ours") return true;
  if (verdict === "ours") {
    log.warn(`Schedule ${scheduleId}: killing child ${pid}, left running by the previous server`);
    try { process.kill(pid, "SIGKILL"); } catch { /* gone meanwhile */ }
    return waitGone(pid, waits.killMs);
  }
  return waitGone(pid, waits.unknownMs);
}

export interface LeftoverWaits { killMs: number; unknownMs: number }

/** Run before any schedule starts. Children of a previous server are stopped or block their schedule. */
export async function reconcileLeftovers(
  waits: LeftoverWaits = { killMs: 5_000, unknownMs: 10_000 },
  owner: typeof ownership = ownership,
): Promise<void> {
  await Promise.all(runtimeRowsWithChild().map(async (row) => {
    const pid = row.pid!;
    if (await settleLeftover(row.schedule_id, pid, row.token, waits, owner)) {
      clearRuntimeChild(row.schedule_id);
      blocked.delete(row.schedule_id);
    } else {
      blocked.set(row.schedule_id, pid);
      log.error(`Schedule ${row.schedule_id} will not start: its previous child ${pid} is still running and could not be stopped`);
    }
  }));
}

/** Look again at a blocked schedule (on an explicit start); true when it may start now. */
export async function retryBlocked(scheduleId: number): Promise<boolean> {
  const pid = blocked.get(scheduleId);
  if (pid === undefined) return true;
  if (isAlive(pid)) return false;
  blocked.delete(scheduleId);
  clearRuntimeChild(scheduleId);
  return true;
}
