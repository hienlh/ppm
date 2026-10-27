/**
 * Stops what an AI chat left running: servers, emulators and daemons its commands started and
 * walked away from. Linux with a systemd user manager only; anywhere else nothing is routed and
 * nothing is stopped, exactly as before.
 *
 * Every command of a chat runs in a scope under the session's slice (`session-shell-scripts.ts`),
 * so whatever it leaves behind stays findable in cgroupfs however it detached — `&`, `nohup`,
 * `setsid`, `env -i`, a double-forking daemon, or `systemd-run` through the shim. A sweep stops a
 * session's leftovers once the session has been idle `leftover_processes_idle_minutes`; deleting
 * the session stops all of it at once. A process descending from a live CLI is a command or MCP
 * server running right now and is never stopped by a sweep.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createLogger } from "../logger.ts";
import { getPpmDir } from "../ppm-dir.ts";
import { advanceClock, describeUnits, idlePastLimit, isCommandScope, unitsToStop, type SessionClock, type UnitSnapshot } from "./leftover-decisions.ts";
import { installSessionShell } from "./session-shell-scripts.ts";
import {
  instanceSliceName, instanceTag, SESSION_SHELL_DIR, sessionIdOfSlice, sessionSliceName, withSessionSlice, type SessionShell,
} from "./session-slice.ts";

const log = createLogger("chat-procs");

const CGROUP_ROOT = "/sys/fs/cgroup";
const SWEEP_INTERVAL_MS = 60_000;
const PROBE_TIMEOUT_MS = 5_000;

interface Tracking {
  instance: string;
  shell: SessionShell;
  systemctl: string;
  /** cgroupfs directory of this PPM's slice; every session slice of it is a directory inside. */
  instanceDir: string;
  /** The cgroup PPM's own processes, its CLIs included, run in. */
  ownCgroup: string;
  idleMinutes: () => number;
}

let tracking: Tracking | null = null;

export interface SweepDeps {
  /** Whether the session is working now (a turn, an approval, background work) and when it last was. */
  activity: (sessionId: string) => { busy: boolean; lastActiveAt?: number };
  /** Told after a sweep or a deletion stopped units of a session. */
  onStopped?: (sessionId: string, summary: string) => void;
}

// Survive Bun --hot reloads: one timer, whichever module copy registered last.
const HOT_KEY = "__PPM_LEFTOVER_SWEEPER__" as const;
const hot = ((globalThis as any)[HOT_KEY] ??= { stop: null, deps: null, startupDone: false }) as {
  stop: (() => void) | null;
  deps: SweepDeps | null;
  startupDone: boolean;
};
const clocks = new Map<string, SessionClock>();

async function run(cmd: string[], timeoutMs = PROBE_TIMEOUT_MS): Promise<{ code: number | null; out: string; err: string }> {
  try {
    const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
    const timer = setTimeout(() => proc.kill(), timeoutMs);
    const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    clearTimeout(timer);
    return { code, out, err };
  } catch (e) {
    return { code: null, out: (e as Error).message, err: (e as Error).message };
  }
}

function readOwnCgroup(): string | null {
  try {
    const line = readFileSync("/proc/self/cgroup", "utf8").split("\n").find((l) => l.startsWith("0::"));
    return line ? line.slice(3) : null;
  } catch {
    return null;
  }
}

/**
 * Turn routing on when this host can do it: `systemd-run --user --scope` must work, which also
 * rules out a PPM with no user manager to talk to (a container, a bare SSH login).
 */
export async function initChatSessionProcesses(opts: { dbPath: string; idleMinutes: () => number }): Promise<boolean> {
  if (process.platform !== "linux" || !process.env.XDG_RUNTIME_DIR) return false;
  const systemdRun = Bun.which("systemd-run");
  const systemctl = Bun.which("systemctl");
  if (!systemdRun || !systemctl) return false;
  const probe = await run([systemdRun, "--user", "--scope", "--quiet", "--collect", "--", "true"]);
  if (probe.code !== 0) {
    log.info(`chat commands are not tracked: systemd-run --user --scope failed (${probe.out.trim().slice(0, 200) || probe.code})`);
    return false;
  }
  const appSlice = (await run([systemctl, "--user", "show", "-p", "ControlGroup", "--value", "app.slice"])).out.trim();
  const ownCgroup = readOwnCgroup();
  if (!appSlice || !existsSync(CGROUP_ROOT + appSlice) || !ownCgroup) {
    log.info(`chat commands are not tracked: no cgroup for app.slice (${appSlice || "none"})`);
    return false;
  }
  const instance = instanceTag(opts.dbPath);
  tracking = {
    instance,
    shell: installSessionShell(join(getPpmDir(), "bin", SESSION_SHELL_DIR), systemdRun),
    systemctl,
    // A '-' is a level: app-ppmchat-<instance>.slice sits in app-ppmchat.slice, in app.slice.
    instanceDir: join(CGROUP_ROOT + appSlice, "app-ppmchat.slice", instanceSliceName(instance)),
    ownCgroup,
    idleMinutes: opts.idleMinutes,
  };
  log.info(`chat commands run under ${instanceSliceName(instance)}; what a chat leaves running is stopped after ${opts.idleMinutes()} idle minutes (0 = never)`);
  if (hot.deps) startupSweep(hot.deps);
  return true;
}

