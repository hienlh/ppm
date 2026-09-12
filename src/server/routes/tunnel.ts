import { Hono } from "hono";
import { tunnelService } from "../../services/tunnel.service.ts";
import { configService } from "../../services/config.service.ts";
import { getLocalIp } from "../../lib/network-utils.ts";
import { ok, err } from "../../types/api.ts";
import { getConfigValue } from "../../services/db.service.ts";
import { resolveTunnelConfig } from "../../services/named-tunnel/named-tunnel-config.ts";
import { requestTunnelReload } from "../../services/supervisor-state.ts";

export const tunnelRoutes = new Hono();

/** GET /api/tunnel — current tunnel status + local URL */
tunnelRoutes.get("/", (c) => {
  const url = tunnelService.getTunnelUrl();
  const port = configService.get("port") ?? 8080;
  const localIp = getLocalIp();
  const localUrl = localIp ? `http://${localIp}:${port}` : null;
  // `enabled` is what the user asked for; `active` is what is actually serving.
  // They disagree for the seconds between a toggle and the supervisor acting on
  // it, and whenever a tunnel the switch permits has failed to come up.
  const enabled = resolveTunnelConfig(getConfigValue("tunnel")).enabled;
  return c.json(ok({ active: !!url, url, localUrl, enabled }));
});

/**
 * POST /api/tunnel/enabled — the master switch.
 *
 * Writing the config is only half of it: the supervisor owns the cloudflared
 * process and lives in another process with its own config cache, so the change
 * reaches it as a `retunnel`, which it already knows how to claim atomically.
 * `no-supervisor` is not an error — a dev server started without one still
 * persists the choice for the next real start.
 */
tunnelRoutes.post("/enabled", async (c) => {
  const body = await c.req.json().catch(() => null) as { enabled?: unknown } | null;
  if (typeof body?.enabled !== "boolean") {
    return c.json(err("`enabled` must be a boolean"), 400);
  }
  const current = configService.get("tunnel");
  configService.set("tunnel", { ...current, enabled: body.enabled });
  const reload = requestTunnelReload();
  return c.json(ok({ enabled: body.enabled, reload }));
});

/** POST /api/tunnel/start — start tunnel if not already running */
tunnelRoutes.post("/start", async (c) => {
  // Named mode is exclusively supervisor-owned (spawnTunnel). This manual-start
  // surface would otherwise spawn a SECOND cloudflared connector for the same
  // hostname whenever `existing` is momentarily null — e.g. the restart/downgrade
  // window right after a named tunnel is configured or disabled — and Cloudflare
  // round-robins between the two, so ~half of requests hit whichever origin the
  // stale connector still points at.
  const cfg = resolveTunnelConfig(getConfigValue("tunnel"));
  if (cfg.mode === "named") {
    return c.json(err("named tunnel is supervisor-managed"), 409);
  }

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
