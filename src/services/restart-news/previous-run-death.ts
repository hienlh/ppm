import { describeGrowth, fastestGrowth, type MemoryPulse } from "../memory-pulse.ts";
import { commitExhausted } from "../system-commit.ts";
import type { StartReason } from "./start-reason.ts";

/**
 * Why the previous PPM is gone, when it went without stopping: read by a supervisor that starts
 * while `status.json` still names a supervisor that is no longer running.
 *
 * The case it exists for: on 20/11/2026 the machine ran out of commit, the server and the
 * supervisor died in the same second without a log line, and the next start called itself
 * "manual — PPM was started". The evidence was all on disk — Windows' own low-memory event and
 * the server's last memory readings — and is read back here, so the restart news says "out of
 * memory" and names what was growing, as measurements rather than blame.
 */

/** A low-memory report from the OS, at `t` (ms). */
export interface OomEvent {
  t: number;
  source: string;
}

export interface PreviousRunFacts {
  /** `status.json` as the dead run left it. */
  prevStatus: Record<string, unknown>;
  supervisorAlive: boolean;
  /** The dead server's memory pulse (`memory-pulse.ts`), when it left one. */
  pulse: MemoryPulse | null;
  /** OS low-memory reports around the last reading. */
  oomEvents: OomEvent[];
  /**
   * When the machine started (ms), and when the dead run last wrote `status.json`. A run whose
   * last sign of life is older than the boot ended with the machine, which the boot reason
   * already says; it is not called a crash.
   */
  bootAt?: number | null;
  statusWrittenAt?: number | null;
}

/** The window around the last reading in which an OS low-memory report is taken as this death's. */
export const OOM_EVENT_BEFORE_MS = 2 * 60_000;
export const OOM_EVENT_AFTER_MS = 10 * 60_000;

const hhmmss = (ms: number) => new Date(ms).toISOString().slice(11, 19) + "Z";
const gb = (mb: number) => (mb / 1024).toFixed(1);

/** The run's states in which a missing supervisor means it died rather than was stopped. */
const LIVE_STATES = new Set(["running", "paused", "upgrading"]);

/**
 * The start reason for the run after a death, or null when the previous run did not die (it is
 * still running, was stopped, or left no status at all). `oom` needs evidence: an OS report near
 * the last reading, or free commit nearly gone at that reading. Otherwise it is a `crash` whose
 * note says what is known.
 */
export function diagnosePreviousRunDeath(f: PreviousRunFacts): StartReason | null {
  const supervisorPid = f.prevStatus.supervisorPid;
  if (typeof supervisorPid !== "number" || f.supervisorAlive) return null;
  if (!LIVE_STATES.has(String(f.prevStatus.state))) return null;

  const samples = f.pulse?.samples ?? [];
  const last = samples[samples.length - 1];
  const lastSign = last?.t ?? f.statusWrittenAt ?? null;
  if (f.bootAt != null && lastSign !== null && lastSign < f.bootAt) return null;
  const growth = fastestGrowth(samples);
  const commit = last?.commit ?? null;
  const exhausted = commitExhausted(commit);
  const event = f.oomEvents.length
    ? [...f.oomEvents].sort((a, b) => a.t - b.t)[0]!
    : null;

  const parts: string[] = [];
  if (event || exhausted) {
    parts.push(event ? `${event.source} reported low memory at ${hhmmss(event.t)}` : `free commit was ${gb(commit!.freeMB)} of ${gb(commit!.limitMB)} GB`);
    if (growth) parts.push(`${describeGrowth(growth)} before it`);
    if (event && commit) parts.push(`free commit ${gb(commit.freeMB)} of ${gb(commit.limitMB)} GB at the last reading`);
    return { kind: "oom", detail: parts.join("; ") };
  }
  parts.push(`the previous supervisor (pid ${supervisorPid}) was gone without stopping`);
  if (last) {
    parts.push(`last memory reading at ${hhmmss(last.t)}`);
    if (commit) parts.push(`free commit ${gb(commit.freeMB)} of ${gb(commit.limitMB)} GB`);
  }
  return { kind: "crash", detail: parts.join("; ") };
}

/** The window to ask the OS for low-memory reports in: around the last reading, else the last hour. */
export function oomEventWindow(pulse: MemoryPulse | null, now: number): { from: number; to: number } {
  const last = pulse?.samples[pulse.samples.length - 1];
  if (!last) return { from: now - 60 * 60_000, to: now };
  return { from: last.t - OOM_EVENT_BEFORE_MS, to: Math.min(now, last.t + OOM_EVENT_AFTER_MS) };
}

/** The `<TimeCreated SystemTime="…"/>` of every event in `wevtutil … /f:xml` output. Exported for tests. */
export function parseWevtutilTimes(xml: string): number[] {
  const out: number[] = [];
  for (const m of xml.matchAll(/<TimeCreated SystemTime=['"]([^'"]+)['"]/g)) {
    const t = Date.parse(m[1]!);
    if (Number.isFinite(t)) out.push(t);
  }
  return out;
}