/** Whether chats' commands are being routed into session slices on this host. */
export function chatSessionProcessesTracked(): boolean {
  return tracking !== null;
}

/**
 * The environment a chat's Claude CLI is spawned with. Routing applies only while the setting is
 * on; a CLI keeps the environment it started with, so turning it off reaches running CLIs as they
 * are replaced.
 */
export function chatSessionCliEnv(sessionId: string | undefined, env: Record<string, string | undefined>): Record<string, string | undefined> {
  const t = tracking;
  const slice = t && sessionId && t.idleMinutes() > 0 ? sessionSliceName(t.instance, sessionId) : null;
  return withSessionSlice(env, slice, t?.shell ?? null);
}

// ── Snapshot ────────────────────────────────────────────────────────────

function readInts(path: string): number[] {
  try {
    return readFileSync(path, "utf8").split("\n").filter(Boolean).map(Number);
  } catch {
    return [];
  }
}

/** Every pid in a cgroup and the cgroups below it (a service may delegate its own). */
function pidsUnder(dir: string): number[] {
  const pids = readInts(join(dir, "cgroup.procs"));
  try {
    for (const e of readdirSync(dir, { withFileTypes: true })) if (e.isDirectory()) pids.push(...pidsUnder(join(dir, e.name)));
  } catch {}
  return pids;
}

function procStat(pid: number): { comm: string; ppid: number } | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const close = stat.lastIndexOf(")");
    return { comm: stat.slice(stat.indexOf("(") + 1, close), ppid: Number(stat.slice(close + 2).split(" ")[1]) };
  } catch {
    return null;
  }
}

function cgroupOf(pid: number): string | null {
  try {
    const line = readFileSync(`/proc/${pid}/cgroup`, "utf8").split("\n").find((l) => l.startsWith("0::"));
    return line ? line.slice(3) : null;
  } catch {
    return null;
  }
}

/** Some ancestor runs in PPM's own cgroup: the process belongs to a live CLI's command or MCP server. */
function descendsFromPpm(pid: number, ownCgroup: string): boolean {
  let p = procStat(pid)?.ppid ?? 0;
  for (let hops = 0; p > 1 && hops < 64; hops++) {
    if (cgroupOf(p) === ownCgroup) return true;
    p = procStat(p)?.ppid ?? 0;
  }
  return false;
}

function populated(dir: string): boolean {
  try {
    return /^populated 1$/m.test(readFileSync(join(dir, "cgroup.events"), "utf8"));
  } catch {
    return false;
  }
}

/** This PPM's session slices that still hold a process, by session id. */
function sessionSlices(t: Tracking): Map<string, string> {
  const out = new Map<string, string>();
  let names: string[] = [];
  try { names = readdirSync(t.instanceDir); } catch { return out; }
  for (const name of names) {
    const sessionId = sessionIdOfSlice(t.instance, name);
    if (sessionId && populated(join(t.instanceDir, name))) out.set(sessionId, name);
  }
  return out;
}

function snapshotUnits(t: Tracking, slice: string): UnitSnapshot[] {
  const sliceDir = join(t.instanceDir, slice);
  const units: UnitSnapshot[] = [];
  let entries: string[] = [];
  try { entries = readdirSync(sliceDir); } catch { return units; }
  for (const name of entries) {
    if (name.endsWith(".slice") || !/\.(scope|service|socket|timer|path|mount)$/.test(name)) continue;
    const pids = pidsUnder(join(sliceDir, name));
    if (!pids.length) continue;
    units.push({
      name,
      comms: pids.map((p) => procStat(p)?.comm ?? "?"),
      attached: pids.some((p) => descendsFromPpm(p, t.ownCgroup)),
    });
  }
  return units;
}

// ── Stopping ────────────────────────────────────────────────────────────

/** `systemctl stop`'s exit status for a unit that is not loaded: one that has gone already. */
const NOT_LOADED = 5;

