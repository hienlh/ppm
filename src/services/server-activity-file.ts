/**
 * The server's own word on whether a restart would cut anything, for the supervisor's memory
 * recycle (`process-recycle-policy.ts`).
 *
 * A file rather than a route: the supervisor already reads the server's other state from the PPM
 * folder, and an endpoint would need either auth the supervisor does not hold or a public answer
 * to "is anyone working right now". One file per server pid, so a report a previous server left
 * behind can never be read as the current one's; the server deletes its own on exit and the
 * reader ignores any report older than `ACTIVITY_MAX_AGE_MS`.
 */
import { readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ServerActivity } from "./process-recycle-policy.ts";

export const SERVER_ACTIVITY_INTERVAL_MS = 30_000;
/** A terminal that printed within this window counts as in use: a build or a dev server may be running in it. */
export const TERMINAL_ACTIVE_MS = 15 * 60_000;

export const serverActivityPath = (ppmDir: string, pid: number) => join(ppmDir, `server-activity.${pid}.json`);

export function writeServerActivity(ppmDir: string, activity: ServerActivity): void {
  const path = serverActivityPath(ppmDir, activity.pid);
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(activity));
  renameSync(tmp, path);
}

export function removeServerActivity(ppmDir: string, pid: number): void {
  try { unlinkSync(serverActivityPath(ppmDir, pid)); } catch { /* never written, or already gone */ }
}

/**
 * Removes the reports earlier servers left. On Windows the supervisor ends a server with
 * TerminateProcess, so its own exit handler never deletes its file.
 */
export function removeOtherServerActivity(ppmDir: string, keepPid: number): void {
  try {
    for (const name of readdirSync(ppmDir)) {
      const m = /^server-activity\.(\d+)\.json(\.tmp)?$/.exec(name);
      if (m && Number(m[1]) !== keepPid) { try { unlinkSync(join(ppmDir, name)); } catch { /* in use or gone */ } }
    }
  } catch { /* folder unreadable: nothing to tidy */ }
}

/** The report for `pid`, or null when there is none or it cannot be read. */
export function readServerActivity(ppmDir: string, pid: number): ServerActivity | null {
  try {
    const raw = JSON.parse(readFileSync(serverActivityPath(ppmDir, pid), "utf8")) as Partial<ServerActivity>;
    if (raw.pid !== pid || typeof raw.at !== "number" || typeof raw.busy !== "boolean") return null;
    return {
      pid,
      at: raw.at,
      busy: raw.busy,
      ...(typeof raw.quietSince === "number" ? { quietSince: raw.quietSince } : {}),
      ...(Array.isArray(raw.reasons) ? { reasons: raw.reasons.filter((r): r is string => typeof r === "string") } : {}),
    };
  } catch {
    return null;
  }
}

/** What is running right now, as counts the server gathers each tick. */
export interface ActivityCounts {
  /** Chats with a turn running, a card waiting, a message arriving or queued, or background work. */
  busyChats: number;
  /** Terminals that printed within `TERMINAL_ACTIVE_MS`. */
  activeTerminals: number;
  /** Open remote desktop sessions. */
  remoteDesktopSessions: number;
}

/** Folds this tick's counts into a report, carrying `quietSince` from the previous one. */
export function nextServerActivity(pid: number, now: number, counts: ActivityCounts, previous: ServerActivity | null): ServerActivity {
  const reasons: string[] = [];
  if (counts.busyChats > 0) reasons.push(`${counts.busyChats} chat(s) working`);
  if (counts.activeTerminals > 0) reasons.push(`${counts.activeTerminals} terminal(s) printed in the last ${TERMINAL_ACTIVE_MS / 60_000} min`);
  if (counts.remoteDesktopSessions > 0) reasons.push(`${counts.remoteDesktopSessions} remote desktop session(s) open`);
  if (reasons.length > 0) return { pid, at: now, busy: true, reasons };
  const quietSince = previous && !previous.busy && previous.quietSince !== undefined ? previous.quietSince : now;
  return { pid, at: now, busy: false, quietSince };
}
