/**
 * Zero-IO parser for the tagged, tab-separated lines one Windows tick returns:
 *
 *   P<TAB>pid<TAB>ppid<TAB>Name<TAB>KernelModeTime<TAB>UserModeTime<TAB>WorkingSetSize<TAB>CreationDateUtcTicks<TAB>ReadTransferCount<TAB>WriteTransferCount
 *   C<TAB>pid<TAB>CreationDateUtcTicks<TAB>CommandLine            (every 30 s only)
 *   D… / N…                                                       (disk/net counters)
 *   G… / M…                                                       (per-process GPU)
 *   __ERR__ <message>                                             (a failed block)
 *
 * `CommandLine` is always the LAST field and may itself contain tabs, so rows
 * are split with a field limit — a naive `split("\t")` corrupts them.
 *
 * The two transfer counts are appended AFTER the creation ticks so a `P` row
 * from an older shape (or a host where the properties are empty) still parses,
 * it just reports no disk figures.
 */
import { parsePerfRawDiskNet } from "./disk-net-collector-windows.ts";
import { parseGpuLines, type ParsedGpuLines } from "./gpu-process-usage-windows.ts";
import type { CounterSample } from "./rate-delta.ts";
import { stripExecutableExtension, type RawProcessRow } from "./process-collector-types.ts";

export interface WindowsCommandLine {
  pid: number;
  startedAt: number;
  command: string;
}

export interface ParsedWindowsTick {
  /** PID 0 (System Idle Process) is excluded — its kernel time is idle time and
   *  inflates a naive CPU roll-up to ~99 %. */
  processes: RawProcessRow[];
  /** Null when the tick carried no `C` section. */
  commands: WindowsCommandLine[] | null;
  disk: CounterSample | null;
  net: CounterSample | null;
  /** Raw per-process GPU samples; the collector turns them into rates. */
  gpu: ParsedGpuLines;
  errors: string[];
}

/** .NET ticks (100 ns since 0001-01-01) → Unix epoch ms. Input MUST already be
 *  UTC — the query calls `.ToUniversalTime()` because only .NET on that machine
 *  knows the DST rule in force when the process started. BigInt because the
 *  tick value exceeds 2^53. */
export function ticksToEpochMs(ticks: string): number {
  if (!/^\d+$/.test(ticks)) return 0;
  const EPOCH_TICKS = 621355968000000000n;
  const ms = (BigInt(ticks) - EPOCH_TICKS) / 10000n;
  return ms > 0n ? Number(ms) : 0;
}

/** Split into at most `limit` fields; the remainder stays glued to the last one. */
export function splitLimited(line: string, limit: number): string[] {
  const out: string[] = [];
  let start = 0;
  while (out.length < limit - 1) {
    const i = line.indexOf("\t", start);
    if (i < 0) break;
    out.push(line.slice(start, i));
    start = i + 1;
  }
  out.push(line.slice(start));
  return out;
}

const HUNDRED_NS_PER_MS = 10_000;
const BYTES_PER_MB = 1024 * 1024;

/** An empty (property absent / access denied) or non-numeric counter field is
 *  "the OS did not say", which must stay `undefined` rather than become 0. */
function optionalCount(field: string | undefined): number | undefined {
  const text = (field ?? "").trim();
  if (!/^\d+$/.test(text)) return undefined;
  const n = Number(text);
  return Number.isFinite(n) ? n : undefined;
}

function parseProcessLine(f: string[]): RawProcessRow | null {
  const pid = Number(f[1]);
  const ppid = Number(f[2]);
  const kernel = Number(f[4]);
  const user = Number(f[5]);
  const ws = Number(f[6]);
  if (![pid, ppid, kernel, user, ws].every(Number.isFinite)) return null;
  if (pid === 0) return null;
  return {
    pid,
    ppid: ppid >= 0 ? ppid : -1,
    name: stripExecutableExtension((f[3] ?? "").trim()) || String(pid),
    command: null,
    cpuMs: (kernel + user) / HUNDRED_NS_PER_MS,
    ramMB: ws / BYTES_PER_MB,
    startedAt: ticksToEpochMs((f[7] ?? "").trim()),
    diskReadBytes: optionalCount(f[8]),
    diskWriteBytes: optionalCount(f[9]),
  };
}

/** `CommandLine` arrives base64(UTF-8) because argv is attacker-controlled and
 *  the transport is line-framed. Anything that is not valid base64 is dropped —
 *  a raw string here means the field was tampered with, not that it is a command. */
export function decodeCommandLine(b64: string): string {
  if (!b64 || !/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) return "";
  try {
    return Buffer.from(b64, "base64").toString("utf-8").trim();
  } catch {
    return "";
  }
}

export function parseWindowsTick(text: string): ParsedWindowsTick {
  const processes: RawProcessRow[] = [];
  let commands: WindowsCommandLine[] | null = null;
  const counterLines: string[] = [];
  const gpuLines: string[] = [];
  const errors: string[] = [];

  for (const raw of text.split("\n")) {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (!line) continue;
    switch (line.slice(0, 2)) {
      case "P\t": {
        const row = parseProcessLine(splitLimited(line, 10));
        if (row) processes.push(row);
        break;
      }
      case "C\t": {
        const f = splitLimited(line, 4);
        const pid = Number(f[1]);
        // A `C` section that exists but is all-null still counts as fetched.
        commands ??= [];
        if (!Number.isFinite(pid) || f.length < 4) break;
        const command = decodeCommandLine((f[3] ?? "").trim());
        if (command) commands.push({ pid, startedAt: ticksToEpochMs((f[2] ?? "").trim()), command });
        break;
      }
      case "D\t":
      case "N\t":
        counterLines.push(line);
        break;
      case "G\t":
      case "M\t":
        gpuLines.push(line);
        break;
      default:
        if (line.startsWith("__ERR__")) errors.push(line.slice("__ERR__".length).trim());
        break;
    }
  }

  const { disk, net } = parsePerfRawDiskNet(counterLines);
  return { processes, commands, disk, net, gpu: parseGpuLines(gpuLines), errors };
}
