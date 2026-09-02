/**
 * Upgrade service — checks npm registry for latest version, compares with local,
 * detects install method, runs install command.
 */
import { resolve, dirname } from "node:path";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { VERSION } from "../version.ts";
import { isCompiledBinary } from "./autostart-generator.ts";
import { getPpmDir } from "./ppm-dir.ts";
import { applyBinaryUpgrade } from "./binary-upgrade-apply.ts";

const NPM_REGISTRY_URL = "https://registry.npmjs.org/@hienlh/ppm/latest";
const FETCH_TIMEOUT_MS = 10_000;

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
  const pa = (a.split("-")[0] ?? "0").split(".").map(Number);
  const pb = (b.split("-")[0] ?? "0").split(".").map(Number);
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

const LATEST_VERSION_CACHE_MS = 300_000; // 5min

/** A cached registry check; `force` skips the TTL and asks the registry now. */
export type LatestVersionCheck = (opts?: { force?: boolean }) => Promise<string | null>;

/**
 * Build a cached, in-flight-deduped "what is the newest published version"
 * check. Every open UI polls the upgrade status once a minute, so an uncached
 * check would turn into one registry request per client per minute.
 *
 * The TTL throttles *attempts*, not just successes: a machine that is offline
 * or being rate-limited would otherwise re-enter a doomed 10s fetch on every
 * poll. A failed attempt keeps the last known good version rather than
 * forgetting it.
 *
 * `force` exists because the TTL is a cost control, not a correctness rule: a
 * cached answer taken seconds before a release is published would otherwise
 * withhold that release for up to the full TTL. A user-initiated check (opening
 * the upgrade popover) is rare and must see the registry as it is right now.
 */
export function createLatestVersionCheck(
  checkFn: typeof checkForUpdate = checkForUpdate,
  ttlMs = LATEST_VERSION_CACHE_MS,
): LatestVersionCheck {
  let cache: { at: number; version: string | null } | null = null;
  let inflight: Promise<string | null> | null = null;

  const remember = (version: string | null) => {
    cache = { at: Date.now(), version: version ?? cache?.version ?? null };
    return cache.version;
  };

  return function getLatestVersion(opts) {
    if (!opts?.force && cache && Date.now() - cache.at < ttlMs) return Promise.resolve(cache.version);
    // A forced check still joins a request already on the wire — that request
    // is itself live, so waiting for it is fresher than starting a second one.
    if (inflight) return inflight;
    inflight = checkFn()
      .then((r) => remember(r.latest))
      .catch(() => remember(null))
      .finally(() => { inflight = null; });
    return inflight;
  };
}

/** Newest published version — shared cache for the upgrade status endpoint. */
export const getLatestPublishedVersion = createLatestVersionCheck();

/** Resolve npm binary next to the running node runtime, falling back to bare "npm".
 *  Same rationale as bun: autostart may not have npm's bin dir on $PATH. */
function resolveNpmBin(): string {
  const binDir = dirname(process.execPath);
  const candidate = resolve(binDir, process.platform === "win32" ? "npm.cmd" : "npm");
  return existsSync(candidate) ? candidate : "npm";
}

let upgradeInProgress = false;

/** Build the global-install command. Absolute runtime path (not a bare
 *  "bun"/"npm") because autostart (launchd/systemd) may not have the runtime's
 *  bin dir on $PATH, where a bare name fails with "Executable not found". */
export function buildUpgradeCommand(method: "bun" | "npm", pkg: string): string[] {
  return method === "bun"
    ? [process.execPath, "install", "-g", pkg]
    : [resolveNpmBin(), "install", "-g", pkg];
}

/** Install the latest version. bun/npm reinstall globally; binary installs
 *  swap the on-disk file + web dir (see applyBinaryUpgrade). Deps are
 *  injectable for tests; production calls pass none. */
export async function applyUpgrade(deps?: {
  checkFn?: typeof checkForUpdate;
  spawnFn?: typeof Bun.spawn;
}): Promise<{
  success: boolean;
  error?: string;
  newVersion?: string;
}> {
  if (upgradeInProgress) {
    return { success: false, error: "Upgrade already in progress" };
  }

  const checkFn = deps?.checkFn ?? checkForUpdate;
  const spawnFn = deps?.spawnFn ?? Bun.spawn;
  const method = getInstallMethod();

  if (method === "binary") {
    upgradeInProgress = true;
    try {
      return await applyBinaryUpgrade({ checkFn });
    } finally {
      upgradeInProgress = false;
    }
  }

  const update = await checkFn();
  if (!update.available || !update.latest) {
    return { success: false, error: "Already on latest version" };
  }

  upgradeInProgress = true;
  const pkg = `@hienlh/ppm@${update.latest}`;
  const cmd = buildUpgradeCommand(method, pkg);

  try {
    const proc = spawnFn({ cmd, stdout: "pipe", stderr: "pipe" });
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

/** Signal supervisor to trigger self-replace after upgrade.
 *  Unix: SIGUSR1. Windows: command file (supervisor polls every 1s). */
export function signalSupervisorUpgrade(): { sent: boolean; error?: string } {
  try {
    const data = JSON.parse(readFileSync(resolve(getPpmDir(), "status.json"), "utf-8"));
    const pid = data.supervisorPid;
    if (!pid) return { sent: false, error: "No supervisor PID" };
    process.kill(pid, 0); // check alive

    if (process.platform === "win32") {
      const cmdFile = resolve(getPpmDir(), ".supervisor-cmd");
      writeFileSync(cmdFile, JSON.stringify({ action: "upgrade" }));
    } else {
      process.kill(pid, "SIGUSR1");
    }
    return { sent: true };
  } catch (e) {
    return { sent: false, error: (e as Error).message };
  }
}
