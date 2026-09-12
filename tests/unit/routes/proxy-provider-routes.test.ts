/**
 * Route resolution for the provider-scoped proxy.
 *
 * `/proxy/v1/messages` (unscoped, Claude) and `/proxy/<provider>/v1/messages`
 * differ only by segment count, so a careless pattern would let the unscoped
 * path be swallowed with provider="v1". That failure is silent — the request
 * still returns JSON — which is exactly why it is pinned here.
 */
import { describe, it, expect, beforeAll } from "bun:test";
import { Hono } from "hono";
import { proxyRoutes } from "../../../src/server/routes/proxy.ts";
import { proxyService } from "../../../src/services/proxy.service.ts";

const KEY = "ppm-proxy-routetest";
const app = new Hono().route("/proxy", proxyRoutes);

beforeAll(() => {
  proxyService.setEnabled(true);
  proxyService.setAuthKey(KEY);
});

function post(path: string, body: unknown, key = KEY) {
  return app.request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
  });
}

const MSG = { model: "m", messages: [{ role: "user", content: "hi" }] };

describe("provider-scoped proxy routes", () => {
  it("keeps /proxy/v1/messages on the unscoped Claude path", async () => {
    const res = await post("/proxy/v1/messages", MSG);
    const j = await res.json() as any;
    // No Claude accounts in the test DB → the Claude path reports exactly this.
    // Had it matched the provider route, the error would name an unknown provider.
    expect(j.error.message).toBe("No active accounts available");
  });

  it("keeps /proxy/v1/chat/completions on the unscoped Claude path", async () => {
    const res = await post("/proxy/v1/chat/completions", MSG);
    expect((await res.json() as any).error.message).toBe("No active accounts available");
  });

  it("keeps /proxy/v1/messages/count_tokens unscoped", async () => {
    const res = await post("/proxy/v1/messages/count_tokens", MSG);
    expect((await res.json() as any).error.message).toBe("No active accounts available");
  });

  it("routes /proxy/<provider>/v1/messages to the agent bridge", async () => {
    const res = await post("/proxy/nosuch/v1/messages", MSG);
    expect(res.status).toBe(404);
    const j = await res.json() as any;
    expect(j.type).toBe("error");
    expect(j.error.message).toContain('Unknown provider "nosuch"');
  });

  it("routes /proxy/<provider>/v1/chat/completions to the agent bridge", async () => {
    const res = await post("/proxy/nosuch/v1/chat/completions", MSG);
    expect(res.status).toBe(404);
    expect((await res.json() as any).error.message).toContain('Unknown provider "nosuch"');
  });

  it("serves /proxy/<provider>/v1/models", async () => {
    const res = await app.request("/proxy/claude/v1/models", { headers: { Authorization: `Bearer ${KEY}` } });
    expect(res.status).toBe(200);
    expect((await res.json() as any).object).toBe("list");
  });

  it("rejects a bad key on both dialects with each one's own error shape", async () => {
    const anthropic = await post("/proxy/nosuch/v1/messages", MSG, "wrong");
    expect(anthropic.status).toBe(401);
    expect((await anthropic.json() as any).type).toBe("error");

    const openai = await post("/proxy/nosuch/v1/chat/completions", MSG, "wrong");
    expect(openai.status).toBe(401);
    expect((await openai.json() as any).error.type).toBe("authentication_error");
  });

  it("refuses every provider endpoint while the proxy is disabled", async () => {
    proxyService.setEnabled(false);
    try {
      expect((await post("/proxy/nosuch/v1/messages", MSG)).status).toBe(503);
      expect((await post("/proxy/nosuch/v1/chat/completions", MSG)).status).toBe(503);
    } finally {
      proxyService.setEnabled(true);
    }
  });
});
