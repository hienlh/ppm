/**
 * One-click install of the local embedding model into `embedInstallDir()`.
 *
 * Four steps, in this order:
 *   1. The install dir gets its own `package.json`: `bun add` in a directory with no manifest
 *      installs into the nearest parent that has one and leaves this one empty (root CLAUDE.md).
 *   2. `bun add @huggingface/transformers@4.3.2`, run by `resolveBunPath()` — a compiled PPM is
 *      not bun, so `process.execPath` would run PPM's own CLI.
 *   3. `embed-host.mjs` is written from `EMBED_HOST_SOURCE`.
 *   4. The host runs once with `--warm`, which downloads the model into `<installDir>/models`.
 * A marker file is written last, so "ready" means all four finished.
 *
 * Progress is the install dir's size against the ~650 MB the spike measured (≈520 MB of
 * node_modules + ≈130 MB of model). Two clicks share one install; cancel kills the running
 * command and removes the half-finished dir; uninstall removes the dir.
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { lstat, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { resolveBunPath } from "../../autostart-generator.ts";
import { createLogger } from "../../logger.ts";
import { embedInstallDir } from "../memory-paths.ts";
import { EMBED_HOST_FILE, EMBED_HOST_SOURCE } from "./embed-host-source.ts";

const log = createLogger("memory");

export const LOCAL_EMBED_PACKAGE = "@huggingface/transformers@4.3.2";
/** What a finished install measured in the spike: ~520 MB of packages + ~130 MB of model. */
export const EXPECTED_INSTALL_BYTES = 650 * 1024 * 1024;

/** Written after `--warm` succeeds; its presence is what "ready" means across restarts. */
const READY_MARKER = "installed.json";
const ADD_TIMEOUT_MS = 15 * 60_000;
/** The model download happens here, ~130 MB on whatever link the host has. */
const WARM_TIMEOUT_MS = 30 * 60_000;

export type LocalInstallStatus =
  | { state: "not-installed" }
  | { state: "installing"; step: "packages" | "model"; bytes: number; totalBytes: number }
  | { state: "ready" }
  | { state: "failed"; reason: string };

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** How a command runs. Injectable so tests never spawn, download or install anything. */
export type InstallRunner = (
  cmd: string[],
  options: { cwd: string; timeoutMs: number; signal?: AbortSignal },
) => Promise<RunResult>;

export interface LocalInstallerOptions {
  /** Defaults to `embedInstallDir()`. */
  dir?: string;
  run?: InstallRunner;
  /** Defaults to `resolveBunPath()`; throws when the host has no bun. */
  bunPath?: () => string;
  /** How often the dir size is measured while installing. */
  progressIntervalMs?: number;
}

export interface LocalInstaller {
  readonly dir: string;
  status(): LocalInstallStatus;
  /** Resolves with the final status; never rejects. A second call while one runs joins it. */
  install(): Promise<LocalInstallStatus>;
  /** Stops a running install and removes what it left. */
  cancel(): Promise<void>;
  /** Stops any install, then removes the install dir. */
  uninstall(): Promise<void>;
  subscribe(listener: (status: LocalInstallStatus) => void): () => void;
}

const runCommand: InstallRunner = async (cmd, { cwd, timeoutMs, signal }) => {
  let proc: ReturnType<typeof spawnPiped>;
  try {
    proc = spawnPiped(cmd, cwd);
  } catch (e) {
    // Bun.spawn throws synchronously on a missing binary; report it as a failed run.
    return { code: null, stdout: "", stderr: (e as Error).message };
  }
  const kill = () => proc.kill();
  const timer = setTimeout(() => {
    log.warn(`embedding install step timed out after ${Math.round(timeoutMs / 1000)}s; killed pid=${proc.pid}`);
    kill();
  }, timeoutMs);
  signal?.addEventListener("abort", kill);
  if (signal?.aborted) kill();
  try {
    // Drained while it runs: a full pipe blocks the child instead of failing it.
    const [code, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    return { code, stdout, stderr };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", kill);
  }
};

function spawnPiped(cmd: string[], cwd: string) {
  return Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
}

/** Apparent size of everything under `dir`; entries vanishing mid-walk count as nothing. */
async function dirSize(dir: string): Promise<number> {
  let total = 0;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      total += await dirSize(full);
    } else {
      try {
        total += (await lstat(full)).size;
      } catch {}
    }
  }
  return total;
}

/** What a failed command said, bounded: the last 400 characters hold the reason. */
function output(result: RunResult): string {
  return (result.stderr.trim() || result.stdout.trim()).slice(-400) || `exit ${result.code}`;
}

class Cancelled extends Error {}

