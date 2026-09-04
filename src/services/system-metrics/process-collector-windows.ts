/**
 * Windows process collector: one `Win32_Process` + disk + net round trip per
 * tick through the long-lived PowerShell session (measured 172-206 ms), plus
 * the expensive `CommandLine` pass only every 30 s.
 *
 * `Get-Process` is not used at all: unelevated it silently returns null CPU and
 * start time for ~45 % of rows. `Win32_Process` with this property list has
 * zero nulls. All scripts are static strings — no user input ever reaches them.
 */
import type { ProcessCollection, ProcessCollector, RawProcessRow } from "./process-collector-types.ts";
import { createStickyColumns } from "./process-collector-types.ts";
import { PowerShellSession, PsSessionDisabledError, PS_DISABLED_WARNING } from "./powershell-session.ts";
import { parseWindowsTick, type WindowsCommandLine } from "./process-collector-windows-parse.ts";
import { computeGpuPercents, memBytesToMB, type GpuUsageState } from "./gpu-process-usage-windows.ts";

/** `.ToUniversalTime()` here, not in JS: only .NET on this machine knows which
 *  DST rule applied at the instant each process started. */
const CREATION_UTC_TICKS = "$($_.CreationDate.ToUniversalTime().Ticks)";

export const WINDOWS_TICK_SCRIPT = [
  "Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,Name,KernelModeTime,UserModeTime,WorkingSetSize,CreationDate,ReadTransferCount,WriteTransferCount | " +
    `ForEach-Object { "P\`t$($_.ProcessId)\`t$($_.ParentProcessId)\`t$($_.Name)\`t$($_.KernelModeTime)\`t$($_.UserModeTime)\`t$($_.WorkingSetSize)\`t${CREATION_UTC_TICKS}\`t$($_.ReadTransferCount)\`t$($_.WriteTransferCount)" }`,
  "Get-CimInstance Win32_PerfRawData_PerfDisk_PhysicalDisk -Filter \"Name='_Total'\" | " +
    'ForEach-Object { "D`t$($_.DiskReadBytesPerSec)`t$($_.DiskWriteBytesPerSec)`t$($_.Timestamp_PerfTime)`t$($_.Frequency_PerfTime)" }',
  "Get-CimInstance Win32_PerfRawData_Tcpip_NetworkInterface | " +
    'ForEach-Object { "N`t$($_.Name)`t$($_.BytesReceivedPersec)`t$($_.BytesSentPersec)`t$($_.Timestamp_Sys100NS)" }',
  // 505 engine instances on a dev box, of which ~50 are busy: filtering in
  // PowerShell keeps the reply an order of magnitude smaller than the class.
  "Get-CimInstance Win32_PerfRawData_GPUPerformanceCounters_GPUEngine | Where-Object { $_.UtilizationPercentage -gt 0 } | " +
    'ForEach-Object { "G`t$($_.Name)`t$($_.UtilizationPercentage)`t$($_.Timestamp_Sys100NS)" }',
  "Get-CimInstance Win32_PerfRawData_GPUPerformanceCounters_GPUProcessMemory | " +
    'ForEach-Object { "M`t$($_.Name)`t$($_.DedicatedUsage)" }',
].join("\n");

/** +10 ms and +95 KB per fetch, and ~half the rows are access-denied (null)
 *  unelevated — so it runs on its own slow cadence and merges by identity.
 *  `CommandLine` is the only attacker-controlled field in the whole round trip
 *  (any local process picks its own argv), so it travels base64-encoded: raw,
 *  an embedded CR/LF would let it forge a `P` row for another pid or inject an
 *  `__END_<id>__` line that truncates the reply. */
export const WINDOWS_COMMANDLINE_SCRIPT =
  "Get-CimInstance Win32_Process -Property ProcessId,CommandLine,CreationDate | " +
  `ForEach-Object { "C\`t$($_.ProcessId)\`t${CREATION_UTC_TICKS}\`t$([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes([string]$_.CommandLine)))" }`;

export const COMMANDLINE_REFRESH_MS = 30_000;

