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

/**
 * A command line split into its simple commands (at `&&`, `||`, `;`, `|` and newlines outside
 * quotes), each as its words with the quotes taken off. Exported for tests.
 */
export function commandSegments(command: string): string[][] {
  const segments: string[][] = [];
  let words: string[] = [];
  let word = "";
  let quote: string | null = null;
  let inWord = false;
  const endWord = () => { if (inWord) words.push(word); word = ""; inWord = false; };
  const endSegment = () => { endWord(); if (words.length) segments.push(words); words = []; };
  for (let i = 0; i < command.length; i++) {
    const c = command[i]!;
    if (quote) {
      if (c === quote) quote = null; else word += c;
      continue;
    }
    if (c === '"' || c === "'") { quote = c; inWord = true; continue; }
    if (c === "\n" || c === ";" || c === "|" || (c === "&" && command[i + 1] === "&")) {
      endSegment();
      if ((c === "&" || c === "|") && command[i + 1] === c) i++;
      continue;
    }
    if (/\s/.test(c)) { endWord(); continue; }
    word += c;
    inWord = true;
  }
  endSegment();
  return segments;
}

/** A program's own name: the last path part, lowercased, `.exe`/`.cmd`/`.js` and the like dropped. */
const programName = (w: string) => w.toLowerCase().replace(/^.*[\\/]/, "").replace(/\.(exe|cmd|bat|ps1|c?m?js)$/, "");

/** Words that only wrap the real command in front of it. */
const WRAPPERS = new Set(["npx", "pnpx", "bunx", "time", "nice", "env", "command", "exec", "&", "call", "start"]);
const RUNNERS_WITH_EXEC = new Set(["pnpm", "yarn", "npm"]);
/** Tools that are a heavy job whatever follows (unless watching). */
const HEAVY_TOOLS = new Set(["jest", "vitest", "tsc", "vue-tsc", "pytest", "mocha", "ava"]);
const SCRIPT_GOALS = new Set(["test", "build", "typecheck", "type-check", "tsc", "e2e", "lint", "jest", "vitest"]);
const WATCHING = /^(--watch|-w|--watchAll|watch|serve|dev|--serve|dev-server)$/i;

/** Whether one simple command starts a heavy job. Exported for tests. */
export function isHeavySegment(words: readonly string[]): boolean {
  let i = 0;
  // Leading assignments: `FOO=1`, `$env:NODE_OPTIONS=…`, `export X=…`, `cross-env A=B`.
  for (;;) {
    const w = words[i];
    if (w === undefined) return false;
    if (/^\$env:/i.test(w) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(w)) { i++; continue; }
    if (w === "export" || w === "set" || programName(w) === "cross-env" || programName(w) === "dotenv" || w === "--") { i++; continue; }
    break;
  }
  let prog = programName(words[i]!);
  let rest = words.slice(i + 1);
  while (WRAPPERS.has(prog) && rest.length) { prog = programName(rest[0]!); rest = rest.slice(1); }
  if (RUNNERS_WITH_EXEC.has(prog) && (rest[0] === "exec" || rest[0] === "dlx") && rest.length > 1) {
    prog = programName(rest[1]!);
    rest = rest.slice(2);
  }
  const watching = rest.some((w) => WATCHING.test(w));
  if (prog === "node" || prog === "bun" && rest[0] && /[\\/]/.test(rest[0])) {
    // `node node_modules/jest/bin/jest.js …`: the script names the tool.
    const script = (rest[0] ?? "").toLowerCase().replace(/\\/g, "/");
    if (/\/(jest|jest-cli)\/bin\/jest|\/vitest\/vitest\.mjs|\/typescript\/bin\/tsc|\/\.bin\/(jest|vitest|tsc)$/.test(script)) return !watching;
    if (/\/(vite\/bin\/vite|next\/dist\/bin\/next|webpack(-cli)?\/bin\/[^/]+)/.test(script)) return rest.includes("build") || (/webpack/.test(script) && !watching);
    if (/playwright\/cli\.js$|\/\.bin\/playwright$/.test(script)) return rest[1] === "test";
    if (prog === "node") return false;
  }
  if (HEAVY_TOOLS.has(prog)) return !watching;
  if (prog === "webpack" || prog === "webpack-cli") return !watching;
  if (prog === "vite" || prog === "next" || prog === "nuxt" || prog === "astro") return rest[0] === "build";
  if (prog === "playwright") return rest[0] === "test";
  if (prog === "cypress") return rest[0] === "run";
  if (prog === "nx") return ["run-many", "affected", "test", "build", "e2e"].includes(rest[0] ?? "");
  if (prog === "npm" || prog === "pnpm" || prog === "yarn" || prog === "bun") {
    const args = rest[0] === "run" || rest[0] === "run-script" ? rest.slice(1) : rest;
    const goal = (args[0] ?? "").toLowerCase();
    if (prog === "bun" && goal === "test") return true;
    if (SCRIPT_GOALS.has(goal) || HEAVY_TOOLS.has(goal)) return !watching;
    return false;
  }
  if (prog === "docker" || prog === "docker-compose" || prog === "podman") {
    const sub = prog === "docker-compose" ? ["compose", ...rest] : rest;
    if (sub[0] === "run" || sub[0] === "build") return true;
    return sub[0] === "compose" && ["up", "run", "build"].includes(sub[1] ?? "");
  }
  if (prog === "cargo" || prog === "dotnet") return ["build", "test"].includes(rest[0] ?? "");
  if (prog === "mvn" || prog === "mvnw") return rest.some((w) => ["test", "package", "install", "verify", "compile"].includes(w));
  if (prog === "gradle" || prog === "gradlew") return rest.some((w) => /^(test|build|assemble|check)$/.test(w));
  if (prog === "python" || prog === "python3" || prog === "py") return rest[0] === "-m" && rest[1] === "pytest";
  return false;
}