/** Lines of `journalctl -o short-unix`: the leading epoch seconds of each. Exported for tests. */
export function parseJournalUnixTimes(text: string): number[] {
  const out: number[] = [];
  for (const line of text.split("\n")) {
    const m = /^(\d+(?:\.\d+)?)\s/.exec(line);
    if (m) out.push(Math.round(Number(m[1]) * 1000));
  }
  return out;
}

async function run(cmd: string[], timeoutMs: number): Promise<string> {
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    // Throws synchronously when the binary is missing.
    proc = Bun.spawn({ cmd, stdout: "pipe", stderr: "ignore", stdin: "ignore", windowsHide: true });
  } catch {
    return "";
  }
  const timer = setTimeout(() => { try { proc.kill(); } catch { /* gone */ } }, timeoutMs);
  try {
    return await new Response(proc.stdout as ReadableStream).text();
  } catch {
    return "";
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The OS's own low-memory reports between `from` and `to`. Windows: the Resource Exhaustion
 * Detector, whose Operational channel keeps id 1003 even when the detector itself could not
 * allocate enough to write the System log's 2004 (exactly what happened on 20/11). Linux: the
 * kernel's OOM killer lines. Empty when unreadable; never throws.
 */
export async function readOomEvents(from: number, to: number, platform: NodeJS.Platform = process.platform): Promise<OomEvent[]> {
  const iso = (ms: number) => new Date(ms).toISOString();
  if (platform === "win32") {
    const range = `TimeCreated[@SystemTime>='${iso(from)}' and @SystemTime<='${iso(to)}']`;
    const queries: Array<[string, string]> = [
      ["Microsoft-Windows-Resource-Exhaustion-Detector/Operational", `*[System[(EventID=1003) and ${range}]]`],
      ["System", `*[System[Provider[@Name='Microsoft-Windows-Resource-Exhaustion-Detector'] and (EventID=2004) and ${range}]]`],
    ];
    const out: OomEvent[] = [];
    for (const [channel, q] of queries) {
      const xml = await run(["wevtutil", "qe", channel, `/q:${q}`, "/f:xml", "/c:5"], 5000);
      for (const t of parseWevtutilTimes(xml)) out.push({ t, source: "Windows" });
    }
    return out;
  }
  if (platform === "linux") {
    const text = await run([
      "journalctl", "-k", "-q", "-o", "short-unix", "--no-pager",
      "--since", `@${Math.floor(from / 1000)}`, "--until", `@${Math.ceil(to / 1000)}`,
      "-g", "Out of memory|oom-kill",
    ], 5000);
    return parseJournalUnixTimes(text).map((t) => ({ t, source: "the kernel" }));
  }
  return [];
}

/** Whether `status.json` was last written before the machine started. False when either is unknown. */
export function statusFromEarlierBoot(boot: { bootAt?: number | null; statusWrittenAt?: number | null }): boolean {
  return boot.bootAt != null && boot.statusWrittenAt != null && boot.statusWrittenAt < boot.bootAt;
}

/**
 * Whether the supervisor `prevStatus` names is gone while its run was live (running, paused or
 * mid-upgrade): it died rather than was stopped. False for this process's own pid (a reused pid
 * is not the old supervisor coming back), for a stopped run, and when there is no status.
 */
export function previousSupervisorDied(
  prevStatus: Record<string, unknown>,
  boot: { bootAt?: number | null; statusWrittenAt?: number | null } = {},
): boolean {
  const pid = prevStatus.supervisorPid;
  if (typeof pid !== "number" || !LIVE_STATES.has(String(prevStatus.state))) return false;
  // Written before this boot: the run ended with the machine, and every pid in it may now name
  // some other program (status.json survives a reboot).
  if (statusFromEarlierBoot(boot)) return false;
  if (pid === process.pid) return true;
  try { process.kill(pid, 0); return false; } catch { return true; }
}

/**
 * {@link diagnosePreviousRunDeath} on the live machine: whether the supervisor `prevStatus` names is
 * alive, its server's memory pulse, and the OS's low-memory reports around the last reading. The
 * reports are only asked for when the previous run did die. Never throws.
 */
export async function readPreviousRunDeath(
  prevStatus: Record<string, unknown>,
  ppmDir: string,
  opts: { now?: number; bootAt?: number | null; statusWrittenAt?: number | null } = {},
): Promise<StartReason | null> {
  const now = opts.now ?? Date.now();
  try {
    if (!previousSupervisorDied(prevStatus, opts)) return null;
    const supervisorAlive = false;
    const { readPulse } = await import("../memory-pulse.ts");
    const pulse = typeof prevStatus.pid === "number" ? readPulse(ppmDir, prevStatus.pid) : null;
    const window = oomEventWindow(pulse, now);
    const oomEvents = await readOomEvents(window.from, window.to);
    return diagnosePreviousRunDeath({ prevStatus, supervisorAlive, pulse, oomEvents, bootAt: opts.bootAt, statusWrittenAt: opts.statusWrittenAt });
  } catch {
    return null;
  }
}
