/**
 * macOS disk + net cumulative counters via `ioreg` and `netstat -ib`.
 * Runner-injected; parsers are pure. UNVERIFIED on real macOS hardware — on any
 * parse failure the result is `null` (→ `available:false` + warning), never 0.
 */
import type { Runner } from "../host-info/spawn-runner.ts";
import { defaultRunner } from "../host-info/spawn-runner.ts";
import type { CounterSample } from "./rate-delta.ts";
import type { DiskNetCounters } from "./disk-net-collector-linux.ts";

/** Sum every `"Bytes (Read)"=N` / `"Bytes (Write)"=N` pair from `ioreg -rc IOBlockStorageDriver -w0`. */
export function parseIoregBytes(text: string): { inBytes: number; outBytes: number } | null {
  let read = 0;
  let written = 0;
  let matched = false;
  for (const m of text.matchAll(/"Bytes \((Read|Write)\)"\s*=\s*(\d+)/g)) {
    const n = Number(m[2]);
    if (!Number.isFinite(n)) continue;
    matched = true;
    if (m[1] === "Read") read += n;
    else written += n;
  }
  return matched ? { inBytes: read, outBytes: written } : null;
}

/**
 * `netstat -ib` repeats an interface once per address family; only the
 * `<Link#N>` row (the first per interface) carries the hardware counters, so
 * summing every row would double-count. The Address column is blank on some
 * virtual interfaces, so Ibytes/Obytes are located from the right-hand end.
 */
export function parseNetstatIb(text: string): { inBytes: number; outBytes: number } | null {
  let rx = 0;
  let tx = 0;
  let matched = false;
  const seen = new Set<string>();
  for (const line of text.split("\n")) {
    const f = line.trim().split(/\s+/);
    if (f.length < 10) continue;
    const iface = f[0]!;
    if (iface === "Name" || iface.startsWith("lo") || seen.has(iface)) continue;
    if (!(f[2] ?? "").startsWith("<Link#")) continue;
    const ibytes = Number(f[f.length - 5]);
    const obytes = Number(f[f.length - 2]);
    if (!Number.isFinite(ibytes) || !Number.isFinite(obytes)) continue;
    seen.add(iface);
    matched = true;
    rx += ibytes;
    tx += obytes;
  }
  return matched ? { inBytes: rx, outBytes: tx } : null;
}

export async function collectDarwinDiskNet(run: Runner = defaultRunner, now: () => number = Date.now): Promise<DiskNetCounters> {
  const warnings: string[] = [];
  const atSec = now() / 1000;
  let disk: CounterSample | null = null;
  let net: CounterSample | null = null;

  try {
    const r = await run(["ioreg", "-rc", "IOBlockStorageDriver", "-w0"], 3000);
    const parsed = r.code === 0 ? parseIoregBytes(r.stdout) : null;
    if (parsed) disk = { ...parsed, atSec };
  } catch { /* fall through to the warning */ }
  if (!disk) warnings.push("Disk throughput unavailable: ioreg IOBlockStorageDriver statistics not readable");

  try {
    const r = await run(["netstat", "-ib"], 3000);
    const parsed = r.code === 0 ? parseNetstatIb(r.stdout) : null;
    if (parsed) net = { ...parsed, atSec };
  } catch { /* fall through to the warning */ }
  if (!net) warnings.push("Network throughput unavailable: netstat -ib not readable");

  return { disk, net, warnings };
}
