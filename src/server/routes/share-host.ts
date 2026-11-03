/**
 * Share host API (`/api/share-host`): the public review address, which reaches PPM's review
 * pages and nothing else. Guard + (de)serialization only — the logic lives in
 * `share-host-setup.service.ts`, and Cloudflare login is PPM's own (`/api/tunnel/named/login`).
 */
import { Hono } from "hono";
import { ok, err } from "../../types/api.ts";
import { configService } from "../../services/config.service.ts";
import { getConfigValue } from "../../services/db.service.ts";
import { resolveTunnelConfig } from "../../services/named-tunnel/named-tunnel-config.ts";
import { namedTunnelSetupService, SetupError } from "../../services/named-tunnel/named-tunnel-setup.service.ts";
import { readStatus } from "../../services/supervisor-state.ts";
import { resolveShareHostConfig } from "../../services/share-host/share-host-config.ts";
import { readShareHostLive } from "../../services/share-host/share-host-status.ts";
import { shareHostSetupService } from "../../services/share-host/share-host-setup.service.ts";
import { assertMutationAllowed } from "./named-tunnel.ts";

export const shareHostRoutes = new Hono();

const GUARD_LABEL = "a public review address";

function failure(e: unknown, fallback: string) {
  const status = (e instanceof SetupError ? e.status : 500) as 400 | 409 | 500;
  return { body: err((e as Error).message || fallback), status };
}

shareHostRoutes.get("/status", (c) => {
  // Read from the database, as the supervisor and the share address do, so all three agree.
  const config = resolveShareHostConfig(getConfigValue("share_host"));
  const status = readStatus();
  const live = readShareHostLive(config, status);
  const ppm = resolveTunnelConfig(getConfigValue("tunnel"));
  const capabilities = Array.isArray(status.capabilities) ? (status.capabilities as unknown[]) : [];
  return c.json(ok({
    enabled: config.enabled,
    mode: config.mode,
    hostname: config.hostname,
    tunnelName: config.mode === "shared" ? ppm.tunnelName : config.tunnelName,
    /** A supervisor runs that can apply a change without a restart. */
    canApply: live.supervised && capabilities.includes("reshare"),
    supervised: live.supervised,
    running: live.running,
    connected: live.connected,
    url: live.url,
    warning: live.warning,
    ppmTunnel: { named: ppm.mode === "named", hostname: ppm.hostname, enabled: ppm.enabled },
    certState: namedTunnelSetupService.currentCertState(),
    authEnabled: configService.get("auth").enabled,
  }));
});

shareHostRoutes.get("/zone", async (c) => {
  try {
    return c.json(ok(await shareHostSetupService.readZone()));
  } catch (e) {
    const { body, status } = failure(e, "failed to read zone info");
    return c.json(body, status);
  }
});

shareHostRoutes.post("/enabled", async (c) => {
  const guard = assertMutationAllowed(c, GUARD_LABEL);
  if (guard) return guard;
  const body = await c.req.json().catch(() => null) as { enabled?: unknown } | null;
  if (typeof body?.enabled !== "boolean") return c.json(err("enabled must be true or false"), 400);
  return c.json(ok(await shareHostSetupService.setEnabled(body.enabled)));
});

shareHostRoutes.post("/quick", async (c) => {
  const guard = assertMutationAllowed(c, GUARD_LABEL);
  if (guard) return guard;
  return c.json(ok(await shareHostSetupService.useTemporary()));
});

shareHostRoutes.post("/setup", async (c) => {
  const guard = assertMutationAllowed(c, GUARD_LABEL);
  if (guard) return guard;
  const body = await c.req.json().catch(() => null) as { mode?: unknown; hostname?: unknown } | null;
  if (body?.mode !== "named" && body?.mode !== "shared") return c.json(err("mode must be named or shared"), 400);
  const hostname = typeof body.hostname === "string" ? body.hostname.trim().toLowerCase() : "";
  if (!hostname) return c.json(err("hostname is required"), 400);
  try {
    return c.json(ok(await shareHostSetupService.runSetup(body.mode, hostname)));
  } catch (e) {
    const { body: out, status } = failure(e, "setup failed");
    return c.json(out, status);
  }
});
