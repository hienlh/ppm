/**
 * Event-loop lag, and — the part that decides what to do about it — whether the
 * time was ours.
 *
 * PPM serves every HTTP request, every WebSocket frame and all of the chat work
 * from one Bun process with one event loop, so anything synchronous holds up
 * everything else for exactly as long as it runs. That is measurable from
 * outside (`/api/health`, which returns a literal, has been seen taking 18.9s on
 * a busy instance against 0.12-0.65ms on an idle one of the same binary), but
 * from outside it names no culprit.
 *
 * A late tick means one of two things, and they are fixed in different places:
 *
 *   - **self** — the loop was busy with our own synchronous work, or with GC.
 *     Worth hunting: a blocking call, a whole-file read, a synchronous DB write.
 *   - **starved** — the OS gave the CPU to something else. PPM shares a machine,
 *     and when a chat session spawns them a *cgroup*, with compilers, browsers
 *     and one `claude` process per session. Nothing in this repository fixes
 *     that; moving work to another thread least of all, since the CPU was never
 *     ours to move it to.
 *
 * Sampling `process.cpuUsage()` across the same gap tells them apart: time we
 * burned is ours, time we did not is somebody else's. Without that, "the server
 * stalled" is a fact with two opposite conclusions.
 *
 * The monitor costs one timer and two counter reads per tick. It holds its
 * samples in memory and writes nothing to disk — `~/.ppm/ppm.log` is already
 * 261 MB with 54% of its lines duplicated, and a diagnostic that makes the
 * problem it diagnoses worse is not one.
 */

/** How often the monitor checks in. */
export const TICK_MS = 250;

/** A tick at least this late is recorded. One whole interval of slip. */
export const REPORT_THRESHOLD_MS = 250;

/** Samples kept. At one stall per tick this is ~50s of solid stalling. */
export const MAX_SAMPLES = 240;

/** CPU/wall at or above this during the gap: the loop was busy with our work. */
export const SELF_RATIO = 0.7;

/** CPU/wall at or below this: the process was not running for most of the gap. */
export const STARVED_RATIO = 0.25;

export type LagCause = "self" | "starved" | "mixed";

export interface LagSample {
  /** Epoch ms at which the late tick finally ran. */
  at: number;
  /** How much later than scheduled it ran. */
  lagMs: number;
  /** Process CPU (user + system) consumed across the same gap. */
  cpuMs: number;
  /** Resident set at that moment, to spot a stall that is really GC pressure. */
  rssMb: number;
  cause: LagCause;
}

export interface LagReport {
  /** Whether the monitor is running. */
  running: boolean;
  /** Ticks observed since it started. */
  ticks: number;
  /** Ticks that slipped past the threshold. */
  stalls: number;
  /** Total slip across those, in ms. */
  blockedMs: number;
  /** The single worst slip seen, in ms. */
  worstMs: number;
  /** Wall time the monitor has been running, in ms. */
  uptimeMs: number;
  /** Share of wall time the loop was unavailable, 0-1. */
  blockedFraction: number;
  /** How the stalls broke down. */
  byCause: Record<LagCause, number>;
  /** Most recent stalls, newest last. */
  samples: LagSample[];
}

/**
 * Which of the two stories the numbers tell.
 *
 * The ratio can exceed 1: `cpuUsage` counts every thread, and Bun runs file
 * system work on a pool, so a gap spent in parallel IO bills more CPU than wall
 * time passed. That is still our own work, which is what the answer says.
 */
export function classifyLag(lagMs: number, cpuMs: number): LagCause {
  if (lagMs <= 0) return "self";
  const ratio = cpuMs / lagMs;
  if (ratio >= SELF_RATIO) return "self";
  if (ratio <= STARVED_RATIO) return "starved";
  return "mixed";
}

/**
 * Fold one observation into a sample, or return null when the tick was on time.
 *
 * Split out from the timer so the arithmetic — which is the whole of the
 * measurement — can be tested without waiting for real stalls to happen.
 */
export function sampleFromTick(args: {
  now: number;
  elapsedMs: number;
  cpuMicros: number;
  rssBytes: number;
  thresholdMs?: number;
}): LagSample | null {
  const lagMs = args.elapsedMs - TICK_MS;
  if (lagMs < (args.thresholdMs ?? REPORT_THRESHOLD_MS)) return null;
  const cpuMs = args.cpuMicros / 1000;
  return {
    at: args.now,
    lagMs: Math.round(lagMs),
    cpuMs: Math.round(cpuMs),
    rssMb: Math.round(args.rssBytes / 1048576),
    cause: classifyLag(lagMs, cpuMs),
  };
}

// ─── Monitor ───────────────────────────────────────────────────────────

let timer: ReturnType<typeof setInterval> | null = null;
let samples: LagSample[] = [];
let startedAt = 0;
let lastAt = 0;
let lastCpu: { user: number; system: number } | null = null;
let ticks = 0;
let stalls = 0;
let blockedMs = 0;
let worstMs = 0;

function tick(): void {
  const now = Date.now();
  const cpu = process.cpuUsage();
  const elapsedMs = now - lastAt;
  const cpuMicros = lastCpu
    ? cpu.user - lastCpu.user + (cpu.system - lastCpu.system)
    : 0;
  lastAt = now;
  lastCpu = cpu;
  ticks++;

  const sample = sampleFromTick({
    now,
    elapsedMs,
    cpuMicros,
    rssBytes: process.memoryUsage.rss(),
  });
  if (!sample) return;

  stalls++;
  blockedMs += sample.lagMs;
  if (sample.lagMs > worstMs) worstMs = sample.lagMs;
  samples.push(sample);
  if (samples.length > MAX_SAMPLES) samples.shift();
}

/** Idempotent: calling it twice does not start a second timer. */
export function startLagMonitor(): void {
  if (timer) return;
  startedAt = Date.now();
  lastAt = startedAt;
  lastCpu = process.cpuUsage();
  ticks = 0;
  stalls = 0;
  blockedMs = 0;
  worstMs = 0;
  samples = [];
  timer = setInterval(tick, TICK_MS);
  // The monitor must never be the reason the process stays alive.
  (timer as unknown as { unref?: () => void }).unref?.();
}

export function stopLagMonitor(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
  lastCpu = null;
}

export function lagReport(): LagReport {
  const uptimeMs = startedAt ? Date.now() - startedAt : 0;
  const byCause: Record<LagCause, number> = { self: 0, starved: 0, mixed: 0 };
  for (const s of samples) byCause[s.cause]++;
  return {
    running: timer !== null,
    ticks,
    stalls,
    blockedMs,
    worstMs,
    uptimeMs,
    blockedFraction: uptimeMs > 0 ? blockedMs / uptimeMs : 0,
    byCause,
    samples: [...samples],
  };
}

/** Test seam: drop every counter and sample without touching the timer. */
export function resetLagMonitorForTest(): void {
  samples = [];
  ticks = 0;
  stalls = 0;
  blockedMs = 0;
  worstMs = 0;
  startedAt = 0;
}
