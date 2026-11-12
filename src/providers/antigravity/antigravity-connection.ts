import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { getPpmDir } from "../../services/ppm-dir.ts";
import { agyEnv } from "./acp-launch.ts";

export interface AntigravityPaths {
  home: string;
  geminiDir: string;
  brainDirs: string[];
  lsLogPath: string;
}

export interface LanguageServerConnection {
  address: string;
  csrfToken: string;
  https?: boolean;
}

/** Resolve standard Antigravity directories on the current machine. */
export function resolveAntigravityPaths(customHome?: string): AntigravityPaths {
  const home = customHome || process.env.HOME || homedir();
  const geminiDir = join(home, ".gemini");
  const appDataEnv = !customHome ? process.env.ANTIGRAVITY_APP_DATA_DIR : undefined;
  const candidates = [
    ...(appDataEnv ? [join(appDataEnv, "brain")] : []),
    join(geminiDir, "antigravity", "brain"),
    join(geminiDir, "antigravity-ide", "brain"),
    join(geminiDir, "antigravity-cli", "brain"),
  ];
  if (!customHome) {
    try {
      const accountsDir = resolve(getPpmDir(), "antigravity-accounts");
      if (existsSync(accountsDir)) {
        for (const entry of readdirSync(accountsDir)) {
          const acctGemini = join(accountsDir, entry, ".gemini");
          candidates.push(
            join(acctGemini, "antigravity", "brain"),
            join(acctGemini, "antigravity-cli", "brain"),
          );
        }
      }
    } catch { /* ignore */ }
  }
  const seen = new Set<string>();
  const brainDirs: string[] = [];
  for (const dir of candidates) {
    const resolved = resolve(dir);
    if (!seen.has(resolved)) {
      seen.add(resolved);
      brainDirs.push(resolved);
    }
  }
  return {
    home,
    geminiDir,
    brainDirs,
    lsLogPath: join(home, ".config", "Antigravity", "logs", "language_server.log"),
  };
}

/** Locate the `agy` CLI executable if installed. */
export function findAgyExecutable(customHome?: string): string | null {
  const home = customHome || process.env.HOME || homedir();
  const candidates = [
    process.env.ANTIGRAVITY_AGY_EXE,
    join(home, ".local", "bin", "agy"),
    join(homedir(), ".local", "bin", "agy"),
    "/usr/local/bin/agy",
    "/usr/bin/agy",
  ].filter((c): c is string => Boolean(c));
  for (const file of candidates) {
    if (existsSync(file)) return file;
  }
  return null;
}

/** Parse the most recent HTTP port logged by `language_server.log`. */
export function parseHttpPortFromLsLog(logContent: string): number | null {
  const matches = [...logContent.matchAll(/listening on random port at (\d+) for HTTP\b/g)];
  const last = matches.at(-1)?.[1];
  if (!last) return null;
  const port = Number.parseInt(last, 10);
  return Number.isFinite(port) && port > 0 ? port : null;
}

/** Check if a PID is currently alive on the host. */
function isPidAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Read `<home>/.gemini/antigravity/daemon/(ls|hub)_*.json` written by `language_server --persistent_mode`. */
export function discoverDaemonConnection(home: string): LanguageServerConnection | null {
  const dirs = [
    join(home, ".gemini", "antigravity", "daemon"),
    join(home, ".gemini", "antigravity-ide", "daemon"),
  ];
  for (const daemonDir of dirs) {
    if (!existsSync(daemonDir)) continue;
    try {
      const files = readdirSync(daemonDir).filter((f) => /^(ls|hub)_.*\.json$/.test(f));
      for (const file of files) {
        try {
          const info = JSON.parse(readFileSync(join(daemonDir, file), "utf-8")) as {
            pid?: number;
            httpPort?: number;
            httpsPort?: number;
            csrfToken?: string;
          };
          if (info.pid && !isPidAlive(info.pid)) continue;
          if (typeof info.httpPort === "number" && info.httpPort > 0 && typeof info.csrfToken === "string") {
            return { address: `127.0.0.1:${info.httpPort}`, csrfToken: info.csrfToken };
          }
        } catch { /* skip malformed discovery file */ }
      }
    } catch { /* ignore */ }
  }
  return null;
}