export interface WindowsProcessCollectorOptions {
  session?: PowerShellSession;
  now?: () => number;
  commandRefreshMs?: number;
  /** Seam for the one-shot startup timing line, so tests stay silent. */
  log?: (message: string) => void;
}

export interface WindowsProcessCollector extends ProcessCollector {
  readonly session: PowerShellSession;
}

export function createWindowsProcessCollector(opts: WindowsProcessCollectorOptions = {}): WindowsProcessCollector {
  const session = opts.session ?? new PowerShellSession();
  const now = opts.now ?? Date.now;
  const refreshMs = opts.commandRefreshMs ?? COMMANDLINE_REFRESH_MS;
  const log = opts.log ?? ((m: string) => console.log(m));
  const observeColumns = createStickyColumns();
  let commandByPid = new Map<number, WindowsCommandLine>();
  let lastCommandFetchAt = Number.NEGATIVE_INFINITY;
  let gpuState: GpuUsageState | null = null;
  let logged = false;

  return {
    session,
    stop: () => session.stop(),
    async collect(): Promise<ProcessCollection> {
      if (session.isDisabled()) return { rows: [], columns: observeColumns({}), warnings: [PS_DISABLED_WARNING] };

      const wantCommands = now() - lastCommandFetchAt >= refreshMs;
      const script = wantCommands ? `${WINDOWS_TICK_SCRIPT}\n${WINDOWS_COMMANDLINE_SCRIPT}` : WINDOWS_TICK_SCRIPT;
      const startedRequestAt = now();
      let text: string;
      try {
        text = await session.request(script);
      } catch (e) {
        if (e instanceof PsSessionDisabledError) {
          return { rows: [], columns: observeColumns({}), warnings: [PS_DISABLED_WARNING] };
        }
        throw e;
      }
      if (!logged) {
        logged = true;
        // One line, once: the round trip now also carries the two GPU classes,
        // and the 2 s tick budget is the thing that would break first.
        log(`[system-metrics] windows tick round trip (incl. GPU pass): ${now() - startedRequestAt} ms`);
      }

      const parsed = parseWindowsTick(text);
      if (parsed.commands) {
        commandByPid = new Map(parsed.commands.map((c) => [c.pid, c]));
        lastCommandFetchAt = now();
      }

      // First row for a pid wins, like the guard maps: a forged duplicate must
      // not decide which start time the GPU delta key is anchored to.
      const startedAtByPid = new Map<number, number>();
      for (const p of parsed.processes) if (!startedAtByPid.has(p.pid)) startedAtByPid.set(p.pid, p.startedAt);
      const gpu = computeGpuPercents(gpuState, parsed.gpu.engines, (pid) => startedAtByPid.get(pid));
      gpuState = gpu.next;

      const rows: RawProcessRow[] = parsed.processes.map((r) => ({
        ...r,
        command: mergeCommand(r, commandByPid.get(r.pid)),
        // Windows reports GPU per pid for the whole machine, so a pid with no
        // engine instance is measured-and-idle (0), not unmeasurable.
        gpuPct: parsed.gpu.present ? gpu.pctByPid.get(r.pid) ?? 0 : undefined,
        gpuMemMB: parsed.gpu.present ? memBytesToMB(parsed.gpu.memBytesByPid.get(r.pid) ?? 0) : undefined,
      }));
      return {
        rows,
        disk: parsed.disk,
        net: parsed.net,
        columns: observeColumns({
          disk: rows.some((r) => r.diskReadBytes !== undefined),
          gpu: parsed.gpu.present,
        }),
        warnings: parsed.errors.map((e) => `PowerShell: ${e}`),
      };
    },
  };
}

/** A pid new since the last 30 s fetch — or recycled since — has no command
 *  yet; the row falls back to its name until the next fetch. */
export function mergeCommand(row: RawProcessRow, cached: WindowsCommandLine | undefined): string | null {
  if (!cached) return null;
  if (cached.startedAt && row.startedAt && cached.startedAt !== row.startedAt) return null;
  return cached.command;
}
