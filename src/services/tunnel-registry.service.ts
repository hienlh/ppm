/**
 * Tunnel registry: enumerate ALL cloudflared processes on the machine and merge
 * them with PPM-known tunnels into one unified list. Best-effort public-URL
 * recovery for external tunnels via cloudflared's metrics `/quicktunnel`
 * endpoint (verified present on cloudflared 2026.3.0, auto-binds ~20241+).
 *
 * PPM tunnels are injected by the caller (route layer) to avoid importing the
 * port-forwarding route module (which starts a 30s cleanup timer on import).
 * The app/supervisor tunnel is identified from status.json each call and flagged
 * `protected` (display-only, never killable from the panel).
 */
import { execFileSync } from "node:child_process";
import { basename } from "node:path";
import { resolve } from "node:path";
import { readFileSync, existsSync } from "node:fs";
import { getPpmDir } from "./ppm-dir.ts";
import { configService } from "./config.service.ts";
import {
  parseCloudflaredCmdline,
  extractMetricsPort,
  parseQuickTunnelResponse,
  mergeTunnelSources,
  type TunnelEntry,
} from "./tunnel-registry-parse.ts";

const isWindows = process.platform === "win32";

/** PPM per-port tunnel snapshot injected by the route layer. */
export interface PpmTunnelInput {
  pid: number;
  port: number;
  url: string;
  startedAt: number;
}

interface RawProc {
  pid: number;
  cmdline: string;
  imagePath: string;
  identity: string;
}

// ---------------------------------------------------------------------------
// Process enumeration
// ---------------------------------------------------------------------------

/** Enumerate all cloudflared processes with pid, cmdline, image path, identity.
 *  Throws on spawn failure/timeout so the caller can preserve last-good data
 *  instead of clobbering the list with an empty result. */
function enumerateCloudflared(): RawProc[] {
  return isWindows ? enumerateWindows() : enumerateUnix();
}

function enumerateWindows(): RawProc[] {
  // CreationDate.Ticks = identity to guard against PID reuse (same pattern as
  // windows-process-tree.ts). Fields joined by a delimiter unlikely in paths.
  const cmd =
    `Get-CimInstance Win32_Process -Filter "Name='cloudflared.exe'" | ForEach-Object { ` +
    `"$($_.ProcessId)\`t$($_.CreationDate.Ticks)\`t$($_.ExecutablePath)\`t$($_.CommandLine)" }`;
  const out = execFileSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", cmd],
    { encoding: "utf-8", timeout: 12000, windowsHide: true },
  );
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

function enumerateUnix(): RawProc[] {
  // pid, lstart (identity), full args. Filter to cloudflared, excluding the grep.
  const out = execFileSync("ps", ["-eo", "pid=,lstart=,args="], { encoding: "utf-8", timeout: 6000 });
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

// ---------------------------------------------------------------------------
// Metrics-port discovery + URL recovery
// ---------------------------------------------------------------------------

/** Loopback listening ports owned by a specific PID (for metrics discovery). */
function pidLoopbackPorts(pid: number): number[] {
  try {
    if (isWindows) {
      const cmd =
        `Get-NetTCPConnection -OwningProcess ${pid} -State Listen -ErrorAction SilentlyContinue | ` +
        `Where-Object { $_.LocalAddress -eq '127.0.0.1' -or $_.LocalAddress -eq '::1' } | ` +
        `ForEach-Object { $_.LocalPort }`;
      const out = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", cmd], {
        encoding: "utf-8", timeout: 5000, windowsHide: true,
      });
      return out.split("\n").map((l) => parseInt(l.trim(), 10)).filter((n) => !isNaN(n));
    }
    const out = execFileSync("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN", "-a", "-p", String(pid)], {
      encoding: "utf-8", timeout: 5000,
    });
    const ports = new Set<number>();
    for (const line of out.split("\n")) {
      const m = line.match(/(?:127\.0\.0\.1|\[::1\]):(\d+)\b/);
      if (m) ports.add(parseInt(m[1]!, 10));
    }
    return [...ports];
  } catch {
    return [];
  }
}

