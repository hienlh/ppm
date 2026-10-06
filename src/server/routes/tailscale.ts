/**
 * Tailscale settings API (`/api/tailscale`). Guard + (de)serialization over
 * `tailscale-app-service` and `tailscale-login`; the logic lives there.
 */
import { Hono, type Context } from "hono";
import { ok, err } from "../../types/api.ts";
import { configService } from "../../services/config.service.ts";
import { tailscaleAppService, TailscaleServiceError } from "../../services/tailscale/tailscale-app-service.ts";
import { tailscaleLoginService } from "../../services/tailscale/tailscale-login.ts";
import type { TailscaleSettingsState, TailscaleSetupState } from "../../shared/tailscale-setup.ts";

export const tailscaleRoutes = new Hono();

/**
 * A foreign page must not drive the host's Tailscale through the browser. Hostname only,
 * as in `remote-desktop.ts`: the dev proxy rewrites the port. PPM's password is required
 * by the service, and only to turn the address on: signing the machine in exposes
 * nothing, and turning the address off must always work.
 */
function rejectCrossOrigin(c: Context): Response | null {
  const origin = c.req.header("origin");
  if (!origin) return null;
  let originHost: string | null = null;
  try { originHost = new URL(origin).hostname; } catch { originHost = null; }
  let requestHost: string | null = null;
  try { requestHost = new URL(c.req.url).hostname; } catch { requestHost = null; }
  if (!originHost || !requestHost || originHost !== requestHost) {
    return c.json(err("cross-origin request rejected"), 403);
  }
  return null;
}

const withPpmState = (state: TailscaleSetupState): TailscaleSettingsState => ({
  ...state,
  login: tailscaleLoginService.getLoginSnapshot(),
  authEnabled: configService.get("auth").enabled,
});

tailscaleRoutes.get("/state", async (c) => c.json(ok(withPpmState(await tailscaleAppService.readState()))));

tailscaleRoutes.post("/login", async (c) => {
  const guard = rejectCrossOrigin(c);
  if (guard) return guard;
  return c.json(ok(await tailscaleLoginService.startLogin()));
});

tailscaleRoutes.post("/login/cancel", (c) => {
  const guard = rejectCrossOrigin(c);
  if (guard) return guard;
  return c.json(ok(tailscaleLoginService.cancelLogin()));
});

/** `{ enabled: true, name?, replace? }` turns the address on, `{ enabled: false }` off, `{ name }` renames it. */
tailscaleRoutes.post("/service", async (c) => {
  const guard = rejectCrossOrigin(c);
  if (guard) return guard;
  const body = await c.req.json().catch(() => ({})) as { enabled?: unknown; name?: unknown; replace?: unknown };
  const name = typeof body.name === "string" ? body.name : undefined;
  try {
    let state: TailscaleSetupState;
    if (body.enabled === true) state = await tailscaleAppService.enableService({ name, replace: body.replace === true });
    else if (body.enabled === false) state = await tailscaleAppService.disableService();
    else if (name !== undefined) state = await tailscaleAppService.renameService(name);
    else return c.json(err("Nothing to change."), 400);
    return c.json(ok(withPpmState(state)));
  } catch (e) {
    if (e instanceof TailscaleServiceError) return c.json({ ...err(e.message), code: e.code }, e.status);
    return c.json(err((e as Error).message), 500);
  }
});
