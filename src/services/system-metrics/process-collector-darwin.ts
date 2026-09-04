/**
 * macOS process collector via `ps` (cheap there, no leak, no `/proc`).
 *
 * Every tick: `pid ppid etime time rss comm` with `comm` LAST because on macOS
 * it is the full executable path and may contain spaces ("Google Chrome").
 * Every 30 s: `pid args` for command lines, merged by pid — the same slow
 * cadence Windows uses for `CommandLine`, and it keeps the per-tick call to one
 * `ps` whose columns can be parsed unambiguously.
 * UNVERIFIED on real macOS hardware; a parse miss yields a warning, never garbage.
 */
import type { Runner } from "../host-info/spawn-runner.ts";
import { defaultRunner } from "../host-info/spawn-runner.ts";
import type { ProcessCollection, ProcessCollector, RawProcessRow } from "./process-collector-types.ts";
import { createStickyColumns } from "./process-collector-types.ts";
import type { ProcessNetCollector } from "./process-net-collector-darwin.ts";

export const DARWIN_TICK_ARGV = ["ps", "-Ao", "pid=,ppid=,etime=,time=,rss=,comm="];
export const DARWIN_ARGS_ARGV = ["ps", "-Ao", "pid=,args="];
export const DARWIN_ARGS_REFRESH_MS = 30_000;
const PS_TIMEOUT_MS = 5000;

/** `[[dd-]hh:]mm:ss[.cs]` → milliseconds; NaN-free (garbage → 0). */
export function parsePsCpuTime(text: string): number {
  const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)$/.exec(text.trim());
  if (!m) return 0;
  const days = Number(m[1] ?? 0);
  const hours = Number(m[2] ?? 0);
  const minutes = Number(m[3]);
  const seconds = Number(m[4]);
  const total = ((days * 24 + hours) * 60 + minutes) * 60 + seconds;
  return Number.isFinite(total) ? Math.round(total * 1000) : 0;
}

const TICK_LINE = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(\d+)\s+(.*)$/;

export function parseDarwinPsTick(text: string, now: number): RawProcessRow[] {
  const rows: RawProcessRow[] = [];
  for (const line of text.split("\n")) {
    const m = TICK_LINE.exec(line);
    if (!m) continue;
    const pid = Number(m[1]);
    if (pid <= 0) continue;
    const elapsedMs = parsePsCpuTime(m[3]!);
    const comm = m[6]!.trim();
    rows.push({
      pid,
      ppid: Number(m[2]),
      name: comm.slice(comm.lastIndexOf("/") + 1) || comm || String(pid),
      command: null,
      cpuMs: parsePsCpuTime(m[4]!),
      ramMB: Number(m[5]) / 1024,
      // etime is 1 s resolution: coarse, but enough as an identity guard.
      startedAt: elapsedMs > 0 ? Math.round((now - elapsedMs) / 1000) * 1000 : 0,
    });
  }
  return rows;
}

export function parseDarwinPsArgs(text: string): Map<number, string> {
  const out = new Map<number, string>();
  for (const line of text.split("\n")) {
    const m = /^\s*(\d+)\s+(.+)$/.exec(line);
    if (m) out.set(Number(m[1]), m[2]!.trim());
  }
  return out;
}

/**
 * `etime` ticks in whole seconds while `now` has ms, so `now - etime` jitters by
 * up to a second between ticks. Pin each pid to the first value seen so the CPU
 * delta key `${pid}:${startedAt}` stays stable; a jump beyond the jitter means
 * the pid really was recycled.
 */
export function stabilizeStartedAt(rows: RawProcessRow[], memo: Map<number, number>): RawProcessRow[] {
  const seen = new Set<number>();
  for (const r of rows) {
    seen.add(r.pid);
    const cached = memo.get(r.pid);
    if (cached !== undefined && Math.abs(cached - r.startedAt) <= 2000) r.startedAt = cached;
    else memo.set(r.pid, r.startedAt);
  }
  for (const pid of memo.keys()) if (!seen.has(pid)) memo.delete(pid);
  return rows;
}

export interface DarwinProcessCollectorOptions {
  /** Omitted or null → no per-process network sample. The production wiring in
   *  `system-metrics-platform.ts` injects it, so a unit test never spawns
   *  `nettop` by accident. */
  net?: ProcessNetCollector | null;
}

export function createDarwinProcessCollector(
  run: Runner = defaultRunner,
  now: () => number = Date.now,
  opts: DarwinProcessCollectorOptions = {},
): ProcessCollector {
  let argsByPid = new Map<number, string>();
  let lastArgsAt = Number.NEGATIVE_INFINITY;
  const startedAtMemo = new Map<number, number>();
  const net = opts.net ?? null;
  const observeColumns = createStickyColumns();

  return {
    stop: () => {},
    async collect(): Promise<ProcessCollection> {
      const warnings: string[] = [];
      const tick = await run(DARWIN_TICK_ARGV, PS_TIMEOUT_MS);
      if (tick.code !== 0 || tick.timedOut) {
        return {
          rows: [],
          columns: observeColumns({}),
          warnings: [`Process list unavailable: ps exited ${tick.code ?? "on timeout"}`],
        };
      }
      const t = now();
      if (t - lastArgsAt >= DARWIN_ARGS_REFRESH_MS) {
        const args = await run(DARWIN_ARGS_ARGV, PS_TIMEOUT_MS);
        if (args.code === 0 && !args.timedOut) {
          argsByPid = parseDarwinPsArgs(args.stdout);
          lastArgsAt = t;
        } else {
          warnings.push("Command lines unavailable: ps args query failed");
        }
      }
      const netByPid = (await net?.collect()) ?? null;
      const rows = stabilizeStartedAt(parseDarwinPsTick(tick.stdout, t), startedAtMemo)
        .map((r) => ({
          ...r,
          command: argsByPid.get(r.pid) ?? null,
          // nettop lists only processes with sockets, so a missing pid means
          // "measured, no traffic".
          netInBytes: netByPid ? netByPid.get(r.pid)?.inBytes ?? 0 : undefined,
          netOutBytes: netByPid ? netByPid.get(r.pid)?.outBytes ?? 0 : undefined,
        }));
      if (rows.length === 0) warnings.push("Process list unavailable: ps output did not parse");
      // Disk and GPU have no per-process source on macOS without private APIs.
      return { rows, columns: observeColumns({ net: netByPid !== null }), warnings };
    },
  };
}