export function createLocalInstaller(options: LocalInstallerOptions = {}): LocalInstaller {
  const dir = options.dir ?? embedInstallDir();
  const run = options.run ?? runCommand;
  const bunPath = options.bunPath ?? resolveBunPath;
  const intervalMs = options.progressIntervalMs ?? 1000;
  const listeners = new Set<(status: LocalInstallStatus) => void>();

  let current: LocalInstallStatus | null = null; // null: read from disk
  let running: Promise<LocalInstallStatus> | null = null;
  let abort: AbortController | null = null;

  const set = (status: LocalInstallStatus) => {
    current = status;
    for (const listener of listeners) {
      try {
        listener(status);
      } catch (e) {
        log.warn(`embedding install listener threw: ${(e as Error).message}`);
      }
    }
  };

  const status = (): LocalInstallStatus => {
    if (current) return current;
    return existsSync(join(dir, READY_MARKER)) ? { state: "ready" } : { state: "not-installed" };
  };

  async function work(controller: AbortController): Promise<LocalInstallStatus> {
    let step: "packages" | "model" = "packages";
    let bytes = 0;
    set({ state: "installing", step, bytes, totalBytes: EXPECTED_INSTALL_BYTES });

    let measuring = false;
    const timer = setInterval(() => {
      if (measuring) return;
      measuring = true;
      void dirSize(dir)
        .then((size) => {
          if (controller.signal.aborted || current?.state !== "installing") return;
          bytes = size;
          set({ state: "installing", step, bytes, totalBytes: EXPECTED_INSTALL_BYTES });
        })
        .finally(() => {
          measuring = false;
        });
    }, intervalMs);

    const runStep = async (cmd: string[], timeoutMs: number, what: string) => {
      let result: RunResult;
      try {
        result = await run(cmd, { cwd: dir, timeoutMs, signal: controller.signal });
      } catch (e) {
        if (controller.signal.aborted) throw new Cancelled();
        throw new Error(`${what} failed: ${(e as Error).message}`);
      }
      if (controller.signal.aborted) throw new Cancelled();
      if (result.code !== 0) throw new Error(`${what} failed: ${output(result)}`);
    };

    const startedAt = performance.now();
    try {
      let bun: string;
      try {
        bun = bunPath();
      } catch {
        throw new Error("bun is not installed on this host, so PPM cannot install the local model.");
      }
      log.info(`installing local embedding model into ${dir}`);
      mkdirSync(dir, { recursive: true });
      rmSync(join(dir, READY_MARKER), { force: true });
      const manifest = join(dir, "package.json");
      if (!existsSync(manifest)) {
        writeFileSync(manifest, `${JSON.stringify({ name: "ppm-memory-embed", private: true, dependencies: {} }, null, 2)}\n`);
      }

      await runStep([bun, "add", LOCAL_EMBED_PACKAGE], ADD_TIMEOUT_MS, `bun add ${LOCAL_EMBED_PACKAGE}`);

      const host = join(dir, EMBED_HOST_FILE);
      writeFileSync(host, EMBED_HOST_SOURCE);
      step = "model";
      set({ state: "installing", step, bytes, totalBytes: EXPECTED_INSTALL_BYTES });
      await runStep([bun, host, "--warm"], WARM_TIMEOUT_MS, "Downloading the model");

      writeFileSync(join(dir, READY_MARKER), `${JSON.stringify({ package: LOCAL_EMBED_PACKAGE, at: new Date().toISOString() })}\n`);
      log.info(`installed local embedding model in ${Math.round(performance.now() - startedAt)}ms`);
      return { state: "ready" };
    } catch (e) {
      if (e instanceof Cancelled || controller.signal.aborted) {
        await rm(dir, { recursive: true, force: true }).catch(() => {});
        log.info("local embedding model install cancelled");
        return { state: "not-installed" };
      }
      const reason = (e as Error).message;
      log.warn(`local embedding model install failed: ${reason}`);
      return { state: "failed", reason };
    } finally {
      clearInterval(timer);
    }
  }

  const install = (): Promise<LocalInstallStatus> => {
    if (running) return running;
    const controller = new AbortController();
    abort = controller;
    running = work(controller).then((final) => {
      running = null;
      abort = null;
      set(final);
      return final;
    });
    return running;
  };

  const cancel = async (): Promise<void> => {
    if (!running) return;
    abort?.abort();
    await running;
  };

  const uninstall = async (): Promise<void> => {
    await cancel();
    await rm(dir, { recursive: true, force: true });
    log.info(`removed local embedding model from ${dir}`);
    set({ state: "not-installed" });
  };

  return {
    dir,
    status,
    install,
    cancel,
    uninstall,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

let shared: LocalInstaller | null = null;

/** The installer for `embedInstallDir()`, shared by every caller so two clicks join one install. */
export function localInstaller(): LocalInstaller {
  if (!shared) shared = createLocalInstaller();
  return shared;
}
