/**
 * Supervisor state machine — state transitions, IPC command file, signal handling.
 * Extracted from supervisor.ts to keep the orchestrator lean.
 */
import { resolve } from "node:path";
import { homedir } from "node:os";
import {
  readFileSync, writeFileSync, existsSync, unlinkSync, renameSync, openSync, closeSync,
} from "node:fs";
import { constants } from "node:fs";

const PPM_DIR = resolve(process.env.PPM_HOME || resolve(homedir(), ".ppm"));
export const CMD_FILE = resolve(PPM_DIR, ".supervisor-cmd");
export const STATUS_FILE = resolve(PPM_DIR, "status.json");
export const PID_FILE = resolve(PPM_DIR, "ppm.pid");
export const LOCK_FILE = resolve(PPM_DIR, ".start-lock");

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
export function readStatus(): Record<string, unknown> {
  try {
    if (existsSync(STATUS_FILE)) return JSON.parse(readFileSync(STATUS_FILE, "utf-8"));
  } catch {}
  return {};
}

export function updateStatus(patch: Record<string, unknown>) {
  try {
    const data = { ...readStatus(), ...patch };
    writeFileSync(STATUS_FILE, JSON.stringify(data));
  } catch {}
}

// ─── Command file protocol ─────────────────────────────────────────────
export type CmdAction = "soft_stop" | "resume";

/** Atomically claim + read command file (rename to .claimed, read, delete) */
export function readAndDeleteCmd(): { action: CmdAction } | null {
  const claimed = CMD_FILE + ".claimed";
  try {
    renameSync(CMD_FILE, claimed); // atomic claim — second caller gets ENOENT
    const cmd = JSON.parse(readFileSync(claimed, "utf-8"));
    unlinkSync(claimed);
    return cmd;
  } catch {
    // No command file or already claimed by another handler
    try { unlinkSync(claimed); } catch {}
    return null;
  }
}

export function writeCmd(action: CmdAction) {
  writeFileSync(CMD_FILE, JSON.stringify({ action }));
}

// ─── Lockfile ──────────────────────────────────────────────────────────
export function acquireLock(): boolean {
  try {
    // Try exclusive create — fails if file already exists (atomic)
    const fd = openSync(LOCK_FILE, "wx");
    writeFileSync(fd, String(process.pid));
    closeSync(fd);
    return true;
  } catch {
    // File exists — check if holding process is alive
    try {
      const pid = parseInt(readFileSync(LOCK_FILE, "utf-8").trim(), 10);
      if (!isNaN(pid)) {
        try { process.kill(pid, 0); return false; } catch {} // stale lock
      }
      // Stale lock — overwrite
      writeFileSync(LOCK_FILE, String(process.pid));
      return true;
    } catch { return false; }
  }
}

export function releaseLock() {
  try { unlinkSync(LOCK_FILE); } catch {}
}
