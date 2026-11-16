import { statSync } from "node:fs";
import { join } from "node:path";
import type { Json } from "../mcp-http-endpoint.ts";
import { readFileChunks } from "../file-chunks.ts";
import { getPpmDir } from "../ppm-dir.ts";
import { splitRuns, type DiagLine } from "../memory-diagnostics-report.ts";
import { boundedJson, MAX_MEMORY_ROWS, timeWindow } from "./assistant-system-tool-definitions.ts";
import { errorResult } from "./assistant-tool-output.ts";
import { searchLogLines } from "./assistant-system-logs-tool.ts";

/**
 * `ppm_memory_report`: the samples `PPM_MEM_DIAG=1` writes, read for a time window, plus the
 * watchdog's `[mem]` warnings, which are always on. The log is up to 50 MB and a rotated copy as
 * much again, so it is never read whole: the window's first line is found by bisection over byte
 * offsets, then lines are read forward in chunks (never `Bun.file().stream()`, which keeps a
 * file's size in native memory per read) until the window ends or a byte cap is reached.
 */

/** The most bytes one call scans after the window's start. */
const MAX_SCAN_BYTES = 32 * 1024 * 1024;
/** Bisection stops once the range is this small, and each probe reads this much. */
const PROBE_BYTES = 64 * 1024;
const MAX_WARNINGS = 30;

type Sample = DiagLine & { externalMB?: number };

/** The first sample time in a probe window: the first whole line's `t`, or null if none parses. */
async function probeTime(path: string, at: number): Promise<number | null> {
  let text = "";
  for await (const chunk of readFileChunks(path, { fromByte: at, toByte: at + PROBE_BYTES })) text += Buffer.from(chunk).toString("utf8");
  const lines = text.split("\n").slice(at === 0 ? 0 : 1, -1);
  for (const line of lines) {
    const t = lineTime(line);
    if (t !== null) return t;
  }
  return null;
}

function lineTime(line: string): number | null {
  const m = /"t":"([^"]+)"/.exec(line.slice(0, 200));
  const ms = m ? Date.parse(m[1]!) : NaN;
  return Number.isFinite(ms) ? ms : null;
}

/** A byte offset at or before the first line written at `from` or later. */
async function windowStart(path: string, size: number, from: number): Promise<number> {
  let lo = 0;
  let hi = size;
  while (hi - lo > PROBE_BYTES) {
    const mid = Math.floor((lo + hi) / 2);
    const t = await probeTime(path, mid);
    // An unreadable probe (a line longer than the probe) moves forward: scanning a little early
    // costs time, never a missed sample.
    if (t === null || t < from) lo = mid; else hi = mid;
  }
  return lo;
}

/** The fields the report keeps, so a long window holds small objects, not whole log lines. */
function compact(line: string): Sample | null {
  try {
    const o = JSON.parse(line) as Record<string, unknown>;
    if (typeof o.t !== "string" || o.alert || o.snapshot || typeof o.rssMB !== "number") return null;
    const n = (k: string) => (typeof o[k] === "number" ? (o[k] as number) : undefined);
    return { t: o.t, pid: n("pid"), upMin: n("upMin"), rssMB: n("rssMB"), privateMB: n("privateMB"), heapMB: n("heapMB"), externalMB: n("externalMB"), handles: n("handles") };
  } catch {
    return null; // a line cut by a crash mid-write
  }
}

