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
 *
 * The process queries live in `tunnel-registry-process-scan.ts` (async spawns only — see there
 * why never a sync spawn with a timeout) and the cached listing in `tunnel-registry-lister.ts`;
 * this module wires them to the real processes, `status.json` and the config.
 */
import { resolve } from "node:path";
import { readFileSync, existsSync } from "node:fs";
import { getPpmDir } from "./ppm-dir.ts";
import { configService } from "./config.service.ts";
import { defaultRunner, type Runner } from "./host-info/spawn-runner.ts";
import { enumerateCloudflared, isCloudflaredPid as imageIsCloudflared } from "./tunnel-registry-process-scan.ts";
import { createTunnelLister, type PpmTunnelInput, type TunnelListing } from "./tunnel-registry-lister.ts";
import type { AppShare } from "./tunnel-registry-parse.ts";

export type { PpmTunnelInput, TunnelListing } from "./tunnel-registry-lister.ts";

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

const lister = createTunnelLister({
  scan: () => enumerateCloudflared(defaultRunner),
  run: defaultRunner,
  appShare: readAppShare,
});

/**
 * List all cloudflared tunnels on the machine, merged with injected PPM
 * tunnels. Cached briefly so multiple clients share one enumeration.
 */
export function listTunnels(ppmTunnels: PpmTunnelInput[] = [], opts: { force?: boolean } = {}): Promise<TunnelListing> {
  return lister.list(ppmTunnels, opts);
}

/** Invalidate the registry cache (call after start/stop mutations). */
export function invalidateTunnelCache(): void {
  lister.invalidate();
}

/** Verify a PID's executable image really is cloudflared (the safe-kill guard). Fails closed. */
export function isCloudflaredPid(pid: number, run: Runner = defaultRunner): Promise<boolean> {
  return imageIsCloudflared(pid, run);
}
