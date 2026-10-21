/**
 * Counts every child process the server starts, for the memory monitor.
 *
 * A child process is the prime suspect for native growth on Windows: each
 * `powershell.exe` spawn was measured to cost Bun a 32 MiB allocator segment it never
 * returns (see `system-metrics/powershell-session.ts`). A per-interval count by command,
 * logged beside private bytes, is what lets a later reader say "the commit charge climbs
 * by N MB per `git` spawn" instead of guessing.
 *
 * It wraps `Bun.spawn` and `Bun.spawnSync`, which is enough: in Bun, `node:child_process`
 * (`spawn`, `exec`, `execFile`, and their sync forms — what the Claude SDK, simple-git and
 * codex go through) is built on those two globals, so the wrapper sees them too. Only a
 * module that saved its own reference to `Bun.spawn` before the wrapper went in is missed.
 *
 * A label is the program's basename plus at most one more word that is known not to be data:
 * a git subcommand, a script file's name, a runner's own subcommand, or the first program a
 * shell is told to run. Anything else — an inline script, an argument, a word carrying `=`,
 * `$` or quotes — is left out, because an argument can be a path, a prompt or a token.
 */

interface LiveChild { pid: number; label: string; startedAt: number }

export interface SpawnSnapshot {
  /** Spawns since the previous snapshot, by label (sync ones included). */
  spawned: Record<string, number>;
  /** Children still running now, by label. */
  live: Record<string, number>;
  liveTotal: number;
  /** Every spawn since the tracker started. */
  total: number;
}

/** Programs whose own name says nothing: the script or subcommand after them is the label. */
const RUNNERS = new Set(["node", "bun", "npx", "bunx", "python", "python3", "py", "deno"]);
/** Programs handed a whole command line as one argument. */
const SHELLS = new Set(["cmd", "powershell", "pwsh", "sh", "bash", "zsh"]);
/** A runner flag whose value is code to run: the label stops at the flag. */
const EVAL_FLAGS = new Set(["-e", "--eval", "-p", "--print", "-c"]);
/** A runner's own subcommands, which are words and never data. */
const RUNNER_SUBCOMMANDS = new Set(["run", "x", "exec", "install", "add", "remove", "test", "build", "upgrade"]);
/** Runner flags that take a separate value, which is not the script. */
const RUNNER_VALUE_FLAGS = new Set(["-r", "--require", "--import", "--loader", "--cwd", "--env-file", "--config", "-m"]);
/** The shell flag after which the command line comes. */
const SHELL_COMMAND_FLAGS = new Set(["-c", "/c", "/k", "-command", "-file"]);
const SCRIPT_FILE = /\.(c|m)?[jt]sx?$|\.py$|\.ps1$/i;
/** A word that is plausibly a program or subcommand name and cannot carry an assignment or a quote. */
const PLAIN_WORD = /^[A-Za-z0-9._\\/:@+-]+$/;
const GIT_VALUE_FLAGS = new Set(["-c", "-C", "--git-dir", "--work-tree", "--namespace", "--exec-path"]);

/** Lowercased basename with the executable extension dropped, cut to 40 characters. */
function baseName(path: string): string {
  const name = path.split(/[\\/]/).pop() ?? "";
  return name.toLowerCase().replace(/\.(exe|cmd|bat|com)$/, "").slice(0, 40);
}

function gitLabel(rest: string[]): string {
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (GIT_VALUE_FLAGS.has(a)) { i++; continue; }
    if (a.startsWith("-")) continue;
    return /^[a-z][a-z0-9-]*$/.test(a) ? `git ${a}` : "git";
  }
  return "git";
}

function runnerLabel(program: string, rest: string[]): string {
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (EVAL_FLAGS.has(a)) return `${program} ${a}`;
    if (RUNNER_VALUE_FLAGS.has(a)) { i++; continue; }
    if (a.startsWith("-")) continue;
    if (!PLAIN_WORD.test(a)) return program;
    if (SCRIPT_FILE.test(a)) return `${program} ${baseName(a)}`;
    if (RUNNER_SUBCOMMANDS.has(a)) return `${program} ${a}`;
    // `npx <package>`: the package's own name, its scope and version dropped.
    const pkg = a.match(/^(?:@[\w.-]+\/)?([\w.-]+)(?:@[\w.^~-]+)?$/);
    if ((program === "npx" || program === "bunx") && pkg) return `${program} ${pkg[1]!.toLowerCase().slice(0, 40)}`;
    return program;
  }
  return program;
}

