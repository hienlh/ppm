import { Hono } from "hono";
import { ok, err } from "../../types/api.ts";
import { ensureCloudflared } from "../../services/cloudflared.service.ts";

/**
 * Browser preview API — starts per-port Cloudflare Quick Tunnels so the
 * frontend can iframe any localhost dev server without CORS/path issues.
 *
 * POST /api/preview/tunnel { port: 3000 } → { url: "https://xxx.trycloudflare.com" }
 * DELETE /api/preview/tunnel/:port → stops tunnel for that port
 * GET /api/preview/tunnels → list active tunnels
 */
export const browserPreviewRoutes = new Hono();

const TUNNEL_URL_REGEX = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;

interface ActiveTunnel {
  port: number;
  url: string;
  process: import("bun").Subprocess;
  startedAt: number;
}

/** Active tunnels keyed by port */
const activeTunnels = new Map<number, ActiveTunnel>();

/** Start a tunnel for a localhost port */
browserPreviewRoutes.post("/tunnel", async (c) => {
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
    const bin = await ensureCloudflared();
    const proc = Bun.spawn(
      [bin, "tunnel", "--url", `http://127.0.0.1:${port}`],
      { stderr: "pipe", stdout: "ignore", stdin: "ignore" },
    );

    // Read stderr to find tunnel URL
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

    activeTunnels.set(port, { port, url, process: proc, startedAt: Date.now() });

    // Auto-cleanup when process exits
    proc.exited.then(() => activeTunnels.delete(port)).catch(() => activeTunnels.delete(port));

    console.log(`[preview] tunnel started for port ${port} → ${url}`);
    return c.json(ok({ port, url }));
  } catch (e: any) {
    return c.json(err(e.message || "Failed to start tunnel"), 500);
  }
});

/** Stop a tunnel */
browserPreviewRoutes.delete("/tunnel/:port{[0-9]+}", (c) => {
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
browserPreviewRoutes.get("/tunnels", (c) => {
  const list = Array.from(activeTunnels.values()).map((t) => ({
    port: t.port,
    url: t.url,
    startedAt: t.startedAt,
  }));
  return c.json(ok(list));
});

/** Cleanup all tunnels on server shutdown */
export function stopAllPreviewTunnels() {
  for (const [port, tunnel] of activeTunnels) {
    try { tunnel.process.kill(); } catch {}
    activeTunnels.delete(port);
  }
}
