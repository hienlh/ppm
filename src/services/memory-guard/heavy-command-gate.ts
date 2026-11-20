import { readdirSync, readFileSync } from "node:fs";
import { belowFreeGB } from "../../shared/memory-guard.ts";

/**
 * Holds back a chat's heavy command — a test runner, a type check, a build, an e2e run — while the
 * machine is low on memory or another one is already running anywhere on it.
 *
 * Why: on 20/11/2026 two chats' agents, an e2e run in Docker and a jest started with an 8 GB heap
 * and two workers ran at once, and the machine ran out of commit; PPM, its supervisor, codex and a
 * Windows service died in the same second. One heavy job at a time, and none under the block
 * threshold, is the rule this enforces for what chats start. It runs as part of the PreToolUse hook
 * on Bash/PowerShell calls, after the permission check, and answers the model in words it can act
 * on ("wait, or lower --maxWorkers") rather than failing the command later.
 *
 * "Anywhere" includes processes PPM did not start (a terminal the user runs tests in): the scan
 * looks at every process's command line. Only *new* commands are held; nothing running is touched.
 */

/** Commands that start a heavy job. Matched on the whole command line a chat runs. */
const HEAVY_COMMAND = new RegExp([
  String.raw`\bjest\b`, String.raw`\bvitest\b`, String.raw`\btsc\b`, String.raw`\bvue-tsc\b`,
  String.raw`\bvite\s+build\b`, String.raw`\bwebpack\b`, String.raw`\bnext\s+build\b`, String.raw`\bnx\s+(run-many|affected)\b`,
  String.raw`\bplaywright\s+test\b`, String.raw`\bcypress\s+run\b`,
  String.raw`\b(npm|pnpm|yarn)\s+(run\s+)?(test|build|typecheck|type-check|e2e|lint)\b`,
  String.raw`\bbun\s+(run\s+)?(test|build|typecheck|e2e)\b`,
  String.raw`\bdocker(-compose)?\s+(run|build|compose\s+(up|run|build))\b`,
  String.raw`\b(cargo|dotnet)\s+(build|test)\b`, String.raw`\b(mvn|gradle|gradlew)\b`, String.raw`\bpytest\b`,
].join("|"), "i");

/** Running processes that are a heavy job. MCP servers (`@playwright/mcp`) and watchers are not. */
const HEAVY_PROCESS = new RegExp([
  String.raw`[\\/]jest(\.js)?\b`, String.raw`\bjest-worker\b`, String.raw`[\\/]vitest\b`,
  String.raw`[\\/]typescript[\\/]bin[\\/]tsc\b`, String.raw`[\\/]tsc(\.js)?["\s]`, String.raw`\bvue-tsc\b`,
  String.raw`[\\/]vite(\.js)?["\s]+build\b`, String.raw`[\\/]webpack(-cli)?\b`, String.raw`[\\/]next["\s]+build\b`,
  String.raw`playwright[\\/]cli\.js["\s]+test\b`, String.raw`\bplaywright\s+test\b`, String.raw`\bcypress\b.*\brun\b`,
  String.raw`\bbun(\.exe)?["\s]+test\b`, String.raw`\bpytest\b`,
].join("|"), "i");
const NOT_HEAVY_PROCESS = /@playwright[\\/]mcp|playwright-mcp|--watch\b|\bwatch\b/i;

export const isHeavyCommand = (command: string): boolean => HEAVY_COMMAND.test(command);
export const isHeavyProcess = (cmdline: string): boolean => HEAVY_PROCESS.test(cmdline) && !NOT_HEAVY_PROCESS.test(cmdline);

export interface ProcLine {
  pid: number;
  cmdline: string;
}

export type GateVerdict =
  | { action: "allow" }
  | { action: "wait"; running: ProcLine[] }
  | { action: "deny"; reason: string };

/** How long a command waits for another heavy job to finish before it is refused. */
export const HEAVY_QUEUE_WAIT_MS = 5 * 60_000;
export const HEAVY_QUEUE_POLL_MS = 15_000;
/** A heavy command let through holds its place this long, while its processes come up. */
export const LEASE_MS = 90_000;

const shortCmd = (s: string) => (s.length > 120 ? `${s.slice(0, 117)}…` : s);
const gb = (mb: number) => (mb / 1024).toFixed(1);

