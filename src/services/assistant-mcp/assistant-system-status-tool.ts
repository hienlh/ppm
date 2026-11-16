import { arch, release } from "node:os";
import { basename, dirname, resolve } from "node:path";
import type { Json } from "../mcp-http-endpoint.ts";
import { VERSION } from "../../version.ts";
import { getDbPath, getDbProfile } from "../db.service.ts";
import { readStatus } from "../supervisor-state.ts";
import { restartTimes } from "../logs/log-store.ts";
import { boundedJson } from "./assistant-system-tool-definitions.ts";

/**
 * `ppm_status`: what an Assistant used to learn with `Get-Process bun`, a `package.json` read and
 * a grep for "Server run started". Every field is PPM's own: no environment, no command line,
 * and of the database only its profile and file name, never the folder it sits in.
 */

export interface StatusDeps {
  now: () => number;
  pid: number;
  ppid: number;
  uptimeSec: () => number;
  /** Where this module runs from: a source checkout or install, or a compiled binary's virtual root. */
  moduleDir: string;
  execPath: string;
  status: () => Record<string, unknown>;
  isAlive: (pid: number) => boolean;
  restarts: (from: number) => Promise<number[]>;
}

const isAlive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; }
};

export const realStatusDeps: StatusDeps = {
  now: Date.now,
  pid: process.pid,
  ppid: process.ppid,
  uptimeSec: () => process.uptime(),
  moduleDir: import.meta.dir,
  execPath: process.execPath,
  status: readStatus,
  isAlive,
  restarts: restartTimes,
};

/**
 * The folder PPM is installed in. From source (an npm install or a checkout) this file sits at
 * `<root>/src/services/assistant-mcp`; a compiled binary reports a virtual `$bunfs` path, so its
 * own executable's folder is the install.
 */
export function installLocation(moduleDir: string, execPath: string): { kind: "source" | "binary"; folder: string } {
  if (/[$~]bunfs|~BUN/i.test(moduleDir)) return { kind: "binary", folder: dirname(execPath) };
  return { kind: "source", folder: resolve(moduleDir, "..", "..", "..") };
}

const RESTART_LOOKBACK_MS = 30 * 24 * 60 * 60 * 1000;

export async function ppmStatus(deps: StatusDeps = realStatusDeps): Promise<Json> {
  const now = deps.now();
  const uptimeSec = Math.round(deps.uptimeSec());
  const supervisorPid = deps.status().supervisorPid;
  // `status.json` is shared by every PPM using this folder (a dev server beside the live one), so
  // a supervisor counts only when it is alive and is this server's own parent.
  const supervised = typeof supervisorPid === "number" && supervisorPid === deps.ppid && deps.isAlive(supervisorPid);
  let lastRestartLogged: string | null = null;
  try {
    const times = await deps.restarts(now - RESTART_LOOKBACK_MS);
    const last = times.length ? Math.max(...times) : null;
    lastRestartLogged = last === null ? null : new Date(last).toISOString();
  } catch { /* no log yet: the field stays null */ }
  const bunVersion = (globalThis as { Bun?: { version?: string } }).Bun?.version ?? null;
  return boundedJson({
    version: VERSION,
    install: installLocation(deps.moduleDir, deps.execPath),
    server: {
      pid: deps.pid,
      startedAt: new Date(now - uptimeSec * 1000).toISOString(),
      uptimeSec,
      lastRestartLogged,
    },
    database: { profile: getDbProfile() ?? "default", file: basename(getDbPath()) },
    supervisor: { present: supervised, ...(supervised ? { pid: supervisorPid } : {}) },
    runtime: { bun: bunVersion, node: process.versions.node ?? null },
    platform: { os: process.platform, arch: arch(), release: release() },
  });
}
