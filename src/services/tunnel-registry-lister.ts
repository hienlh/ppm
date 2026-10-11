/**
 * The tunnel registry's list: one machine-wide cloudflared scan merged with the tunnels this PPM
 * process started, cached briefly, shared between callers that ask at once, and honest when the
 * scan fails. Built as a factory over its I/O (`scan`, `run`, `appShare`) so it can be tested
 * without spawning a process; `tunnel-registry.service.ts` holds the one production instance.
 */
import type { Runner } from "./host-info/spawn-runner.ts";
import { recoverUrl, type RawProc } from "./tunnel-registry-process-scan.ts";
import {
  isAppTunnel,
  mergeTunnelSources,
  parseCloudflaredCmdline,
  withCurrentPpmTunnels,
  type AppShare,
  type TunnelEntry,
} from "./tunnel-registry-parse.ts";

/** PPM per-port tunnel snapshot injected by the route layer. */
export interface PpmTunnelInput {
  pid: number;
  port: number;
  url: string;
  startedAt: number;
}

/**
 * What a listing answers. `scanFailed` is true when the machine-wide process scan did not finish:
 * the forwards this PPM process started are still listed exactly (they come from its own registry),
 * but other programs' tunnels are only as last seen, possibly none — so an empty or short list then
 * means "could not look", never "there are none".
 */
export interface TunnelListing {
  tunnels: TunnelEntry[];
  scanFailed: boolean;
}

export interface TunnelListerDeps {
  /** The machine-wide cloudflared scan; throws when it could not finish. */
  scan: () => Promise<RawProc[]>;
  /** How the URL recovery queries a process's listening ports. */
  run: Runner;
  /** The app/supervisor tunnel's identity, read fresh on every listing. */
  appShare: () => AppShare;
  /** Where a failed scan is reported. */
  warn?: (message: string) => void;
}

export interface TunnelLister {
  /** `force` skips the short TTL cache (a manual refresh, or a check right before a kill). */
  list(ppmTunnels?: PpmTunnelInput[], opts?: { force?: boolean }): Promise<TunnelListing>;
  /** Call after a tunnel is started or stopped. */
  invalidate(): void;
}

const CACHE_TTL_MS = 4000;

export function createTunnelLister(deps: TunnelListerDeps): TunnelLister {
  let cache: { at: number; data: TunnelEntry[] } | null = null;
  /** Last successful list — served when a failed scan would otherwise clobber the panel with an empty result. */
  let lastGood: TunnelEntry[] | null = null;
  /** Recovered public URL keyed by PID. A running tunnel's URL never changes, so caching it stops
   *  us re-spawning powershell (Get-NetTCPConnection) + probing on every poll. */
  const urlByPid = new Map<number, string>();
  /** Bumped by every start or stop: a scan that began before one may not fill the cache, or be
   *  shared with a caller that arrives after it. */
  let generation = 0;
  /** The scan running now, shared by every caller that arrives while it runs: with the scan async,
   *  several panels polling at once would otherwise each start a PowerShell of their own. */
  let scanInFlight: { gen: number; promise: Promise<RawProc[]> } | null = null;

  function sharedScan(): Promise<RawProc[]> {
    if (scanInFlight && scanInFlight.gen === generation) return scanInFlight.promise;
    const entry = { gen: generation, promise: deps.scan() };
    scanInFlight = entry;
    const clear = () => { if (scanInFlight === entry) scanInFlight = null; };
    entry.promise.then(clear, clear);
    return entry.promise;
  }

  async function list(ppmTunnels: PpmTunnelInput[] = [], opts: { force?: boolean } = {}): Promise<TunnelListing> {
    if (!opts.force && cache && Date.now() - cache.at < CACHE_TTL_MS) return { tunnels: cache.data, scanFailed: false };
    const gen = generation;

    const ppm: TunnelEntry[] = ppmTunnels.map((t) => ({
      pid: t.pid, port: t.port, url: t.url, source: "ppm" as const,
      protected: false, status: "running" as const, startedAt: t.startedAt,
    }));

    let raw: RawProc[];
    try {
      raw = await sharedScan();
    } catch (e) {
      // Keep showing the last known tunnels rather than flickering the panel to empty — PPM's own
      // are known without a scan — and say the list is not complete, so nothing reading it (the
      // Assistant's tunnels_status above all) reports "none" when the answer is "unknown".
      (deps.warn ?? console.warn)(`[tunnel-registry] enumerate failed, serving last-good: ${(e as Error)?.message ?? e}`);
      return { tunnels: withCurrentPpmTunnels(lastGood ?? cache?.data ?? [], ppm), scanFailed: true };
    }

    const external: TunnelEntry[] = raw.map((p) => {
      const parsed = parseCloudflaredCmdline(p.cmdline);
      return {
        pid: p.pid, port: parsed.targetPort, url: null, source: "external" as const,
        protected: false, status: "running" as const, identity: p.identity, runRef: parsed.runRef,
      };
    });
    // Keep the parsed metrics addr per pid for URL recovery (not on the entry — secret hygiene).
    const metricsByPid = new Map<number, string | null>();
    for (const p of raw) metricsByPid.set(p.pid, parseCloudflaredCmdline(p.cmdline).metricsAddr);

    const merged = mergeTunnelSources({ external, ppm, app: [] });

    // Protection: flag the app/supervisor tunnel (fresh status.json each call).
    const app = deps.appShare();
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
          const url = await recoverUrl(e.pid, metricsByPid.get(e.pid) ?? null, deps.run);
          if (url) { urlByPid.set(e.pid, url); e.url = url; }
        }),
    );

    // A start or stop while this ran makes the list stale for anyone after; it still answers this call.
    if (gen === generation) {
      lastGood = merged;
      cache = { at: Date.now(), data: merged };
    }
    return { tunnels: merged, scanFailed: false };
  }

  return {
    list,
    invalidate() {
      cache = null;
      generation++;
    },
  };
}
