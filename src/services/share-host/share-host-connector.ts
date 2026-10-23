/**
 * Keeps one cloudflared connector for the share host running: start it, wait until it is ready,
 * start it again when it exits (backing off), stop it on request.
 *
 * Deliberately smaller than the supervisor's own tunnel loop. There is no fallback from a named
 * tunnel to a quick one, because a review link that was already sent names one address and a
 * different one helps nobody. There is no public probe, because cloudflared reconnects by itself
 * and a process that dies is started again here. And there is no adoption across a supervisor
 * restart: the share host restarts with the supervisor.
 */
import { closeSync, existsSync, openSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import type { Subprocess } from "bun";
import { getPpmDir } from "../ppm-dir.ts";
import { ensureCloudflared } from "../cloudflared.service.ts";
import { waitForLogLine } from "../named-tunnel/named-tunnel-readiness.ts";
import { withoutNotifySocket } from "../sd-notify.ts";
import { createLogger } from "../logger.ts";

const log = createLogger("share-host");

export const SHARE_CONNECTOR_LOG = () => resolve(getPpmDir(), "cloudflared-share.log");
export const QUICK_URL_RE = /https:\/\/(?!api\.)[a-z0-9-]+\.trycloudflare\.com/;
export const NAMED_READY_RE = /Registered tunnel connection/;
const READY_TIMEOUT_MS = 30_000;
/** A connector that stayed up this long starts its next backoff from the beginning. */
const STABLE_MS = 5 * 60_000;

export interface ConnectorPlan {
  /** What this connector is, for the log (`quick`, `named share.example.com`). */
  label: string;
  args: string[];
  /** A named tunnel's address is known up front; a quick tunnel's is read from its log. */
  url: string | null;
}

export interface ConnectorEvents {
  onReady(info: { pid: number; url: string }): void;
  onDown(reason: string): void;
}

export interface ConnectorDeps {
  cloudflared?: () => Promise<string>;
  spawn?: (cmd: string[], logFd: number) => Subprocess;
  /** Serialises spawns with the supervisor's port probes (a probe socket must not be inherited). */
  gate?: <T>(fn: () => T | Promise<T>) => Promise<T>;
  logPath?: () => string;
  readyTimeoutMs?: number;
  backoffMs?: (failures: number) => number;
}

function defaultSpawn(cmd: string[], logFd: number): Subprocess {
  // An explicit env: without one, Bun hands over the environment the supervisor started with.
  return Bun.spawn(cmd, {
    stdin: "ignore", stdout: "ignore", stderr: logFd, env: withoutNotifySocket(process.env), windowsHide: true,
  });
}

/** 1 s, 2 s, 4 s … up to a minute, plus up to a second of jitter. */
export function defaultBackoffMs(failures: number): number {
  return Math.min(60_000, 1000 * 2 ** Math.max(0, failures - 1)) + Math.floor(Math.random() * 1000);
}

/** The last error cloudflared logged since `offset`, as ` — <message>`, or nothing. */
function lastError(logPath: string, offset: number): string {
  try {
    const lines = readFileSync(logPath).subarray(offset).toString("utf8").split("\n");
    const line = lines.reverse().find((l) => / ERR /.test(l));
    return line ? ` — ${line.replace(/^.*? ERR /, "").trim().slice(0, 200)}` : "";
  } catch {
    return "";
  }
}

export class ShareConnector {
  private generation = 0;
  private child: Subprocess | null = null;
  private current: ConnectorPlan | null = null;

  constructor(private readonly deps: ConnectorDeps = {}) {}

  get pid(): number | null {
    return this.child?.pid ?? null;
  }

  /** The plan running now, or null when stopped. */
  get plan(): ConnectorPlan | null {
    return this.current;
  }

  /** Run `plan`, replacing whatever runs now. */
  start(plan: ConnectorPlan, events: ConnectorEvents): void {
    this.stop();
    const generation = ++this.generation;
    this.current = plan;
    void this.loop(generation, plan, events);
  }

  stop(): void {
    this.generation++;
    this.current = null;
    const child = this.child;
    this.child = null;
    if (child) {
      try { child.kill("SIGTERM"); } catch {}
    }
  }

  private live(generation: number): boolean {
    return generation === this.generation;
  }

  private async loop(generation: number, plan: ConnectorPlan, events: ConnectorEvents): Promise<void> {
    let failures = 0;
    while (this.live(generation)) {
      const startedAt = Date.now();
      const reason = await this.runOnce(generation, plan, events);
      if (!this.live(generation)) return;
      events.onDown(reason);
      failures = Date.now() - startedAt >= STABLE_MS ? 1 : failures + 1;
      const delay = (this.deps.backoffMs ?? defaultBackoffMs)(failures);
      log.warn(`Share host connector (${plan.label}) ${reason} — starting again in ${Math.round(delay / 1000)}s`);
      await Bun.sleep(delay);
    }
  }

  /** One connector process, from spawn to exit. Resolves with why it is gone. */
  private async runOnce(generation: number, plan: ConnectorPlan, events: ConnectorEvents): Promise<string> {
    let bin: string;
    try {
      bin = await (this.deps.cloudflared ?? ensureCloudflared)();
    } catch (error) {
      return `could not get cloudflared (${error})`;
    }
    if (!this.live(generation)) return "stopped";

    const logPath = (this.deps.logPath ?? SHARE_CONNECTOR_LOG)();
    // Best-effort: Windows refuses while a previous connector still holds the file, which is why
    // readiness is read only from the bytes after `offset`.
    try { unlinkSync(logPath); } catch {}
    const offset = existsSync(logPath) ? statSync(logPath).size : 0;
    const fd = openSync(logPath, "a");
    let child: Subprocess;
    try {
      const spawn = () => (this.deps.spawn ?? defaultSpawn)([bin, ...plan.args], fd);
      child = await (this.deps.gate ? this.deps.gate(spawn) : spawn());
    } catch (error) {
      return `failed to start (${error})`;
    } finally {
      try { closeSync(fd); } catch {} // the child keeps its own copy
    }
    if (!this.live(generation)) {
      try { child.kill("SIGTERM"); } catch {}
      return "stopped";
    }
    this.child = child;

    try {
      const matched = await waitForLogLine(logPath, plan.url ? NAMED_READY_RE : QUICK_URL_RE, {
        fromByteOffset: offset,
        timeoutMs: this.deps.readyTimeoutMs ?? READY_TIMEOUT_MS,
        getExitCode: () => child.exitCode,
      });
      if (this.live(generation)) {
        const url = plan.url ?? matched;
        log.info(`Share host connector ready: ${url} (${plan.label}, PID ${child.pid})`);
        events.onReady({ pid: child.pid, url });
      }
    } catch (error) {
      try { child.kill("SIGTERM"); } catch {}
      await child.exited;
      if (this.child === child) this.child = null;
      return `did not connect (${error instanceof Error ? error.message : error})${lastError(logPath, offset)}`;
    }

    const code = await child.exited;
    if (this.child === child) this.child = null;
    return `exited (code ${code})${lastError(logPath, offset)}`;
  }
}