/** Whether a command line a chat runs starts a heavy job in any of its simple commands. */
export const isHeavyCommand = (command: string): boolean => commandSegments(command).some(isHeavySegment);

/**
 * Running processes that are a heavy job: the runner itself, by its script path, never a word in
 * an argument (a commit message mentioning jest), an MCP server or a watcher / dev server.
 */
const HEAVY_PROCESS = new RegExp([
  String.raw`[\\/](jest|jest-cli)[\\/]bin[\\/]jest(\.js)?\b`, String.raw`[\\/]\.bin[\\/]jest(\.cmd)?\b`,
  String.raw`[\\/]vitest[\\/]vitest\.mjs\b`, String.raw`[\\/]\.bin[\\/]vitest(\.cmd)?\b`,
  String.raw`[\\/]typescript[\\/]bin[\\/]tsc\b`, String.raw`[\\/]\.bin[\\/]tsc(\.cmd)?\b`, String.raw`[\\/]vue-tsc[\\/]bin[\\/]`,
  String.raw`[\\/]vite[\\/]bin[\\/]vite\.js["\s]+build\b`, String.raw`[\\/]next[\\/]dist[\\/]bin[\\/]next["\s]+build\b`,
  String.raw`[\\/]webpack(-cli)?[\\/]bin[\\/]`,
  String.raw`playwright[\\/]cli\.js["\s]+test\b`, String.raw`[\\/]\.bin[\\/]playwright(\.cmd)?["\s]+test\b`,
  String.raw`\bbun(\.exe)?"?\s+test\b`, String.raw`\bpytest\b`, String.raw`\bcypress\b.*\brun\b`,
].join("|"), "i");
const NOT_HEAVY_PROCESS = /@playwright[\\/]mcp|playwright-mcp|(^|\s)(--watch|-w|--watchAll|watch|serve|dev|--serve)(\s|$)|webpack-dev-server/i;

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
/**
 * A heavy command let through holds its place this long, while its processes come up, and no
 * longer: the place is given back as soon as a scan sees a heavy process (the scan covers it from
 * then on), so a quick command does not make the next one wait out the whole lease.
 */
export const LEASE_MS = 30_000;

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

  async check(command: string, opts: { ownPid?: number; signal?: AbortSignal } = {}): Promise<string | null> {
    if (!isHeavyCommand(command)) return null;
    const ownPid = opts.ownPid ?? process.pid;
    const start = this.deps.now();
    for (;;) {
      // The turn was stopped: stop waiting; the command will not run anyway.
      if (opts.signal?.aborted) return null;
      const now = this.deps.now();
      const running = (await this.deps.listRunning()).filter((p) => p.pid !== ownPid && isHeavyProcess(p.cmdline));
      if (running.length) this.leaseUntil = 0;
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
