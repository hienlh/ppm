import { Hono } from "hono";
import { configService } from "../../services/config.service.ts";
import { proxyService } from "../../services/proxy.service.ts";
import { ok, err } from "../../types/api.ts";

/**
 * Settings → API Proxy, mounted under `/api/settings`.
 *
 * The auth key lets anyone holding it spend the user's accounts, so an answer carries only its
 * first characters unless the caller asks with `?reveal=1` — which the Proxy pane does when the
 * user presses Show, and `ppm proxy get --reveal` does for a person at a terminal. Everything else
 * (a status read, a pane opened on another device, a command an AI chat ran) never sees it.
 */
export const settingsProxyRoutes = new Hono();

/**
 * The key as a read that did not ask to reveal it sees it: its first four characters, then "…" —
 * fewer for a short custom key, so the prefix never amounts to half of it.
 */
export function redactProxyKey(key: string | null): string | null {
  if (!key) return key;
  return `${key.slice(0, Math.min(4, Math.floor(key.length / 2)))}…`;
}

/** Proxy settings with the local and tunnel endpoints, the key redacted unless `reveal`. */
async function buildProxyResponse(reveal: boolean) {
  const { tunnelService } = await import("../../services/tunnel.service.ts");
  const tunnelUrl = tunnelService.getTunnelUrl();
  const port = configService.get("port");
  const localOrigin = `http://localhost:${port}`;
  const key = proxyService.getAuthKey() || null;
  return {
    enabled: proxyService.isEnabled(),
    authKey: reveal ? key : redactProxyKey(key),
    authKeyRevealed: reveal && !!key,
    requestCount: proxyService.getRequestCount(),
    localEndpoint: `${localOrigin}/proxy/v1/messages`,
    localOpenAiEndpoint: `${localOrigin}/proxy/v1/chat/completions`,
    tunnelUrl: tunnelUrl ?? null,
    proxyEndpoint: tunnelUrl ? `${tunnelUrl}/proxy/v1/messages` : null,
    openAiEndpoint: tunnelUrl ? `${tunnelUrl}/proxy/v1/chat/completions` : null,
  };
}

const wantsReveal = (value: string | undefined) => value === "1" || value === "true";

/** GET /settings/proxy[?reveal=1] — proxy status */
settingsProxyRoutes.get("/proxy", async (c) => {
  return c.json(ok(await buildProxyResponse(wantsReveal(c.req.query("reveal")))));
});

/** PUT /settings/proxy[?reveal=1] — update proxy settings; answers like GET */
settingsProxyRoutes.put("/proxy", async (c) => {
  try {
    const body = await c.req.json<{ enabled?: boolean; authKey?: string; generateKey?: boolean }>();
    if (body.enabled !== undefined && typeof body.enabled !== "boolean") return c.json(err("enabled must be true or false"), 400);
    if (body.enabled !== undefined) proxyService.setEnabled(body.enabled);
    if (body.generateKey) proxyService.generateAuthKey();
    else if (body.authKey !== undefined) proxyService.setAuthKey(body.authKey);
    return c.json(ok(await buildProxyResponse(wantsReveal(c.req.query("reveal")))));
  } catch (e) {
    return c.json(err((e as Error).message), 400);
  }
});
