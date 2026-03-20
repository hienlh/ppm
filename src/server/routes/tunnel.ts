import { Hono } from "hono";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { homedir } from "node:os";
import { tunnelService } from "../../services/tunnel.service.ts";
import { configService } from "../../services/config.service.ts";
import { getLocalIp } from "../../lib/network-utils.ts";
import { ok, err } from "../../types/api.ts";

/** Patch shareUrl in status.json so `ppm status` reflects web-started tunnels */
function patchStatusFile(shareUrl: string | null): void {
  const path = resolve(homedir(), ".ppm", "status.json");
  if (!existsSync(path)) return;
  try {
    const data = JSON.parse(readFileSync(path, "utf-8"));
    writeFileSync(path, JSON.stringify({ ...data, shareUrl }));
  } catch { /* ignore — status.json may be absent in dev */ }
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
    patchStatusFile(url);
    return c.json(ok({ url }));
  } catch (e) {
    return c.json(err((e as Error).message), 500);
  }
});

/** POST /api/tunnel/stop — stop tunnel */
tunnelRoutes.post("/stop", (c) => {
  tunnelService.stopTunnel();
  patchStatusFile(null);
  return c.json(ok({ stopped: true }));
});