/** Best-effort: recover an external tunnel's public URL via /quicktunnel. */
async function recoverUrl(pid: number, metricsAddr: string | null): Promise<string | null> {
  const candidates = new Set<number>();
  const explicit = extractMetricsPort(metricsAddr);
  if (explicit) candidates.add(explicit);
  for (const p of pidLoopbackPorts(pid)) candidates.add(p);
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

// ---------------------------------------------------------------------------
// App/supervisor tunnel identification (protection)
// ---------------------------------------------------------------------------

interface AppShare {
  shareUrl: string | null;
  tunnelPid: number | null;
  serverPort: number | null;
}

/** Read the app-share tunnel fresh from status.json each call (guards stale PID). */
function readAppShare(): AppShare {
  let shareUrl: string | null = null;
  let tunnelPid: number | null = null;
  try {
    const statusFile = resolve(getPpmDir(), "status.json");
    if (existsSync(statusFile)) {
      const s = JSON.parse(readFileSync(statusFile, "utf-8"));
      shareUrl = s.shareUrl ?? null;
      tunnelPid = typeof s.tunnelPid === "number" ? s.tunnelPid : null;
    }
  } catch { /* ignore */ }
  const serverPort = (configService.get("port") as number | undefined) ?? null;
  return { shareUrl, tunnelPid, serverPort };
}

/** A cloudflared entry belongs to the app/supervisor tunnel if it matches by
 *  PID, public URL, or targets the PPM server port. Protect-by-default. */
function isAppTunnel(entry: TunnelEntry, app: AppShare): boolean {
  if (app.tunnelPid != null && entry.pid === app.tunnelPid) return true;
  if (app.shareUrl && entry.url && entry.url === app.shareUrl) return true;
  if (app.serverPort != null && entry.port === app.serverPort) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Image verification (safe-kill guard, used by the route layer)
// ---------------------------------------------------------------------------

/** Verify a PID's executable image really is cloudflared (not a cmdline spoof). */
export function isCloudflaredPid(pid: number): boolean {
  try {
    if (isWindows) {
      const out = execFileSync(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-Command",
          `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").ExecutablePath`],
        { encoding: "utf-8", timeout: 5000, windowsHide: true },
      );
      return basename(out.trim()).toLowerCase() === "cloudflared.exe";
    }
    const out = execFileSync("ps", ["-o", "comm=", "-p", String(pid)], { encoding: "utf-8", timeout: 5000 });
    return basename(out.trim()) === "cloudflared";
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Public API — unified list with a short TTL cache (single shared enumeration)
// ---------------------------------------------------------------------------

let cache: { at: number; data: TunnelEntry[] } | null = null;
const CACHE_TTL_MS = 4000;

/** Last successful list — served when a transient enumeration failure would
 *  otherwise clobber the panel with an empty result. */
let lastGood: TunnelEntry[] | null = null;

/** Recovered public URL keyed by PID. A running tunnel's URL never changes, so
 *  caching it stops us re-spawning powershell (Get-NetTCPConnection) + probing
 *  on every poll — the spawn pile-up that caused enumerate timeouts. */
const urlByPid = new Map<number, string>();

/**
 * List all cloudflared tunnels on the machine, merged with injected PPM
 * tunnels. Cached for CACHE_TTL_MS so multiple clients share one enumeration.
 */
export async function listTunnels(
  ppmTunnels: PpmTunnelInput[] = [],
  opts: { force?: boolean } = {},
): Promise<TunnelEntry[]> {
  if (!opts.force && cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.data;

  let raw: RawProc[];
  try {
    raw = enumerateCloudflared();
  } catch (e) {
    // Transient WMI/powershell timeout — keep showing the last known tunnels
    // rather than flickering the panel to empty.
    console.warn("[tunnel-registry] enumerate failed, serving last-good:", (e as Error)?.message ?? e);
    return lastGood ?? cache?.data ?? [];
  }
  const external: TunnelEntry[] = raw.map((p) => {
    const parsed = parseCloudflaredCmdline(p.cmdline);
    return {
      pid: p.pid,
      port: parsed.targetPort,
      url: null,
      source: "external" as const,
      protected: false,
      status: "running" as const,
      identity: p.identity,
      runRef: parsed.runRef,
    };
  });
  // Keep the parsed metrics addr per pid for URL recovery (not on the entry — secret hygiene).
  const metricsByPid = new Map<number, string | null>();
  for (const p of raw) metricsByPid.set(p.pid, parseCloudflaredCmdline(p.cmdline).metricsAddr);

  const ppm: TunnelEntry[] = ppmTunnels.map((t) => ({
    pid: t.pid, port: t.port, url: t.url, source: "ppm" as const,
    protected: false, status: "running" as const, startedAt: t.startedAt,
  }));

  const merged = mergeTunnelSources({ external, ppm, app: [] });

  // Protection: flag the app/supervisor tunnel (fresh status.json each call).
  const app = readAppShare();
  for (const entry of merged) {
    if (isAppTunnel(entry, app)) {
      entry.source = "app";
      entry.protected = true;
      if (!entry.url) entry.url = app.shareUrl;
    }
  }

  // Prune URL cache for PIDs that are gone.
  const livePids = new Set(merged.map((e) => e.pid));
  for (const pid of [...urlByPid.keys()]) if (!livePids.has(pid)) urlByPid.delete(pid);

  // Fill URLs from the per-PID cache first; only probe (spawns powershell) for
  // entries we've never recovered — this is what keeps poll load low.
  await Promise.all(
    merged
      .filter((e) => !e.url)
      .map(async (e) => {
        const cached = urlByPid.get(e.pid);
        if (cached) { e.url = cached; return; }
        const url = await recoverUrl(e.pid, metricsByPid.get(e.pid) ?? null);
        if (url) { urlByPid.set(e.pid, url); e.url = url; }
      }),
  );

  lastGood = merged;
  cache = { at: Date.now(), data: merged };
  return merged;
}

/** Invalidate the registry cache (call after start/stop mutations). */
export function invalidateTunnelCache(): void {
  cache = null;
}
