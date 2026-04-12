import { Hono } from "hono";
import { ok, err } from "../../types/api.ts";
import { ensureCloudflared } from "../../services/cloudflared.service.ts";

/**
 * Port forwarding API — starts per-port Cloudflare Quick Tunnels so the
 * frontend can open any localhost dev server via tunnel URL.
 *
 * POST /api/preview/tunnel { port: 3000 } → { url: "https://xxx.trycloudflare.com" }
 * DELETE /api/preview/tunnel/:port → stops tunnel for that port
 * GET /api/preview/tunnels → list active tunnels
 */
export const portForwardingRoutes = new Hono();

const TUNNEL_URL_REGEX = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;

interface ActiveTunnel {
  port: number;
  url: string;
  process: import("bun").Subprocess;
  startedAt: number;
  probeFailures: number;
}

const MAX_PROBE_FAILURES = 2;

/** Active tunnels keyed by port — exported for testing */
export const activeTunnels = new Map<number, ActiveTunnel>();

/** Spawn cloudflared tunnel for a port, extract URL from stderr */
async function spawnTunnelProcess(port: number): Promise<{ process: import("bun").Subprocess; url: string }> {
  const bin = await ensureCloudflared();
  const proc = Bun.spawn(
    [bin, "tunnel", "--url", `http://127.0.0.1:${port}`],
    { stderr: "pipe", stdout: "ignore", stdin: "ignore" },
  );

  const reader = proc.stderr.getReader();
  const decoder = new TextDecoder();
  const url = await new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => {
      try { proc.kill(); } catch {}
      reject(new Error("Tunnel timed out after 30s"));
    }, 30_000);

    let buffer = "";
    let found = false;
    const read = async () => {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (found) continue;
          buffer += decoder.decode(value, { stream: true });
          const match = buffer.match(TUNNEL_URL_REGEX);
          if (match) {
            found = true;
            buffer = "";
            clearTimeout(timeout);
            resolve(match[0]);
          }
        }
        if (!found) {
          clearTimeout(timeout);
          reject(new Error("cloudflared exited without tunnel URL"));
        }
      } catch (e) {
        if (!found) { clearTimeout(timeout); reject(e); }
      }
    };
    read();
  });

  return { process: proc, url };
}

/** Register tunnel in map with auto-cleanup on exit */
function registerTunnel(port: number, proc: import("bun").Subprocess, url: string) {
  activeTunnels.set(port, { port, url, process: proc, startedAt: Date.now(), probeFailures: 0 });
  proc.exited.then(() => activeTunnels.delete(port)).catch(() => activeTunnels.delete(port));
}

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
