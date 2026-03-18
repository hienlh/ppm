import { Hono } from "hono";
import { networkInterfaces } from "node:os";
import { tunnelService } from "../../services/tunnel.service.ts";
import { configService } from "../../services/config.service.ts";
import { ok, err } from "../../types/api.ts";

/** Return first non-internal IPv4 address */
function getLocalIp(): string | null {
  const nets = networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] ?? []) {
      if (net.family === "IPv4" && !net.internal) return net.address;
    }
  }
  return null;
}

export const tunnelRoutes = new Hono();

/** GET /api/tunnel — current tunnel status + local URL */
tunnelRoutes.get("/", (c) => {
  const url = tunnelService.getTunnelUrl();
  const port = configService.get("port") ?? 8080;
  const localIp = getLocalIp();
  const localUrl = localIp ? `http://${localIp}:${port}` : null;
  return c.json(ok({ active: !!url, url, localUrl }));
});

/** POST /api/tunnel/start — start tunnel if not already running */
tunnelRoutes.post("/start", async (c) => {
  const existing = tunnelService.getTunnelUrl();
  if (existing) {
    return c.json(ok({ url: existing }));
  }

  try {
    const port = configService.get("port") ?? 8080;
    const url = await tunnelService.startTunnel(port);
    return c.json(ok({ url }));
  } catch (e) {
    return c.json(err((e as Error).message), 500);
  }
});

/** POST /api/tunnel/stop — stop tunnel */
tunnelRoutes.post("/stop", (c) => {
  tunnelService.stopTunnel();
  return c.json(ok({ stopped: true }));
});
