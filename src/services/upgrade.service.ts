/**
 * Upgrade service — checks npm registry for latest version, compares with local,
 * detects install method, runs install command.
 */
import { resolve } from "node:path";
import { homedir } from "node:os";
import { readFileSync } from "node:fs";
import { VERSION } from "../version.ts";
import { isCompiledBinary } from "./autostart-generator.ts";

const NPM_REGISTRY_URL = "https://registry.npmjs.org/@hienlh/ppm/latest";
const FETCH_TIMEOUT_MS = 10_000;
const STATUS_FILE = resolve(process.env.PPM_HOME || resolve(homedir(), ".ppm"), "status.json");

export type InstallMethod = "bun" | "npm" | "binary";

/** Detect how PPM was installed */
export function getInstallMethod(): InstallMethod {
  if (isCompiledBinary()) return "binary";
  if (process.execPath.includes("bun")) return "bun";
  return "npm";
}

/** Compare two semver strings (ignores pre-release tags). Returns -1 (a < b), 0 (equal), 1 (a > b) */
export function compareSemver(a: string, b: string): -1 | 0 | 1 {
  // Strip pre-release suffix (e.g. "1.0.0-beta.1" → "1.0.0")
  const pa = a.split("-")[0].split(".").map(Number);
  const pb = b.split("-")[0].split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const va = pa[i] ?? 0;
    const vb = pb[i] ?? 0;
    if (va < vb) return -1;
    if (va > vb) return 1;
  }
  return 0;
}

/** Check npm registry for a newer version */
export async function checkForUpdate(): Promise<{
  available: boolean;
  current: string;
  latest: string | null;
}> {
  try {
    const res = await fetch(NPM_REGISTRY_URL, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    const data = await res.json();
    const latest = data.version as string;
    return {
      available: compareSemver(VERSION, latest) < 0,
      current: VERSION,
      latest,
    };
  } catch {
    return { available: false, current: VERSION, latest: null };
  }
}

let upgradeInProgress = false;

/** Install the latest version via bun/npm. Returns result with success/error. */
export async function applyUpgrade(): Promise<{
  success: boolean;
  error?: string;
  newVersion?: string;
}> {
  if (upgradeInProgress) {
    return { success: false, error: "Upgrade already in progress" };
  }

  const method = getInstallMethod();
  if (method === "binary") {
    return { success: false, error: "Compiled binary — upgrade via GitHub releases" };
  }

  const update = await checkForUpdate();
  if (!update.available || !update.latest) {
    return { success: false, error: "Already on latest version" };
  }

  upgradeInProgress = true;
  const pkg = `@hienlh/ppm@${update.latest}`;
  const cmd = method === "bun"
    ? ["bun", "install", "-g", pkg]
    : ["npm", "install", "-g", pkg];

  try {
    const proc = Bun.spawn({ cmd, stdout: "pipe", stderr: "pipe" });
    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      const stderr = await new Response(proc.stderr).text();
      return { success: false, error: `Install failed (exit ${exitCode}): ${stderr.slice(0, 200)}` };
    }
    return { success: true, newVersion: update.latest };
  } catch (e) {
    return { success: false, error: (e as Error).message };
  } finally {
    upgradeInProgress = false;
  }
}

/** Send SIGUSR1 to supervisor to trigger self-replace after upgrade */
export function signalSupervisorUpgrade(): { sent: boolean; error?: string } {
  try {
    const data = JSON.parse(readFileSync(STATUS_FILE, "utf-8"));
    const pid = data.supervisorPid;
    if (!pid) return { sent: false, error: "No supervisor PID" };
    process.kill(pid, 0); // check alive
    process.kill(pid, "SIGUSR1");
    return { sent: true };
  } catch (e) {
    return { sent: false, error: (e as Error).message };
  }
}
