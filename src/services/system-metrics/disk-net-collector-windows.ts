/**
 * Windows disk + net counters — a PURE parser over the tagged lines the
 * PowerShell session returns inside the per-tick process round trip. Spawns
 * nothing; the raw `Win32_PerfRawData_*` classes cost 22 ms in-session versus
 * a hard ≥1 s block for `Get-Counter`, and their class/property names are
 * culture-invariant, so a localised Windows needs no special case.
 *
 *   D<TAB>DiskReadBytesPerSec<TAB>DiskWriteBytesPerSec<TAB>Timestamp_PerfTime<TAB>Frequency_PerfTime
 *   N<TAB>Name<TAB>BytesReceivedPersec<TAB>BytesSentPersec<TAB>Timestamp_Sys100NS
 */
import type { CounterSample } from "./rate-delta.ts";

/** Pseudo-adapters that would count local traffic; virtual NICs (Tailscale,
 *  Hyper-V) stay in on purpose — dropping them would hide real tunnel traffic. */
const EXCLUDED_NIC = /^(Loopback|isatap|Teredo)/i;

export interface WindowsDiskNetCounters {
  disk: CounterSample | null;
  net: CounterSample | null;
}

export function parsePerfRawDiskNet(lines: readonly string[]): WindowsDiskNetCounters {
  let disk: CounterSample | null = null;
  let rx = 0;
  let tx = 0;
  let netTs = 0;
  let nics = 0;

  for (const line of lines) {
    const f = line.split("\t");
    if (f[0] === "D" && f.length >= 5) {
      const read = Number(f[1]);
      const write = Number(f[2]);
      const ts = Number(f[3]);
      const freq = Number(f[4]);
      if ([read, write, ts, freq].every(Number.isFinite) && freq > 0) {
        disk = { inBytes: read, outBytes: write, atSec: ts / freq };
      }
    } else if (f[0] === "N" && f.length >= 5) {
      const name = f[1] ?? "";
      if (EXCLUDED_NIC.test(name)) continue;
      const recv = Number(f[2]);
      const sent = Number(f[3]);
      const ts = Number(f[4]);
      if (![recv, sent, ts].every(Number.isFinite)) continue;
      nics++;
      rx += recv;
      tx += sent;
      netTs = Math.max(netTs, ts);
    }
  }

  const net = nics > 0 && netTs > 0
    ? { inBytes: rx, outBytes: tx, atSec: netTs / 1e7 }
    : null;
  return { disk, net };
}
