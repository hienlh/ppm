import { appendFileSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { uptime as osUptime } from "node:os";
import { resolve } from "node:path";
import { getPpmDir } from "../ppm-dir.ts";
import { decideEnsure, type EnsureAction, type WatchdogState } from "./ensure-supervisor-decision.ts";

/**
 * `ppm __ensure_supervisor__`: one run of PPM's watchdog task (`ensure-supervisor-decision.ts`
 * says what it decides and why). Started hidden by the Windows Task Scheduler at logon and every
 * 2 minutes, so a run that finds PPM up must cost next to nothing: it reads `status.json` and one
 * process list and exits, without opening the database or loading the CLI. Only a run that has
 * to act loads the config, and only a start loads the server's start path.
 *
 * Never kills anything. Starting goes through `startServer`, exactly as `ppm start` does.
 */

const STATE_FILE = "watchdog-state.json";
/** Image names a live supervisor runs under: Bun from source, the compiled `ppm` binary. */
const SUPERVISOR_IMAGES = new Set(["bun", "ppm"]);

function readJson<T>(file: string): T | null {
  try { return JSON.parse(readFileSync(file, "utf-8").replace(/^﻿/, "")) as T; } catch { return null; }
}

function writeState(dir: string, state: WatchdogState): void {
  try {
    const file = resolve(dir, STATE_FILE);
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(state));
    renameSync(tmp, file);
  } catch { /* the next run starts from what is there */ }
}

function logLine(dir: string, level: "INFO" | "WARN" | "ERROR", msg: string): void {
  try { appendFileSync(resolve(dir, "ppm.log"), `[${new Date().toISOString()}] [${level}] [watchdog] ${msg}\n`); } catch { /* no log */ }
}

/** Whether `pid` is alive and runs under a supervisor's image. False when unreadable. */
async function supervisorRuns(pid: unknown): Promise<boolean> {
  if (typeof pid !== "number" || pid <= 0) return false;
  try { process.kill(pid, 0); } catch { return false; }
  const { readProcessList } = await import("../process-tree-memory.ts");
  const list = await readProcessList(pid);
  // Unreadable list: trust liveness rather than start a second supervisor on top of a live one.
  if (!list) return true;
  const p = list.find((x) => x.pid === pid);
  return !!p && SUPERVISOR_IMAGES.has(p.name);
}

export async function runEnsureSupervisor(): Promise<EnsureAction> {
  const dir = getPpmDir();
  const statusFile = resolve(dir, "status.json");
  const status = readJson<Record<string, unknown>>(statusFile);
  let statusAgeMs: number | null = null;
  try { statusAgeMs = Date.now() - statSync(statusFile).mtimeMs; } catch { /* none */ }
  const state = readJson<WatchdogState>(resolve(dir, STATE_FILE)) ?? { starts: [] };
  if (!Array.isArray(state.starts)) state.starts = [];
  const now = Date.now();
  let bootAt: number | null = null;
  try { bootAt = now - osUptime() * 1000; } catch { /* unknown */ }
  const supervisorAlive = await supervisorRuns(status?.supervisorPid);

  // The common run, PPM up: no config, no database.
  let freeMB: number | null = null;
  let blockFreeGB = 0;
  if (!supervisorAlive && status) {
    const { readSystemCommit } = await import("../system-commit.ts");
    freeMB = (await readSystemCommit())?.freeMB ?? null;
    blockFreeGB = await configuredBlockFreeGB();
  }

  const { decision, state: next } = decideEnsure({
    now, bootAt, statusState: typeof status?.state === "string" ? status.state : null, statusAgeMs,
    supervisorAlive, state, freeMB, blockFreeGB,
  });
  writeState(dir, next);

  switch (decision.action) {
    case "none":
      return decision;
    case "wait":
      logLine(dir, "WARN", `PPM is not running, but only ${freeMB} MB of commit is free (under ${blockFreeGB} GB): waiting ${Math.round(decision.waitedMs / 1000)}s so far before starting it`);
      return decision;
    case "give-up":
      logLine(dir, "ERROR", `PPM was started ${decision.starts} times in 30 minutes and is down again: not starting it again for now`);
      await notifyGaveUp(decision.starts);
      return decision;
    case "start": {
      const waited = decision.afterWaitMs !== undefined ? ` after waiting ${Math.round(decision.afterWaitMs / 1000)}s for memory` : "";
      logLine(dir, "WARN", `PPM is not running (${decision.why === "boot" ? "first run since the machine started" : "its last run did not stop"}) — starting it${waited}`);
      await startPpm(dir, status, decision);
      return decision;
    }
  }
}

async function configuredBlockFreeGB(): Promise<number> {
  try {
    const { configService } = await import("../config.service.ts");
    configService.load();
    const { memoryGuardSettings } = await import("../../shared/memory-guard.ts");
    return memoryGuardSettings(configService.get("ai") as never).blockFreeGB;
  } catch {
    const { DEFAULT_MEMORY_BLOCK_FREE_GB } = await import("../../shared/memory-guard.ts");
    return DEFAULT_MEMORY_BLOCK_FREE_GB;
  }
}

async function notifyGaveUp(starts: number): Promise<void> {
  try {
    const { configService } = await import("../config.service.ts");
    configService.load();
    const { notificationService } = await import("../notification.service.ts");
    await notificationService.broadcast("memory", {
      title: "PPM is down",
      body: `PPM went down ${starts} times in 30 minutes; its watchdog stopped restarting it for now. Start it with 'ppm start' once the machine has memory again.`,
      project: "",
      sessionId: "",
    }, { coalesceKey: "watchdog-gave-up" });
  } catch { /* nothing else to tell it with */ }
}

async function startPpm(dir: string, status: Record<string, unknown> | null, decision: Extract<EnsureAction, { action: "start" }>): Promise<void> {
  const { writeRestartRequest } = await import("../restart-news/start-reason.ts");
  // Who asked: the previous run's own death (`previous-run-death.ts`) outranks this as the reason.
  writeRestartRequest(dir, decision.why === "boot"
    ? { kind: "boot", requestedBy: "PPM's watchdog task (Task Scheduler), at logon" }
    : { kind: "manual", detail: "PPM's watchdog task found PPM not running", requestedBy: "PPM's watchdog task (Task Scheduler)" });
  const auto = readJson<{ config?: { port?: number; profile?: string; minimal?: boolean } }>(resolve(dir, "autostart.json"))?.config;
  const port = typeof status?.port === "number" ? status.port : auto?.port;
  const profile = typeof status?.profile === "string" ? status.profile : auto?.profile;
  const minimal = status?.minimalMode === true || auto?.minimal === true;
  const { startServer } = await import("../../server/index.ts");
  await startServer({ port: port ? String(port) : undefined, profile: profile || undefined, minimal });
}

/** The process entry: one run, then exit (a start leaves PPM running detached, as `ppm start` does). */
export async function ensureSupervisorMain(): Promise<never> {
  try {
    await runEnsureSupervisor();
    process.exit(0);
  } catch (e) {
    try { logLine(getPpmDir(), "ERROR", `watchdog run failed: ${(e as Error).message}`); } catch { /* none */ }
    process.exit(1);
  }
}

if (import.meta.main) await ensureSupervisorMain();
