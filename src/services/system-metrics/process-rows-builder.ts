/**
 * Raw collector rows → `ProcessInfo[]` for one tick: instantaneous CPU%, the
 * cosmetic `ppm` flag, the guard-derived `protected` flag and a redacted,
 * truncated command line.
 */
import type { MetricsPlatform, ProcessInfo } from "../../types/system-metrics.ts";
import { redactSecrets } from "../redact-secrets.ts";
import type { RawProcessRow } from "./process-collector-types.ts";
import { computeCpuPercents, cpuSampleKey, type CpuDeltaState } from "./process-cpu-delta.ts";
import { computeProcIoRates, type ProcIoDeltaState } from "./process-io-delta.ts";
import { checkKillAllowed, type KillGuardContext } from "./kill-guard.ts";
import { buildGuardMaps, type GuardMaps } from "./kill-identity-resolver.ts";
import { computePpmPids } from "./ppm-process-ownership.ts";
import type { ProtectedPids } from "./ppm-protected-pids.ts";

/** Command lines are for recognising a process, not for archiving it. A 400-row
 *  frame measured ~120 KB at 300 chars; 160 keeps it recognisable in a table
 *  column while cutting roughly a quarter of every 2 s frame over the tunnel. */
export const COMMAND_MAX_CHARS = 160;

export interface BuildRowsInput {
  rows: readonly RawProcessRow[];
  platform: MetricsPlatform;
  coreCount: number;
  now: number;
  prevCpu: CpuDeltaState | null;
  prevIo: ProcIoDeltaState | null;
  /** Resolved against THIS tick's rows, so liveness means "present in the table". */
  resolveProtected: (isAlive: (pid: number) => boolean, nameOf: (pid: number) => string | undefined) => ProtectedPids;
}

export interface BuiltRows {
  processes: ProcessInfo[];
  nextCpu: CpuDeltaState;
  nextIo: ProcIoDeltaState;
  guardCtx: KillGuardContext;
  protectedPids: ProtectedPids;
  maps: GuardMaps;
}

/** Redact first, truncate second: secrets live at the front of argv. */
export function sanitizeCommand(command: string | null, fallback: string): string {
  if (!command) return fallback;
  const redacted = redactSecrets(command);
  return redacted.length > COMMAND_MAX_CHARS ? redacted.slice(0, COMMAND_MAX_CHARS) : redacted;
}

export function buildProcessRows(input: BuildRowsInput): BuiltRows {
  const { platform } = input;
  const maps = buildGuardMaps(input.rows);
  // Only the de-duplicated rows are trusted from here on.
  const rows = [...maps.byPid.values()];
  const protectedPids = input.resolveProtected(
    (pid) => maps.byPid.has(pid),
    (pid) => maps.byPid.get(pid)?.name.toLowerCase(),
  );
  const guardCtx: KillGuardContext = {
    platform,
    protectedPids: protectedPids.pids,
    ppidOf: maps.ppidOf,
    startedAtOf: maps.startedAtOf,
  };
  const ppmPids = computePpmPids({
    roots: protectedPids.roots,
    extraPids: [...protectedPids.pids],
    ppidOf: maps.ppidOf,
    startedAtOf: maps.startedAtOf,
  });

  const samples = rows.map((r) => ({ key: cpuSampleKey(r.pid, r.startedAt), cpuMs: r.cpuMs }));
  const { percentByKey, next } = computeCpuPercents(input.prevCpu, samples, input.now, input.coreCount);
  // Same key and the same wall interval as the CPU delta, so a row's CPU% and
  // its Bps figures can never describe two different spans of time.
  const io = computeProcIoRates(
    input.prevIo,
    rows.map((r) => ({
      key: cpuSampleKey(r.pid, r.startedAt),
      diskReadBytes: r.diskReadBytes,
      diskWriteBytes: r.diskWriteBytes,
      netInBytes: r.netInBytes,
      netOutBytes: r.netOutBytes,
    })),
    input.now,
  );

  const processes: ProcessInfo[] = rows.map((r) => {
    const key = cpuSampleKey(r.pid, r.startedAt);
    const rates = io.ratesByKey.get(key);
    return {
      pid: r.pid,
      ppid: r.ppid,
      name: r.name,
      command: sanitizeCommand(r.command, r.name),
      cpu: percentByKey.get(key) ?? 0,
      ramMB: Math.round(r.ramMB * 10) / 10,
      startedAt: r.startedAt,
      ppm: ppmPids.has(r.pid),
      protected: !checkKillAllowed({ pid: r.pid, name: r.name }, false, guardCtx).allowed,
      // Left undefined (and therefore absent from the JSON frame) whenever the
      // OS gave nothing for that counter.
      diskReadBps: rates?.diskReadBps,
      diskWriteBps: rates?.diskWriteBps,
      netInBps: rates?.netInBps,
      netOutBps: rates?.netOutBps,
      gpuPct: r.gpuPct,
      gpuMemMB: r.gpuMemMB,
    };
  });

  return { processes, nextCpu: next, nextIo: io.next, guardCtx, protectedPids, maps };
}