function shellLabel(program: string, rest: string[]): string {
  const at = rest.findIndex((a) => SHELL_COMMAND_FLAGS.has(a.toLowerCase()));
  const line = at === -1 ? undefined : rest[at + 1];
  if (line === undefined) return program;
  const first = line.trim().split(/\s+/)[0] ?? "";
  if (!first || !PLAIN_WORD.test(first)) return program;
  return `${program} ${baseName(first)}`;
}

/** A short, argument-free name for a command line. Exported for tests. */
export function spawnLabel(argv: readonly unknown[]): string {
  const parts = argv.filter((a): a is string => typeof a === "string");
  const [head, ...rest] = parts;
  if (head === undefined) return "unknown";
  const program = baseName(head.replace(/^["']|["']$/g, "")).replace(/[^a-z0-9._+-]/g, "");
  if (!program) return "unknown";
  if (program === "git") return gitLabel(rest);
  if (RUNNERS.has(program)) return runnerLabel(program, rest);
  if (SHELLS.has(program)) return shellLabel(program, rest);
  return program;
}

/** `Bun.spawn(cmd[], opts)` or `Bun.spawn({ cmd, ... })`. */
function argvOf(args: unknown[]): readonly unknown[] {
  const first = args[0];
  if (Array.isArray(first)) return first;
  if (first && typeof first === "object" && Array.isArray((first as { cmd?: unknown }).cmd)) {
    return (first as { cmd: unknown[] }).cmd;
  }
  return [];
}

export class SpawnTracker {
  /** Keyed by the child object, not its pid: a pid can be reused before the old child's `exited` settles. */
  private readonly live = new Map<object, LiveChild>();
  private interval = new Map<string, number>();
  private readonly totals = new Map<string, number>();
  private total = 0;
  private installed = false;

  constructor(private readonly now: () => number = Date.now) {}

  /** Record one spawn. Exported for tests; `install()` calls it for real spawns. */
  record(label: string, child?: { pid?: number; exited?: Promise<unknown> }): void {
    this.total++;
    this.interval.set(label, (this.interval.get(label) ?? 0) + 1);
    this.totals.set(label, (this.totals.get(label) ?? 0) + 1);
    const pid = child?.pid;
    if (!child || typeof pid !== "number" || !child.exited) return;
    this.live.set(child, { pid, label, startedAt: this.now() });
    child.exited.then(
      () => { this.live.delete(child); },
      () => { this.live.delete(child); },
    );
  }

  /** Wrap the two globals. Safe to call twice. */
  install(): void {
    if (this.installed) return;
    this.installed = true;
    const bun = Bun as unknown as Record<"spawn" | "spawnSync", (...a: unknown[]) => unknown>;
    const spawn = bun.spawn;
    const spawnSync = bun.spawnSync;
    bun.spawn = (...args: unknown[]) => {
      const child = spawn.apply(Bun, args) as { pid?: number; exited?: Promise<unknown> };
      try { this.record(spawnLabel(argvOf(args)), child); } catch { /* counting must never break a spawn */ }
      return child;
    };
    bun.spawnSync = (...args: unknown[]) => {
      try { this.record(spawnLabel(argvOf(args))); } catch { /* as above */ }
      return spawnSync.apply(Bun, args);
    };
  }

  /** Counts since the last call, plus what is alive now. Resets the interval counts. */
  snapshot(): SpawnSnapshot {
    const live: Record<string, number> = {};
    for (const c of this.live.values()) live[c.label] = (live[c.label] ?? 0) + 1;
    const spawned = Object.fromEntries(this.interval);
    this.interval = new Map();
    return { spawned, live, liveTotal: this.live.size, total: this.total };
  }

  /** The longest-running children, for a threshold alert. */
  oldestLive(limit: number): Array<{ pid: number; label: string; ageMin: number }> {
    const t = this.now();
    return [...this.live.values()]
      .sort((a, b) => a.startedAt - b.startedAt)
      .slice(0, limit)
      .map((c) => ({ pid: c.pid, label: c.label, ageMin: Math.round((t - c.startedAt) / 60_000) }));
  }

  /** Spawns by label since the tracker started, most first. */
  topTotals(limit: number): Record<string, number> {
    return Object.fromEntries([...this.totals.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit));
  }
}

export const spawnTracker = new SpawnTracker();
