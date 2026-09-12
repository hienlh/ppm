import { Hono } from "hono";
import type { Context } from "hono";
import { proxyService } from "../../services/proxy.service.ts";
import { listProviderModels } from "../../services/proxy-agent-turn.ts";
import { forwardImageGeneration, forwardImageEdit } from "../../services/proxy-image-bridge.ts";
import { getProxyStats } from "../../services/db.service.ts";
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

/** Extract caller IP/UA from request headers for proxy logging */
function getCallerMeta(c: Context): { callerIp?: string; callerUa?: string } {
  return {
    callerIp: c.req.header("x-forwarded-for")?.split(",")[0]?.trim()
      || c.req.header("x-real-ip")
      || "unknown",
    callerUa: c.req.header("user-agent") || "unknown",
  };
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

  return proxyService.forward("/v1/messages", "POST", headers, body, getCallerMeta(c));
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
  return proxyService.forwardOpenAi(body, getCallerMeta(c));
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

  return proxyService.forward("/v1/messages/count_tokens", "POST", headers, body, getCallerMeta(c));
});

// ── Provider-scoped agent endpoints ──
//
// Both API dialects hang off the same `/proxy/<provider>` prefix, so a client
// only swaps its base URL and keeps the vendor path its SDK already appends:
//   ANTHROPIC_BASE_URL=<host>/proxy/codex     → POST /proxy/codex/v1/messages
//   OPENAI_BASE_URL=<host>/proxy/codex/v1     → POST /proxy/codex/v1/chat/completions
// Registered after the static routes above, which keep serving Claude unscoped.

/** Shared gate: proxy must be on and the caller must present the proxy key. */
function agentGate(c: Context, dialect: "anthropic" | "openai"): Response | null {
  const authHeader = c.req.header("authorization") || c.req.header("x-api-key");
  const fail = (status: 503 | 401, message: string) =>
    dialect === "anthropic"
      ? c.json({ type: "error", error: { type: status === 401 ? "authentication_error" : "api_error", message } }, status)
      : c.json({ error: { message, type: status === 401 ? "authentication_error" : "server_error" } }, status);

  if (!proxyService.isEnabled()) return fail(503, "Proxy is disabled");
  if (!validateProxyAuth(authHeader)) return fail(401, "Invalid proxy auth key");
  return null;
}

/** POST /proxy/:provider/v1/messages — provider's agent in Anthropic format. */
proxyRoutes.post("/:provider/v1/messages", async (c) => {
  const blocked = agentGate(c, "anthropic");
  if (blocked) return blocked;
  return proxyService.forwardAgentMessages(c.req.param("provider"), await c.req.text(), getCallerMeta(c));
});

/** POST /proxy/:provider/v1/chat/completions — provider's agent in OpenAI format. */
proxyRoutes.post("/:provider/v1/chat/completions", async (c) => {
  const blocked = agentGate(c, "openai");
  if (blocked) return blocked;
  return proxyService.forwardAgentChat(c.req.param("provider"), await c.req.text(), getCallerMeta(c));
});

/** POST /proxy/:provider/v1/images/generations — text to image, OpenAI shape. */
proxyRoutes.post("/:provider/v1/images/generations", async (c) => {
  const blocked = agentGate(c, "openai");
  if (blocked) return blocked;
  return forwardImageGeneration(c.req.param("provider"), await c.req.json().catch(() => ({})));
});

/** POST /proxy/:provider/v1/images/edits — image to image, OpenAI shape.
 *  JSON only: the agent needs the source on disk, so a base64 payload is what
 *  the bridge can actually act on. */
proxyRoutes.post("/:provider/v1/images/edits", async (c) => {
  const blocked = agentGate(c, "openai");
  if (blocked) return blocked;
  return forwardImageEdit(c.req.param("provider"), await c.req.json().catch(() => ({})));
});

/** GET /proxy/:provider/v1/models — models that provider offers, OpenAI list shape. */
proxyRoutes.get("/:provider/v1/models", async (c) => {
  const blocked = agentGate(c, "openai");
  if (blocked) return blocked;
  return listProviderModels(c.req.param("provider"));
});

/** GET /proxy/stats — proxy request stats (behind proxy auth) */
proxyRoutes.get("/stats", (c) => {
  const authHeader = c.req.header("authorization") || c.req.header("x-api-key");
  if (!validateProxyAuth(authHeader)) {
    return c.json({ error: "Invalid proxy auth key" }, 401);
  }
  const stats = getProxyStats();
  return c.json({ ...stats, requestCount: proxyService.getRequestCount() });
});
