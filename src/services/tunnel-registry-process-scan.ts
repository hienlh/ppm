/**
 * The process queries behind the tunnel registry: find every cloudflared on the machine, find the
 * loopback ports one of them listens on (to recover a quick tunnel's public URL), and check that a
 * PID really runs cloudflared before anything kills it.
 *
 * Every query is an async spawn bounded by its own kill timer (`Runner`, `defaultRunner` in
 * production), never `execFileSync` with a `timeout`. Under Bun 1.3.10 on Windows a sync spawn's
 * timeout is measured from a stale event-loop clock once the server has been idle longer than that
 * timeout: inside a request handler it fails with ETIMEDOUT within a few milliseconds, every time,
 * while the same call at top level succeeds, and an async spawn with a `setTimeout` kill is not
 * affected (both measured after 14 s and 30 s of idle). That made the scan fail on almost every
 * request of a server that had sat waiting, and the list silently fell back to an empty one. An
 * async spawn also stops a 0.7–5 s WMI query from stopping the event loop for that long.
 */
import { basename } from "node:path";
import { readProcTable, readProcComm } from "./proc-table-linux.ts";
import type { Runner, RunResult } from "./host-info/spawn-runner.ts";
import { extractMetricsPort, parseQuickTunnelResponse } from "./tunnel-registry-parse.ts";

const isWindows = process.platform === "win32";

/** One cloudflared process as the OS reports it. */
export interface RawProc {
  pid: number;
  cmdline: string;
  imagePath: string;
  identity: string;
}

const POWERSHELL = ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command"];
const ENUMERATE_TIMEOUT_MS = 12_000;

/** A run's stdout, or a throw naming why there is none (killed at its timeout, failed to start, non-zero exit). */
function stdoutOrThrow(what: string, r: RunResult, timeoutMs: number): string {
  if (r.timedOut) throw new Error(`${what} timed out after ${timeoutMs} ms`);
  if (r.code !== 0) throw new Error(`${what} failed (exit ${r.code ?? "none"}): ${r.stderr.trim().slice(0, 200)}`);
  return r.stdout;
}

/** Enumerate all cloudflared processes with pid, cmdline, image path, identity.
 *  Throws on spawn failure/timeout so the caller can preserve last-good data
 *  instead of clobbering the list with an empty result. */
export function enumerateCloudflared(run: Runner): Promise<RawProc[]> {
  return isWindows ? enumerateWindows(run) : enumerateUnix(run);
}

/** Exported for tests, which hand it a runner instead of a real PowerShell. */
export async function enumerateWindows(run: Runner): Promise<RawProc[]> {
  // CreationDate.Ticks = identity to guard against PID reuse (same pattern as
  // windows-process-tree.ts). Fields joined by a delimiter unlikely in paths.
  const cmd =
    `Get-CimInstance Win32_Process -Filter "Name='cloudflared.exe'" | ForEach-Object { ` +
    `"$($_.ProcessId)\`t$($_.CreationDate.Ticks)\`t$($_.ExecutablePath)\`t$($_.CommandLine)" }`;
  const out = stdoutOrThrow("powershell.exe (Win32_Process)", await run([...POWERSHELL, cmd], ENUMERATE_TIMEOUT_MS), ENUMERATE_TIMEOUT_MS);
  const procs: RawProc[] = [];
  for (const line of out.split("\n")) {
    const parts = line.trim().split("\t");
    if (parts.length < 4) continue;
    const pid = parseInt(parts[0]!, 10);
    if (isNaN(pid)) continue;
    procs.push({ pid, identity: parts[1] ?? "", imagePath: parts[2] ?? "", cmdline: parts[3] ?? "" });
  }
  return procs;
}