/** One look: refuse under the block threshold, wait behind a running heavy job, else allow. */
export function decideHeavyGate(f: {
  command: string;
  freeMB: number | null;
  blockGB: number;
  running: ProcLine[];
  leased: boolean;
  waitedMs: number;
}): GateVerdict {
  if (!isHeavyCommand(f.command)) return { action: "allow" };
  if (f.freeMB !== null && belowFreeGB(f.freeMB, f.blockGB)) {
    return {
      action: "deny",
      reason: `PPM held this command: the machine has only ${gb(f.freeMB)} GB of memory free (under ${f.blockGB} GB), and heavy jobs `
        + "(tests, type checks, builds, e2e) are not started until memory comes back. Wait a few minutes and try again, "
        + "or run less at once (for jest: --maxWorkers=1, and no --max-old-space-size above 4096).",
    };
  }
  if (f.running.length === 0 && !f.leased) return { action: "allow" };
  if (f.waitedMs < HEAVY_QUEUE_WAIT_MS) return { action: "wait", running: f.running };
  const what = f.running.length
    ? f.running.slice(0, 3).map((p) => `pid ${p.pid}: ${shortCmd(p.cmdline)}`).join("; ")
    : "a heavy command another chat just started";
  return {
    action: "deny",
    reason: `PPM held this command: only one heavy job (tests, type checks, builds, e2e) runs on this machine at a time, and `
      + `${what} is still running after ${Math.round(f.waitedMs / 60_000)} min. Try again once it has finished.`,
  };
}

/** Every process's command line; [] when unreadable. Windows: one PowerShell query, only when a heavy command is asked for. */
export async function listCommandLines(platform: NodeJS.Platform = process.platform): Promise<ProcLine[]> {
  try {
    if (platform === "linux") {
      const out: ProcLine[] = [];
      for (const name of readdirSync("/proc")) {
        const pid = Number(name);
        if (!Number.isInteger(pid)) continue;
        try {
          const cmdline = readFileSync(`/proc/${pid}/cmdline`, "utf-8").replace(/\0/g, " ").trim();
          if (cmdline) out.push({ pid, cmdline });
        } catch { /* gone */ }
      }
      return out;
    }
    const cmd = platform === "win32"
      ? ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command",
        "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine } | ForEach-Object { \"$($_.ProcessId)`t$($_.CommandLine)\" }"]
      : ["ps", "-axo", "pid=,command="];
    let proc: ReturnType<typeof Bun.spawn>;
    try {
      proc = Bun.spawn({ cmd, stdout: "pipe", stderr: "ignore", stdin: "ignore", windowsHide: true });
    } catch {
      return [];
    }
    const timer = setTimeout(() => { try { proc.kill(); } catch { /* gone */ } }, 10_000);
    const text = await new Response(proc.stdout as ReadableStream).text().finally(() => clearTimeout(timer));
    return parseCommandLines(text, platform === "win32" ? "\t" : null);
  } catch {
    return [];
  }
}

/** `pid<sep>cmdline` lines (Windows, tab) or `  pid cmdline` lines (`ps`). Exported for tests. */
export function parseCommandLines(text: string, sep: string | null): ProcLine[] {
  const out: ProcLine[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = sep ? new RegExp(`^(\\d+)${sep}(.+)$`).exec(line) : /^\s*(\d+)\s+(.+)$/.exec(line);
    if (m) out.push({ pid: Number(m[1]), cmdline: m[2]!.trim() });
  }
  return out;
}

export interface HeavyGateDeps {
  readFreeMB: () => Promise<number | null>;
  blockGB: () => number;
  listRunning: () => Promise<ProcLine[]>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
}

/**
 * The gate a heavy command goes through: decide, waiting in turn while another heavy job runs.
 * Leases are kept in this process (the server runs every chat's hooks), so two chats asking in the
 * same second do not both see "nothing running" and start together. Returns null to let the
 * command through, or the reason to refuse it.
 */
export class HeavyCommandGate {
  private leaseUntil = 0;

  constructor(private readonly deps: HeavyGateDeps) {}

  async check(command: string, ownPid = process.pid): Promise<string | null> {
    if (!isHeavyCommand(command)) return null;
    const start = this.deps.now();
    for (;;) {
      const now = this.deps.now();
      const running = (await this.deps.listRunning()).filter((p) => p.pid !== ownPid && isHeavyProcess(p.cmdline));
      const verdict = decideHeavyGate({
        command, freeMB: await this.deps.readFreeMB(), blockGB: this.deps.blockGB(),
        running, leased: now < this.leaseUntil, waitedMs: now - start,
      });
      if (verdict.action === "deny") return verdict.reason;
      if (verdict.action === "allow") {
        this.leaseUntil = this.deps.now() + LEASE_MS;
        return null;
      }
      await this.deps.sleep(HEAVY_QUEUE_POLL_MS);
    }
  }
}

let liveGate: HeavyCommandGate | null = null;

/** The server's gate, over the live machine and the saved thresholds. */
export async function heavyCommandGate(): Promise<HeavyCommandGate> {
  if (liveGate) return liveGate;
  const { readSystemCommit } = await import("../system-commit.ts");
  const { configService } = await import("../config.service.ts");
  const { memoryGuardSettings } = await import("../../shared/memory-guard.ts");
  liveGate = new HeavyCommandGate({
    readFreeMB: async () => (await readSystemCommit())?.freeMB ?? null,
    blockGB: () => memoryGuardSettings(configService.get("ai") as never).blockFreeGB,
    listRunning: () => listCommandLines(),
    sleep: (ms) => Bun.sleep(ms),
    now: () => Date.now(),
  });
  return liveGate;
}