/**
 * `-csrf_token` of the running `language_server` whose HOME is `expectedHome` (Linux `/proc`).
 *
 * Only that one: `cmdline` is world-readable, so any other process's token can belong to another
 * person on the host, or to the language server PPM runs for another account. Neither answers at
 * the address read from this home's log anyway.
 */
function discoverCsrfTokenFromProc(expectedHome: string): string | null {
  if (process.platform === "linux" && existsSync("/proc")) {
    try {
      for (const entry of readdirSync("/proc")) {
        if (!/^\d+$/.test(entry)) continue;
        try {
          const cmdline = readFileSync(`/proc/${entry}/cmdline`, "utf-8");
          if (!cmdline.includes("language_server")) continue;
          const args = cmdline.split("\0");
          let token: string | null = null;
          for (let i = 0; i < args.length; i++) {
            const arg = args[i]!;
            if ((arg === "-csrf_token" || arg === "--csrf_token") && args[i + 1]) {
              token = args[i + 1]!;
              break;
            }
            const eq = /^--?csrf_token=(.+)$/.exec(arg);
            if (eq?.[1]) {
              token = eq[1];
              break;
            }
          }
          if (!token) continue;
          // Another user's environ is unreadable, which skips their processes too.
          const environ = readFileSync(`/proc/${entry}/environ`, "utf-8");
          if (environ.split("\0").includes(`HOME=${expectedHome}`)) return token;
        } catch { /* permission or vanished pid */ }
      }
    } catch { /* ignore */ }
  }
  return null;
}

/**
 * Discover active `ANTIGRAVITY_LS_ADDRESS` and `ANTIGRAVITY_CSRF_TOKEN`
 * from environment or local Antigravity Desktop / daemon state.
 */
export function discoverLanguageServerConnection(customHome?: string): LanguageServerConnection | null {
  const envAddr = !customHome ? process.env.ANTIGRAVITY_LS_ADDRESS : undefined;
  const envCsrf = !customHome ? process.env.ANTIGRAVITY_CSRF_TOKEN : undefined;
  if (envAddr && envCsrf) {
    return { address: envAddr, csrfToken: envCsrf };
  }

  const { home, lsLogPath } = resolveAntigravityPaths(customHome);
  const daemonConn = discoverDaemonConnection(home);
  if (daemonConn) return daemonConn;

  // For isolated customHome accounts, only use daemon discovery unless a custom lsLogPath exists.
  if (customHome && !existsSync(lsLogPath)) {
    return null;
  }

  let address = envAddr ?? null;
  if (!address && existsSync(lsLogPath)) {
    try {
      const port = parseHttpPortFromLsLog(readFileSync(lsLogPath, "utf-8"));
      if (port) address = `localhost:${port}`;
    } catch { /* ignore */ }
  }

  const csrfToken = envCsrf ?? discoverCsrfTokenFromProc(home);
  if (address && csrfToken) {
    return { address, csrfToken };
  }
  return null;
}

interface ManagedDaemon {
  proc: ChildProcess;
  timer: ReturnType<typeof setTimeout>;
  idleTtlMs: number;
  starting?: Promise<LanguageServerConnection | null>;
}

const managedDaemons = new Map<string, ManagedDaemon>();
const DAEMON_IDLE_TTL_MS = 120_000;

function unrefTimer(t: ReturnType<typeof setTimeout>): ReturnType<typeof setTimeout> {
  (t as { unref?: () => void }).unref?.();
  return t;
}

function scheduleDaemonIdleTimer(key: string, ttlMs: number): ReturnType<typeof setTimeout> {
  return unrefTimer(
    setTimeout(() => stopManagedLanguageServer(key), ttlMs),
  );
}

