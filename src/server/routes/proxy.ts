import { Hono } from "hono";
import { proxyService } from "../../services/proxy.service.ts";
import { ok, err } from "../../types/api.ts";

/**
 * Proxy routes — Anthropic-compatible API proxy.
 * External tools (opencode, cursor, etc.) send requests here
 * and PPM forwards them to Anthropic using account rotation.
 *
 * Mounted at /proxy — so /proxy/v1/messages maps to Anthropic's POST /v1/messages.
 * Uses its own auth (proxy auth key), NOT PPM's auth middleware.
 */
export const proxyRoutes = new Hono();

/** Validate proxy auth key from Authorization header */
function validateProxyAuth(authHeader: string | undefined): boolean {
  if (!authHeader) return false;
  const key = proxyService.getAuthKey();
  if (!key) return false;
  // Accept both "Bearer <key>" and raw "<key>" (x-api-key style)
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : authHeader;
  return token === key;
}

/** CORS preflight for external tools */
proxyRoutes.options("/*", (c) => {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization, x-api-key, anthropic-version, anthropic-beta",
      "Access-Control-Max-Age": "86400",
    },
  });
});

/** POST /proxy/v1/messages — Anthropic Messages API proxy */
proxyRoutes.post("/v1/messages", async (c) => {
  if (!proxyService.isEnabled()) {
    return c.json({ type: "error", error: { type: "api_error", message: "Proxy is disabled" } }, 503);
  }

  // Auth check — accept both Authorization and x-api-key headers
  const authHeader = c.req.header("authorization") || c.req.header("x-api-key");
  if (!validateProxyAuth(authHeader)) {
    return c.json({ type: "error", error: { type: "authentication_error", message: "Invalid proxy auth key" } }, 401);
  }

  const body = await c.req.text();
  const headers: Record<string, string> = {};
  for (const key of ["anthropic-version", "anthropic-beta", "content-type"]) {
    const val = c.req.header(key);
    if (val) headers[key] = val;
  }

  return proxyService.forward("/v1/messages", "POST", headers, body);
});

/** POST /proxy/v1/chat/completions — OpenAI-compatible chat completions proxy */
proxyRoutes.post("/v1/chat/completions", async (c) => {
  if (!proxyService.isEnabled()) {
    return c.json({ error: { message: "Proxy is disabled", type: "server_error" } }, 503);
  }

  const authHeader = c.req.header("authorization") || c.req.header("x-api-key");
  if (!validateProxyAuth(authHeader)) {
    return c.json({ error: { message: "Invalid proxy auth key", type: "authentication_error" } }, 401);
  }

  const body = await c.req.text();
  return proxyService.forwardOpenAi(body);
});

/** POST /proxy/v1/messages/count_tokens — token counting proxy */
proxyRoutes.post("/v1/messages/count_tokens", async (c) => {
  if (!proxyService.isEnabled()) {
    return c.json({ type: "error", error: { type: "api_error", message: "Proxy is disabled" } }, 503);
  }

  const authHeader = c.req.header("authorization") || c.req.header("x-api-key");
  if (!validateProxyAuth(authHeader)) {
    return c.json({ type: "error", error: { type: "authentication_error", message: "Invalid proxy auth key" } }, 401);
  }

  const body = await c.req.text();
  const headers: Record<string, string> = {};
  for (const key of ["anthropic-version", "anthropic-beta", "content-type"]) {
    const val = c.req.header(key);
    if (val) headers[key] = val;
  }

  return proxyService.forward("/v1/messages/count_tokens", "POST", headers, body);
});