/**
 * SIGTERM through systemd, SIGKILL when the unit's stop times out; does not wait for either.
 * `systemctl stop a b c` enqueues nothing at all when any one of them is no longer loaded ("Failed
 * to enqueue jobs: Unit … not loaded."), and a unit ending between the snapshot and the stop is
 * ordinary, so a stop that failed is made again one unit at a time.
 */
function stopUnits(t: Tracking, names: string[]): void {
  if (!names.length) return;
  const stop = (units: string[]) => run([t.systemctl, "--user", "stop", "--no-block", ...units]);
  void stop(names).then(async ({ code }) => {
    if (code === 0) return;
    for (const name of names) {
      const one = await stop([name]);
      if (one.code !== 0 && one.code !== NOT_LOADED) log.warn(`systemctl stop ${name} failed (${one.code}): ${one.err.trim().slice(0, 300)}`);
    }
  });
}

function sweepSession(t: Tracking, deps: SweepDeps, sessionId: string, slice: string, why: "idle" | "startup", now: number): void {
  if (why === "idle") {
    const { busy, lastActiveAt } = deps.activity(sessionId);
    const clock = advanceClock(clocks.get(sessionId), now, busy, lastActiveAt);
    clocks.set(sessionId, clock);
    if (!idlePastLimit(clock, now, busy, t.idleMinutes() * 60_000)) return;
  }
  const stop = unitsToStop(snapshotUnits(t, slice), why);
  if (!stop.length) return;
  const summary = why === "idle"
    ? `stopped what it left running after ${t.idleMinutes()} idle minutes: ${describeUnits(stop)}`
    : `stopped what its commands left running before PPM restarted: ${describeUnits(stop)}`;
  log.info(`session=${sessionId} ${summary}`);
  deps.onStopped?.(sessionId, summary);
  stopUnits(t, stop.map((u) => u.name));
}

/** One pass over every session slice of this PPM. */
export function sweepLeftovers(deps: SweepDeps, why: "idle" | "startup", now = Date.now()): void {
  const t = tracking;
  if (!t) return;
  if (why === "idle" && t.idleMinutes() <= 0) return;
  const slices = sessionSlices(t);
  for (const id of clocks.keys()) if (!slices.has(id)) clocks.delete(id);
  for (const [sessionId, slice] of slices) {
    try {
      sweepSession(t, deps, sessionId, slice, why, now);
    } catch (e) {
      log.warn(`session=${sessionId} leftover sweep failed: ${(e as Error).message}`);
    }
  }
}

function startupSweep(deps: SweepDeps): void {
  if (hot.startupDone) return;
  hot.startupDone = true;
  sweepLeftovers(deps, "startup");
}

/** The chat layer's view of each session, and a sweep every minute once routing is on. */
export function registerLeftoverSweeper(deps: SweepDeps): () => void {
  hot.stop?.();
  hot.deps = deps;
  if (tracking) startupSweep(deps);
  const timer = setInterval(() => sweepLeftovers(deps, "idle"), SWEEP_INTERVAL_MS);
  (timer as { unref?: () => void }).unref?.();
  hot.stop = () => clearInterval(timer);
  return hot.stop;
}

/** The chat was deleted: everything it started goes, running or not. */
export function stopChatSessionProcesses(sessionId: string): void {
  const t = tracking;
  if (!t) return;
  clocks.delete(sessionId);
  const slice = sessionSliceName(t.instance, sessionId);
  if (!slice || !sessionSlices(t).has(sessionId)) return;
  const units = snapshotUnits(t, slice);
  if (units.length) {
    const summary = `stopped everything it was running, as it was deleted: ${describeUnits(units)}`;
    log.info(`session=${sessionId} ${summary}`);
    hot.deps?.onStopped?.(sessionId, summary);
  }
  stopUnits(t, [slice]);
}

/**
 * PPM is shutting down: its chats' commands and MCP servers go with it, as they did when they ran
 * inside PPM's own cgroup. Units an agent started with `systemd-run` stay, as they always have.
 * Synchronous because `process.exit` follows.
 */
export function stopCommandScopesSync(): void {
  const t = tracking;
  if (!t) return;
  const names: string[] = [];
  for (const slice of sessionSlices(t).values()) {
    try {
      for (const name of readdirSync(join(t.instanceDir, slice))) if (isCommandScope(name)) names.push(name);
    } catch {}
  }
  const stop = (units: string[]) =>
    Bun.spawnSync([t.systemctl, "--user", "stop", "--no-block", ...units], { stdout: "ignore", stderr: "ignore" }).exitCode;
  // One scope gone since the listing makes the whole stop enqueue nothing, as in `stopUnits`.
  if (names.length && stop(names) !== 0) for (const name of names) stop([name]);
}
