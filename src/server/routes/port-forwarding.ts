import { Hono } from "hono";
import { ok, err } from "../../types/api.ts";
import {
  activeTunnels,
  spawnTunnelProcess,
  registerTunnel,
  MAX_PROBE_FAILURES,
} from "./tunnel-spawn.ts";

/**
 * Port forwarding API — starts per-port Cloudflare Quick Tunnels so the
 * frontend can open any localhost dev server via tunnel URL.
 *
 * POST /api/preview/tunnel { port: 3000 } → { url: "https://xxx.trycloudflare.com" }
 * DELETE /api/preview/tunnel/:port → stops tunnel for that port
 * GET /api/preview/tunnels → list active tunnels
 *
 * Spawn logic + the shared `activeTunnels` map live in ./tunnel-spawn.ts so the
 * new /api/tunnels registry routes reuse the same implementation and state.
 *
 * DEPRECATED (superseded by /api/tunnels): the HTTP handlers below are no longer
 * called by the frontend — the dock "Cloudflare Tunnels" panel uses /api/tunnels.
 * They are retained (behind authMiddleware) for backward compatibility, and this
 * module also owns the 30s ghost-cleanup timer that keeps `activeTunnels` healthy
 * for the registry. Both route modules mutate the SAME shared map (no split-brain).
 */
export const portForwardingRoutes = new Hono();

// Re-export for existing importers (tests, index) that reference the map here.
export { activeTunnels } from "./tunnel-spawn.ts";

/** Start a tunnel for a localhost port */
portForwardingRoutes.post("/tunnel", async (c) => {
  const body = await c.req.json<{ port: number }>().catch(() => null);
  const port = body?.port;
  if (!port || port < 1 || port > 65535) {
    return c.json(err("Invalid port (1-65535)"), 400);
  }

  // Return existing tunnel if already running
  const existing = activeTunnels.get(port);
  if (existing) {
    return c.json(ok({ port, url: existing.url }));
  }

  try {
    const { process: proc, url } = await spawnTunnelProcess(port);
    registerTunnel(port, proc, url);
    console.log(`[preview] tunnel started for port ${port} → ${url}`);
    return c.json(ok({ port, url }));
  } catch (e: any) {
    return c.json(err(e.message || "Failed to start tunnel"), 500);
  }
});

/** Stop a tunnel */
portForwardingRoutes.delete("/tunnel/:port{[0-9]+}", (c) => {
  const port = parseInt(c.req.param("port"), 10);
  const tunnel = activeTunnels.get(port);
  if (!tunnel) {
    return c.json(err("No tunnel running for this port"), 404);
  }

  try { tunnel.process.kill(); } catch {}
  activeTunnels.delete(port);
  console.log(`[preview] tunnel stopped for port ${port}`);
  return c.json(ok({ port }));
});

/** List active tunnels */
portForwardingRoutes.get("/tunnels", (c) => {
  const list = Array.from(activeTunnels.values()).map((t) => ({
    port: t.port,
    url: t.url,
    startedAt: t.startedAt,
  }));
  return c.json(ok(list));
});

/** Check if a cloudflared process is still alive */
function isProcessAlive(proc: import("bun").Subprocess): boolean {
  try { process.kill(proc.pid, 0); return true; } catch { return false; }
}

/** Probe tunnel URL to check if it's still accessible (DNS + connection) */
async function probeTunnelUrl(url: string): Promise<boolean> {
  try {
    await fetch(url, { method: "HEAD", signal: AbortSignal.timeout(8_000), redirect: "follow" });
    return true;
  } catch {
    return false;
  }
}

let cleanupRunning = false;

/** Remove ghost tunnels and auto-restart tunnels with expired URLs */
async function cleanupGhostTunnels() {
  if (cleanupRunning) return;
  cleanupRunning = true;
  try {
    for (const [port, tunnel] of activeTunnels) {
      // Check if cloudflared process is still running
      if (!isProcessAlive(tunnel.process)) {
        console.log(`[preview] ghost cleanup: port ${port} — process dead`);
        activeTunnels.delete(port);
        continue;
      }
      // Check if target port is still listening
      try {
        const conn = await Bun.connect({ hostname: "127.0.0.1", port, socket: {
          data() {}, open(s) { s.end(); }, error() {}, close() {},
        }});
        conn.end();
      } catch {
        console.log(`[preview] ghost cleanup: port ${port} — port not listening`);
        try { tunnel.process.kill(); } catch {}
        activeTunnels.delete(port);
        continue;
      }

      // Probe tunnel URL to detect expired Quick Tunnel URLs
      const alive = await probeTunnelUrl(tunnel.url);
      if (alive) {
        tunnel.probeFailures = 0;
        continue;
      }

      tunnel.probeFailures++;
      console.log(`[preview] tunnel probe failed for port ${port} (${tunnel.probeFailures}/${MAX_PROBE_FAILURES})`);

      if (tunnel.probeFailures >= MAX_PROBE_FAILURES) {
        console.log(`[preview] tunnel URL expired for port ${port}, restarting...`);
        try { tunnel.process.kill(); } catch {}
        activeTunnels.delete(port);
        try {
          const { process: proc, url } = await spawnTunnelProcess(port);
          registerTunnel(port, proc, url);
          console.log(`[preview] tunnel restarted for port ${port} → ${url}`);
        } catch (e: any) {
          console.warn(`[preview] tunnel restart failed for port ${port}: ${e.message}`);
        }
      }
    }
  } finally {
    cleanupRunning = false;
  }
}

// Run ghost cleanup every 30s
setInterval(cleanupGhostTunnels, 30_000);

/** Cleanup all tunnels on server shutdown */
export function stopAllPortTunnels() {
  for (const [port, tunnel] of activeTunnels) {
    try { tunnel.process.kill(); } catch {}
    activeTunnels.delete(port);
  }
}