async function enumerateUnix(run: Runner): Promise<RawProc[]> {
  // /proc first: `ps` lives in `procps` and slim Linux images omit it, which
  // used to make cloudflared discovery come back empty with no error.
  const table = readProcTable();
  if (table) {
    return table
      .filter((p) => /(^|\/)cloudflared(\s|$)/.test(p.args))
      .map((p) => ({
        pid: p.pid,
        // Same role as ps `lstart`: a start-time identity that survives PID reuse.
        identity: new Date(p.startedAtMs).toISOString(),
        imagePath: p.args.split(/\s+/)[0] ?? "",
        cmdline: p.args,
      }));
  }

  // pid, lstart (identity), full args. Filter to cloudflared, excluding the grep.
  const out = stdoutOrThrow("ps", await run(["ps", "-eo", "pid=,lstart=,args="], 6000), 6000);
  const procs: RawProc[] = [];
  for (const line of out.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    const m = t.match(/^(\d+)\s+(.{24})\s+(.*)$/);
    if (!m) continue;
    const args = m[3]!;
    if (!/(^|\/)cloudflared(\s|$)/.test(args)) continue;
    procs.push({ pid: parseInt(m[1]!, 10), identity: m[2]!.trim(), imagePath: args.split(/\s+/)[0] ?? "", cmdline: args });
  }
  return procs;
}

/** Loopback listening ports owned by a specific PID (for metrics discovery). */
async function pidLoopbackPorts(pid: number, run: Runner): Promise<number[]> {
  try {
    if (isWindows) {
      const cmd =
        `Get-NetTCPConnection -OwningProcess ${pid} -State Listen -ErrorAction SilentlyContinue | ` +
        `Where-Object { $_.LocalAddress -eq '127.0.0.1' -or $_.LocalAddress -eq '::1' } | ` +
        `ForEach-Object { $_.LocalPort }`;
      const out = stdoutOrThrow("powershell.exe (Get-NetTCPConnection)", await run([...POWERSHELL, cmd], 5000), 5000);
      return out.split("\n").map((l) => parseInt(l.trim(), 10)).filter((n) => !isNaN(n));
    }
    // lsof exits 1 when the process has no matching socket; that is "no ports", not a failure.
    const r = await run(["lsof", "-nP", "-iTCP", "-sTCP:LISTEN", "-a", "-p", String(pid)], 5000);
    if (r.timedOut) return [];
    const ports = new Set<number>();
    for (const line of r.stdout.split("\n")) {
      const m = line.match(/(?:127\.0\.0\.1|\[::1\]):(\d+)\b/);
      if (m) ports.add(parseInt(m[1]!, 10));
    }
    return [...ports];
  } catch {
    return [];
  }
}

/** Best-effort: recover an external tunnel's public URL via /quicktunnel. */
export async function recoverUrl(pid: number, metricsAddr: string | null, run: Runner): Promise<string | null> {
  const candidates = new Set<number>();
  const explicit = extractMetricsPort(metricsAddr);
  if (explicit) candidates.add(explicit);
  for (const p of await pidLoopbackPorts(pid, run)) candidates.add(p);
  for (const port of candidates) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/quicktunnel`, {
        signal: AbortSignal.timeout(2000),
      });
      if (!res.ok) continue;
      const url = parseQuickTunnelResponse(await res.text());
      if (url) return url;
    } catch { /* try next candidate */ }
  }
  return null;
}

/**
 * Verify a PID's executable image really is cloudflared (not a cmdline spoof). Fails closed: a
 * query that times out or cannot run answers false, so nothing is killed on a guess.
 */
export async function isCloudflaredPid(pid: number, run: Runner): Promise<boolean> {
  if (!Number.isInteger(pid) || pid < 1) return false;
  try {
    if (isWindows) {
      const out = stdoutOrThrow("powershell.exe (ExecutablePath)", await run(
        [...POWERSHELL, `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").ExecutablePath`], 5000), 5000);
      return basename(out.trim()).toLowerCase() === "cloudflared.exe";
    }
    const comm = readProcComm(pid);
    if (comm !== null) return basename(comm) === "cloudflared";
    const out = stdoutOrThrow("ps", await run(["ps", "-o", "comm=", "-p", String(pid)], 5000), 5000);
    return basename(out.trim()) === "cloudflared";
  } catch {
    return false;
  }
}
