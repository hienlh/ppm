import { Hono } from "hono";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { homedir } from "node:os";
import { tunnelService } from "../../services/tunnel.service.ts";
import { configService } from "../../services/config.service.ts";
import { getLocalIp } from "../../lib/network-utils.ts";
import { ok, err } from "../../types/api.ts";

/** Patch shareUrl + tunnelPid in status.json so `ppm status` reflects web-started tunnels */
function patchStatusFile(shareUrl: string | null): void {
  const path = resolve(homedir(), ".ppm", "status.json");
  if (!existsSync(path)) return;
  try {
    const data = JSON.parse(readFileSync(path, "utf-8"));
    data.shareUrl = shareUrl;
    data.tunnelPid = shareUrl ? tunnelService.getTunnelPid() : null;
    writeFileSync(path, JSON.stringify(data));
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

    // Sync tunnel URL to PPM Cloud (if linked)
    import("../../services/cloud.service.ts")
      .then(({ startHeartbeat, getCloudDevice }) => {
        if (getCloudDevice()) startHeartbeat(url);
      })
      .catch(() => {});

    return c.json(ok({ url }));
  } catch (e) {
    return c.json(err((e as Error).message), 500);
  }
});

/** POST /api/tunnel/stop — stop tunnel */
tunnelRoutes.post("/stop", (c) => {
  tunnelService.stopTunnel();
  patchStatusFile(null);

  // Stop cloud heartbeat
  import("../../services/cloud.service.ts")
    .then(({ stopHeartbeat }) => stopHeartbeat())
    .catch(() => {});

  return c.json(ok({ stopped: true }));
});