function touchManagedDaemon(key: string): void {
  const entry = managedDaemons.get(key);
  if (!entry) return;
  clearTimeout(entry.timer);
  entry.timer = scheduleDaemonIdleTimer(key, entry.idleTtlMs);
}

/** Stop any PPM-spawned Language Server daemon for a given home directory. */
export function stopManagedLanguageServer(customHome: string): void {
  const entry = managedDaemons.get(customHome);
  if (!entry) return;
  managedDaemons.delete(customHome);
  clearTimeout(entry.timer);
  try { entry.proc.kill("SIGTERM"); } catch { /* ignore */ }
}

/**
 * Ensure a Language Server is running for `customHome` (or ambient home) and return its connection.
 * Isolated accounts (`customHome`) run with `HOME=customHome` and `WSL_DISTRO_NAME=ppm` so they
 * authenticate using `<customHome>/.gemini/jetski-standalone-oauth-token`.
 */
export async function ensureLanguageServerConnection(
  customHome?: string,
  idleTtlMs: number = DAEMON_IDLE_TTL_MS,
): Promise<LanguageServerConnection | null> {
  const existing = discoverLanguageServerConnection(customHome);
  if (existing) {
    if (customHome) touchManagedDaemon(customHome);
    return existing;
  }

  // Only auto-spawn for isolated accounts that have a token file, or ambient if explicitly requested
  if (customHome) {
    const tokenFile = join(customHome, ".gemini", "jetski-standalone-oauth-token");
    if (!existsSync(tokenFile)) return null;
  } else {
    return null;
  }

  const inFlight = managedDaemons.get(customHome)?.starting;
  if (inFlight) return inFlight;

  const lsBin = process.env.ANTIGRAVITY_LS_BIN || "/opt/Antigravity/resources/bin/language_server";
  if (existsSync(lsBin)) {
    const startPromise = (async (): Promise<LanguageServerConnection | null> => {
      const csrf = randomUUID();
      mkdirSync(join(customHome, ".gemini", "antigravity", "daemon"), { recursive: true });
      let proc: ChildProcess;
      try {
        proc = spawn(
          lsBin,
          [
            "--standalone",
            "--persistent_mode",
            "--exit_on_stdin_close",
            "--override_ide_name", "antigravity",
            "--subclient_type", "hub",
            "--override_ide_version", "2.29.0",
            "--override_user_agent_name", "antigravity",
            "--https_server_port", "0",
            "--csrf_token", csrf,
            "--app_data_dir", "antigravity",
            "--api_server_url", "https://generativelanguage.googleapis.com",
            "--cloud_code_endpoint", "https://daily-cloudcode-pa.googleapis.com",
          ],
          {
            // The allowlist, not PPM's environment, which carries tokens (see acp-launch.ts).
            env: agyEnv(customHome, true),
            stdio: ["pipe", "ignore", "ignore"],
          },
        );
      } catch {
        return null;
      }

      let spawnFailed = false;
      const timer = scheduleDaemonIdleTimer(customHome, Math.max(idleTtlMs, 6_000));
      managedDaemons.set(customHome, { proc, timer, idleTtlMs });
      const cleanup = () => {
        const cur = managedDaemons.get(customHome);
        if (cur?.proc === proc) {
          clearTimeout(cur.timer);
          managedDaemons.delete(customHome);
        }
      };
      proc.on("error", () => {
        spawnFailed = true;
        cleanup();
      });
      proc.on("exit", () => {
        spawnFailed = true;
        cleanup();
      });

      const deadline = Date.now() + 6_000;
      while (!spawnFailed && Date.now() < deadline) {
        const conn = discoverDaemonConnection(customHome);
        if (conn) {
          touchManagedDaemon(customHome);
          return conn;
        }
        await new Promise((r) => setTimeout(r, 20));
      }
      stopManagedLanguageServer(customHome);
      return null;
    })();

    const cur = managedDaemons.get(customHome);
    if (cur) cur.starting = startPromise;
    return startPromise;
  }

  return null;
}
