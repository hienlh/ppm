/**
 * Named-tunnel setup API (`/api/tunnel/named`). Thin wrappers over
 * `cloudflared-login.service` and `named-tunnel-setup.service` — all business
 * logic lives there; this file is guard + (de)serialization only.
 */
import { Hono, type Context } from "hono";
import { ok, err } from "../../types/api.ts";
import { configService } from "../../services/config.service.ts";
import { resolveTunnelConfig, maskToken } from "../../services/named-tunnel/named-tunnel-config.ts";
import { cloudflaredLoginService } from "../../services/named-tunnel/cloudflared-login.service.ts";
import { namedTunnelSetupService, SetupError } from "../../services/named-tunnel/named-tunnel-setup.service.ts";
import { broadcastGlobalEvent } from "../ws/global.ts";
import { readStatus } from "../../services/supervisor-state.ts";

export const namedTunnelRoutes = new Hono();

/**
 * A stable, guessable public hostname must never be one unauthenticated
 * request away. `authMiddleware` already lets everything through when PPM
 * auth is disabled (auth.ts:10-13 explicitly passes through), so the four
 * mutating routes below enforce their own independent check, plus a
 * same-origin check so a foreign page cannot drive them via ambient
 * browser credentials.
 */
function assertMutationAllowed(c: Context): Response | null {
  if (!configService.get("auth").enabled) {
    return c.json(err("named-tunnel setup requires PPM authentication to be enabled"), 403);
  }
  const origin = c.req.header("origin");
  if (origin) {
    let originHost: string | null = null;
    try { originHost = new URL(origin).host; } catch { originHost = null; }
    const requestHost = new URL(c.req.url).host;
    if (!originHost || originHost !== requestHost) {
      return c.json(err("cross-origin request rejected"), 403);
    }
  }
  return null;
}

namedTunnelRoutes.get("/status", (c) => {
  const resolved = resolveTunnelConfig(configService.get("tunnel"));
  // Config says what the user *asked for*; the supervisor's status.json says
  // what is *actually running*. When a named tunnel failed and the supervisor
  // fell back to quick, the warning it left behind is the only signal the UI
  // has that the two disagree — surface it instead of a silently wrong URL.
  const live = readStatus();
  const liveMode = live.tunnelMode === "named" || live.tunnelMode === "quick" ? live.tunnelMode : null;
  const tunnelWarning = typeof live.tunnelWarning === "string" ? live.tunnelWarning : null;
  return c.json(ok({
    mode: resolved.mode,
    liveMode,
    hostname: resolved.hostname,
    tunnelName: resolved.tunnelName,
    tokenMasked: maskToken(resolved.token),
    certState: namedTunnelSetupService.currentCertState(),
    dismissed: resolved.dismissed,
    login: cloudflaredLoginService.getLoginSnapshot(),
    tunnelWarning,
  }));
});

// One-way, low-value target — must work even before auth is configured so
// the popup can be silenced regardless of the mutation guard above.
namedTunnelRoutes.post("/dismiss", (c) => {
  const current = configService.get("tunnel");
  configService.set("tunnel", { ...current, dismissed: true });
  return c.json(ok({ dismissed: true }));
});

namedTunnelRoutes.get("/zone", async (c) => {
  try {
    const info = await namedTunnelSetupService.readZoneInfo();
    return c.json(ok({ zone: info.zone, proposedHostname: info.proposedHostname }));
  } catch (e) {
    const status = e instanceof SetupError ? e.status : 500;
    return c.json(err((e as Error).message || "failed to read zone info"), status as 400 | 500);
  }
});

namedTunnelRoutes.post("/login", async (c) => {
  const guard = assertMutationAllowed(c);
  if (guard) return guard;
  const relogin = c.req.query("relogin") === "1";
  const snapshot = await cloudflaredLoginService.startLogin({ relogin });
  return c.json(ok(snapshot));
});

namedTunnelRoutes.post("/login/cancel", (c) => {
  const guard = assertMutationAllowed(c);
  if (guard) return guard;
  cloudflaredLoginService.cancelLogin();
  return c.json(ok({ state: "cancelled" as const }));
});

namedTunnelRoutes.post("/setup", async (c) => {
  const guard = assertMutationAllowed(c);
  if (guard) return guard;

  let body: { hostname?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json(err("invalid JSON body"), 400);
  }
  const hostname = typeof body.hostname === "string" ? body.hostname.trim().toLowerCase() : "";
  if (!hostname) return c.json(err("hostname is required"), 400);

  try {
    const result = await namedTunnelSetupService.runSetup(hostname);
    if (result.ok === "pending") {
      return c.json(ok({ hostname: result.hostname, tunnelName: result.tunnelName, pending: true, message: result.message }));
    }
    return c.json(ok({ hostname: result.hostname, tunnelName: result.tunnelName }));
  } catch (e) {
    const status = e instanceof SetupError ? e.status : 500;
    const message = (e as Error).message || "setup failed";
    broadcastGlobalEvent({ type: "tunnel:setup_error", message });
    return c.json(err(message), status as 400 | 409 | 500);
  }
});

namedTunnelRoutes.post("/disable", async (c) => {
  const guard = assertMutationAllowed(c);
  if (guard) return guard;
  await namedTunnelSetupService.disableNamedTunnel();
  return c.json(ok({ mode: "quick" as const }));
});
