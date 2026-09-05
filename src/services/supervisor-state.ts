/**
 * Supervisor state machine — state transitions, IPC command file, signal handling.
 * Extracted from supervisor.ts to keep the orchestrator lean.
 */
import { resolve } from "node:path";
import {
  readFileSync, writeFileSync, existsSync, unlinkSync, renameSync, openSync, closeSync,
} from "node:fs";
import { constants } from "node:fs";
import { getPpmDir } from "./ppm-dir.ts";

export const CMD_FILE = () => resolve(getPpmDir(), ".supervisor-cmd");
export const STATUS_FILE = () => resolve(getPpmDir(), "status.json");
export const PID_FILE = () => resolve(getPpmDir(), "ppm.pid");
export const LOCK_FILE = () => resolve(getPpmDir(), ".start-lock");

// ─── State ─────────────────────────────────────────────────────────────
export type SupervisorState = "running" | "paused" | "stopped" | "upgrading";

let _state: SupervisorState = "running";
let _resumeResolve: (() => void) | null = null;

export function getState(): SupervisorState { return _state; }

export function setState(s: SupervisorState) { _state = s; }

export function waitForResume(): Promise<void> {
  return new Promise((res) => { _resumeResolve = res; });
}

export function triggerResume(): void {
  if (_resumeResolve) {
    _resumeResolve();
    _resumeResolve = null;
  }
}

// ─── Status file helpers ───────────────────────────────────────────────

/** Atomic write: write to tmp file then rename (prevents partial-read races across processes) */
function atomicWriteJson(filePath: string, data: unknown) {
  const tmp = filePath + ".tmp." + process.pid;
  writeFileSync(tmp, JSON.stringify(data));
  renameSync(tmp, filePath);
}

export function readStatus(): Record<string, unknown> {
  try {
    if (existsSync(STATUS_FILE())) return JSON.parse(readFileSync(STATUS_FILE(), "utf-8"));
  } catch {}
  return {};
}

export function updateStatus(patch: Record<string, unknown>) {
  try {
    const data = { ...readStatus(), ...patch };
    atomicWriteJson(STATUS_FILE(), data);
  } catch (e) {
    // Log to stderr so failures are visible in ppm.log
    try { process.stderr.write(`[updateStatus] Failed to write status.json: ${e}\n`); } catch {}
  }
}

/** Full write — replaces entire status.json (use at supervisor startup to clear stale data) */
export function writeStatus(data: Record<string, unknown>) {
  try {
    atomicWriteJson(STATUS_FILE(), data);
  } catch (e) {
    try { process.stderr.write(`[writeStatus] Failed to write status.json: ${e}\n`); } catch {}
  }
}

// ─── Command file protocol ─────────────────────────────────────────────
// "upgrade" is written directly by upgrade.service.ts (bypasses writeCmd, same
// as restart.ts/stop.ts) and read by supervisor.ts's Windows poll loop — listed
// here so the type matches what's actually read/written on disk.
export type CmdAction = "soft_stop" | "resume" | "restart" | "retunnel" | "upgrade";

/** Atomically claim + read command file (rename to .claimed, read, delete) */
export function readAndDeleteCmd(): { action: CmdAction } | null {
  const claimed = CMD_FILE() + ".claimed";
  try {
    renameSync(CMD_FILE(), claimed); // atomic claim — second caller gets ENOENT
    const cmd = JSON.parse(readFileSync(claimed, "utf-8"));
    unlinkSync(claimed);
    return cmd;
  } catch {
    // No command file or already claimed by another handler
    try { unlinkSync(claimed); } catch {}
    return null;
  }
}

/**
 * `retunnel` is the only low-priority action — it always yields to whatever
 * is already pending, since a named-tunnel reload can wait behind a genuine
 * lifecycle transition. The other three outrank it: a `resume` stuck behind
 * an unclaimed `retunnel` would otherwise leave the server looking stopped
 * (win32's poll loop is 1s; POSIX has a write/SIGUSR2 gap) for no reason.
 */
const LIFECYCLE_ACTIONS: readonly CmdAction[] = ["resume", "soft_stop", "restart", "upgrade"];

/**
 * Write `.supervisor-cmd`, but never clobber a *different* action that's still
 * unclaimed — with one exception: a lifecycle action (`resume`/`soft_stop`/
 * `restart`/`upgrade`) always overwrites a pending `retunnel`. Any other
 * collision (two different lifecycle actions, or a `retunnel` behind a
 * pending lifecycle action) returns `false` without writing so the caller can
 * report "busy" instead of silently discarding someone else's request; a
 * warning is logged either way so a dropped command is never silent. Note:
 * `restart.ts`/`stop.ts` write this file directly and bypass this peek
 * entirely, so the supervisor's dispatcher must still treat a stale/racing
 * action defensively regardless of who wrote it — this is a best-effort
 * single-slot guard, not a full queue.
 */
export function writeCmd(action: CmdAction): boolean {
  try {
    const existing = JSON.parse(readFileSync(CMD_FILE(), "utf-8")) as { action?: string };
    if (existing?.action && existing.action !== action) {
      const lifecycleOverridesRetunnel = LIFECYCLE_ACTIONS.includes(action) && existing.action === "retunnel";
      if (!lifecycleOverridesRetunnel) {
        try { process.stderr.write(`[writeCmd] dropped "${action}" — "${existing.action}" is already pending\n`); } catch {}
        return false;
      }
    }
  } catch {
    // Missing file, unreadable, or invalid JSON — nothing unclaimed to protect.
  }
  writeFileSync(CMD_FILE(), JSON.stringify({ action }));
  return true;
}

/**
 * Ask the running supervisor to reload the tunnel (e.g. after a named-tunnel
 * setup/disable). POSIX confirms the supervisor is alive via a zero-signal
 * probe before writing; win32 has no equivalent probe here, so it relies on
 * the supervisor's existing 1s command-file poll loop to pick up the request.
 */
export function requestTunnelReload(): "sent" | "busy" | "no-supervisor" {
  const status = readStatus();
  const pid = status.supervisorPid as number | undefined;
  if (!pid) return "no-supervisor";

  if (process.platform !== "win32") {
    try {
      process.kill(pid, 0);
    } catch {
      return "no-supervisor";
    }
  }

  if (!writeCmd("retunnel")) return "busy";

  if (process.platform !== "win32") {
    try { process.kill(pid, "SIGUSR2"); } catch { /* best-effort; poll loop is the fallback path */ }
  }
  return "sent";
}

// ─── Lockfile ──────────────────────────────────────────────────────────
export function acquireLock(): boolean {
  try {
    // Try exclusive create — fails if file already exists (atomic)
    const fd = openSync(LOCK_FILE(), "wx");
    writeFileSync(fd, String(process.pid));
    closeSync(fd);
    return true;
  } catch {
    // File exists — check if holding process is alive
    try {
      const pid = parseInt(readFileSync(LOCK_FILE(), "utf-8").trim(), 10);
      if (!isNaN(pid)) {
        try { process.kill(pid, 0); return false; } catch {} // stale lock
      }
      // Stale lock — overwrite
      writeFileSync(LOCK_FILE(), String(process.pid));
      return true;
    } catch { return false; }
  }
}

export function releaseLock() {
  try { unlinkSync(LOCK_FILE()); } catch {}
}
