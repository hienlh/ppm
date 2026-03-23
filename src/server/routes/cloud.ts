import { Hono } from "hono";
import { ok, err } from "../../types/api.ts";
import {
  getCloudAuth,
  getCloudDevice,
  saveCloudAuth,
  removeCloudAuth,
  linkDevice,
  unlinkDevice,
  sendHeartbeat,
  startHeartbeat,
  DEFAULT_CLOUD_URL,
} from "../../services/cloud.service.ts";
import { tunnelService } from "../../services/tunnel.service.ts";
import { configService } from "../../services/config.service.ts";
import { VERSION } from "../../version.ts";

export const cloudRoutes = new Hono();

/** GET /api/cloud/status — cloud connection status */
cloudRoutes.get("/status", (c) => {
  const auth = getCloudAuth();
  const device = getCloudDevice();
  const tunnelUrl = tunnelService.getTunnelUrl();

  return c.json(ok({
    logged_in: !!auth,
    email: auth?.email ?? null,
    cloud_url: auth?.cloud_url ?? configService.get("cloud_url") ?? DEFAULT_CLOUD_URL,
    linked: !!device,
    device_name: device?.name ?? null,
    device_id: device?.device_id ?? null,
    tunnel_active: !!tunnelUrl,
    tunnel_url: tunnelUrl,
  }));
});

/** POST /api/cloud/login — save cloud auth from web UI OAuth flow */
cloudRoutes.post("/login", async (c) => {
  const body = await c.req.json<{
    access_token: string;
    email: string;
    cloud_url?: string;
  }>();

  if (!body.access_token || !body.email) {
    return c.json(err("access_token and email required"), 400);
  }

  const cloudUrl = body.cloud_url ?? configService.get("cloud_url") ?? DEFAULT_CLOUD_URL;

  saveCloudAuth({
    access_token: body.access_token,
    refresh_token: "",
    email: body.email,
    cloud_url: cloudUrl,
    saved_at: new Date().toISOString(),
  });

  return c.json(ok({ email: body.email }));
});

/** POST /api/cloud/logout — remove cloud auth */
cloudRoutes.post("/logout", (_c) => {
  removeCloudAuth();
  return _c.json(ok(true));
});

/** POST /api/cloud/link — register device with cloud */
cloudRoutes.post("/link", async (c) => {
  const body = await c.req.json<{ name?: string }>().catch(() => ({} as { name?: string }));

  try {
    const device = await linkDevice(body.name);

    // Auto-start heartbeat if tunnel is active
    const tunnelUrl = tunnelService.getTunnelUrl();
    if (tunnelUrl) {
      startHeartbeat(tunnelUrl);
    }

    return c.json(ok({
      device_id: device.device_id,
      name: device.name,
      synced: !!tunnelUrl,
    }));
  } catch (e) {
    return c.json(err((e as Error).message), 500);
  }
});

/** POST /api/cloud/unlink — remove device from cloud */
cloudRoutes.post("/unlink", async (c) => {
  try {
    await unlinkDevice();
    return c.json(ok(true));
  } catch (e) {
    return c.json(err((e as Error).message), 500);
  }
});

/** GET /api/cloud/login-url — get cloud OAuth login URL for web redirect */
cloudRoutes.get("/login-url", (c) => {
  const cloudUrl = configService.get("cloud_url") ?? DEFAULT_CLOUD_URL;
  // Web UI opens this URL in a new tab/popup; cloud handles OAuth and returns token
  const loginUrl = `${cloudUrl}/auth/google/login`;
  return c.json(ok({ url: loginUrl, cloud_url: cloudUrl }));
});
