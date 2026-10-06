import { Hono } from "hono";
import { ok, err } from "../../types/api.ts";
import { killProcessTree } from "../../services/windows-process-tree.ts";
import {
  listTunnels,
  isCloudflaredPid,
  invalidateTunnelCache,
  type PpmTunnelInput,
} from "../../services/tunnel-registry.service.ts";
import {
  activeTunnels,
  spawnTunnelProcess,
  registerTunnel,
} from "./tunnel-spawn.ts";
import {
  listTailscaleForwards,
  readTailscaleAvailability,
  startTailscaleForward,
  stopTailscaleForwardByPid,
} from "../../services/port-forward/tailscale-forward.ts";
import { allowFramingFrom } from "../../services/port-forward/frame-ancestors.ts";
import type { TunnelEntry } from "../../services/tunnel-registry-parse.ts";
import { createLogger } from "../../services/logger.ts";

const log = createLogger("tunnels");

/**
 * Tunnel registry API — manage ALL cloudflared processes on the machine.
 *
 * GET    /api/tunnels             → unified list (PPM + app + external, plus Tailscale forwards)
 * GET    /api/tunnels/transports  → whether a forward can go over Tailscale, and why not
 * POST   /api/tunnels {port, via} → forward a localhost port: a quick tunnel, or Tailscale Serve
 * POST   /api/tunnels/frame-ancestors {origin} → let the PPM page at that origin frame forwarded pages
 * DELETE /api/tunnels/:pid        → stop a tunnel by PID (safe-kill guarded)
 *
 * Safety: the app/supervisor tunnel is `protected` (409, never killable here);
 * a PID is only killed after its image is re-verified as cloudflared.
 */
export const tunnelRegistryRoutes = new Hono();

/** Snapshot PPM-spawned tunnels as registry inputs, using the LIVE process PID. */
function ppmSnapshot(): PpmTunnelInput[] {
  const out: PpmTunnelInput[] = [];
  for (const t of activeTunnels.values()) {
    out.push({ pid: t.process?.pid ?? t.pid, port: t.port, url: t.url, startedAt: t.startedAt });
  }
  return out;
}

/** Tailscale forwards as registry rows; no cloudflared process stands behind them. */
function tailscaleEntries(): TunnelEntry[] {
  return listTailscaleForwards().map((f) => ({
    pid: f.pid, port: f.port, url: f.url, source: "ppm", protected: false,
    status: "running", startedAt: f.startedAt, via: "tailscale",
  }));
}

/** GET /api/tunnels — unified tunnel list */
tunnelRegistryRoutes.get("/", async (c) => {
  // ?force=1 bypasses the 2s TTL cache (manual refresh from the panel).
  const force = c.req.query("force") === "1";
  const list = await listTunnels(ppmSnapshot(), { force });
  return c.json(ok([...list, ...tailscaleEntries()]));
});

/** GET /api/tunnels/transports — can a forward go over Tailscale from this host? */
tunnelRegistryRoutes.get("/transports", async (c) => {
  return c.json(ok({ tailscale: await readTailscaleAvailability() }));
});

/**
 * POST /api/tunnels/frame-ancestors — a web-preview tab names the origin PPM is open at before it
 * loads, so a forwarded page that refuses to be framed still shows there (frame-ancestors.ts).
 */
tunnelRegistryRoutes.post("/frame-ancestors", async (c) => {
  const body = await c.req.json<{ origin?: unknown }>().catch(() => null);
  const origin = allowFramingFrom(body?.origin);
  if (!origin) return c.json(err("origin must be an http(s) origin with a host name or IPv4 address"), 400);
  return c.json(ok({ origin }));
});

/** POST /api/tunnels — forward a localhost port over a quick tunnel or Tailscale Serve */
tunnelRegistryRoutes.post("/", async (c) => {
  const body = await c.req.json<{ port: number; via?: string }>().catch(() => null);
  const port = body?.port;
  if (!port || !Number.isInteger(port) || port < 1 || port > 65535) {
    return c.json(err("Invalid port (1-65535)"), 400);
  }
  const via = body?.via ?? "cloudflare";
  if (via !== "cloudflare" && via !== "tailscale") return c.json(err("via must be cloudflare or tailscale"), 400);

  if (via === "tailscale") {
    try {
      const forward = await startTailscaleForward(port);
      return c.json(ok({ port, url: forward.url, via }));
    } catch (e: any) {
      return c.json(err(e.message || "Failed to forward over Tailscale"), 500);
    }
  }

  const existing = activeTunnels.get(port);
  if (existing) return c.json(ok({ port, url: existing.url, via }));

  try {
    const { process: proc, url, hop } = await spawnTunnelProcess(port);
    registerTunnel(port, proc, url, hop);
    invalidateTunnelCache();
    log.info(`quick tunnel port=${port} pid=${proc.pid} → ${url}`);
    return c.json(ok({ port, url, via }));
  } catch (e: any) {
    return c.json(err(e.message || "Failed to start tunnel"), 500);
  }
});

/** DELETE /api/tunnels/:pid — stop a tunnel by PID */
tunnelRegistryRoutes.delete("/:pid{[0-9]+}", async (c) => {
  const pid = parseInt(c.req.param("pid"), 10);
  if (!pid || pid < 1) return c.json(err("Invalid pid"), 400);

  // A Tailscale forward is PPM's own child, matched by the process object it holds.
  if (stopTailscaleForwardByPid(pid)) return c.json(ok({ pid }));

  // Fresh list (force) so protection + identity reflect current state.
  const list = await listTunnels(ppmSnapshot(), { force: true });
  const entry = list.find((t) => t.pid === pid);
  if (!entry) return c.json(err("No tunnel found for this PID"), 404);

  // App/supervisor tunnel is display-only — never killable from the panel.
  if (entry.protected) {
    return c.json(err("Protected app tunnel; not stoppable from panel"), 409);
  }

  // Re-verify the image is really cloudflared immediately before killing —
  // guards PID reuse between enumeration and kill.
  if (!isCloudflaredPid(pid)) {
    return c.json(err("PID is no longer a cloudflared process"), 409);
  }

  // PPM-spawned tunnel → kill via the shared map so cleanup stays consistent.
  let ppmPort: number | null = null;
  for (const t of activeTunnels.values()) {
    if ((t.process?.pid ?? t.pid) === pid) { ppmPort = t.port; break; }
  }
  killProcessTree(pid);
  if (ppmPort != null) activeTunnels.delete(ppmPort);
  invalidateTunnelCache();

  return c.json(ok({ pid }));
});