/** Samples of one file inside the window, and whether the byte cap stopped the scan. */
export async function readDiagWindow(path: string, from: number, to: number, budget = { bytes: MAX_SCAN_BYTES }): Promise<{ samples: Sample[]; capped: boolean }> {
  let size: number;
  try { size = statSync(path).size; } catch { return { samples: [], capped: false }; }
  const start = await windowStart(path, size, from);
  const samples: Sample[] = [];
  let rest = "";
  let first = start > 0;
  // Streaming decode: a chunk boundary may fall inside a multi-byte character.
  const decoder = new TextDecoder();
  for await (const chunk of readFileChunks(path, { fromByte: start })) {
    budget.bytes -= chunk.byteLength;
    const lines = (rest + decoder.decode(chunk, { stream: true })).split("\n");
    rest = lines.pop() ?? "";
    if (first) { lines.shift(); first = false; } // the line the offset landed inside
    for (const line of lines) {
      const t = lineTime(line);
      if (t === null || t < from) continue;
      if (t > to) return { samples, capped: false };
      const s = compact(line);
      if (s) samples.push(s);
    }
    if (budget.bytes <= 0) return { samples, capped: true };
  }
  const s = rest && (lineTime(rest) ?? -1) >= from ? compact(rest) : null;
  if (s && Date.parse(s.t) <= to) samples.push(s);
  return { samples, capped: false };
}

/** At most `max` rows spread evenly over `list`, first and last always kept. */
export function downSample<T>(list: readonly T[], max: number): T[] {
  if (list.length <= max) return [...list];
  const out: T[] = [];
  for (let i = 0; i < max; i++) out.push(list[Math.round((i * (list.length - 1)) / (max - 1))]!);
  return out;
}

const row = (s: Sample) => ({
  t: s.t, pid: s.pid ?? null, upMin: s.upMin ?? null, rss: s.rssMB ?? null, private: s.privateMB ?? null,
  heap: s.heapMB ?? null, external: s.externalMB ?? null, handles: s.handles ?? null,
});

export async function ppmMemoryReport(args: Record<string, unknown>, signal?: AbortSignal, now = Date.now()): Promise<Json> {
  const role = args.role ?? "server";
  if (role !== "server" && role !== "supervisor") return errorResult("`role` must be server or supervisor.");
  const window = timeWindow(args, now);
  if ("error" in window) return errorResult(window.error);
  const file = join(getPpmDir(), role === "server" ? "mem-diag.log" : "mem-diag-supervisor.log");
  const budget = { bytes: MAX_SCAN_BYTES };
  // The rotated copy holds the older samples, so it is read first.
  const older = await readDiagWindow(`${file}.1`, window.from, window.to, budget);
  const newer = older.capped ? { samples: [], capped: true } : await readDiagWindow(file, window.from, window.to, budget);
  const samples = [...older.samples, ...newer.samples];
  const runs = splitRuns(samples).map((run) => {
    const a = run[0]!;
    const z = run[run.length - 1]!;
    const peak = (k: "privateMB" | "rssMB") => run.reduce<number | null>((m, s) => (s[k] === undefined ? m : Math.max(m ?? 0, s[k]!)), null);
    return {
      pid: a.pid ?? null, from: a.t, to: z.t, samples: run.length,
      privateFirst: a.privateMB ?? null, privateLast: z.privateMB ?? null, privatePeak: peak("privateMB"), rssPeak: peak("rssMB"),
    };
  });

  // The watchdog logs under the `mem` scope; a record's searchable text starts with its tag.
  const { lines: memWarnings } = await searchLogLines({
    source: "all", level: "warn", limit: MAX_WARNINGS, from: window.from, to: window.to, pattern: "^mem ", regex: true,
  }, signal);

  const rows = downSample(samples, MAX_MEMORY_ROWS).map(row);
  return boundedJson({
    window: { from: new Date(window.from).toISOString(), to: new Date(window.to).toISOString() },
    file: role === "server" ? "mem-diag.log" : "mem-diag-supervisor.log",
    units: "MB; upMin in minutes",
    samplesInWindow: samples.length,
    ...(samples.length === 0 ? { note: "No samples in this window. mem-diag.log is written only while PPM runs with PPM_MEM_DIAG=1; the [mem] warnings below are always kept." } : {}),
    ...(older.capped || newer.capped ? { capped: `Stopped after scanning ${MAX_SCAN_BYTES / 1024 / 1024} MB; narrow the window for later samples.` } : {}),
    runs,
    memWarnings,
    rows,
  }, { key: "rows", list: rows });
}
