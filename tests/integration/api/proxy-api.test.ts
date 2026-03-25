import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import "../../test-setup.ts";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { setKeyPath } from "../../../src/lib/account-crypto.ts";
import { openTestDb, setDb, setConfigValue, getConfigValue } from "../../../src/services/db.service.ts";
import { accountService } from "../../../src/services/account.service.ts";
import { accountSelector } from "../../../src/services/account-selector.service.ts";
import { proxyService } from "../../../src/services/proxy.service.ts";
import { app } from "../../../src/server/index.ts";

const testKeyPath = resolve(tmpdir(), `ppm-test-proxy-${Date.now()}.key`);
setKeyPath(testKeyPath);

/** Shorthand for app.request */
async function req(path: string, init?: RequestInit) {
  const url = `http://localhost${path}`;
  const headers = new Headers(init?.headers);
  if (!headers.has("Content-Type") && init?.body) {
    headers.set("Content-Type", "application/json");
  }
  return app.request(new Request(url, { ...init, headers }));
}

beforeEach(() => {
  setDb(openTestDb());
  accountSelector.setStrategy("round-robin");
  accountSelector.setMaxRetry(0);
  // Reset proxy state
  proxyService.setEnabled(false);
  proxyService.setAuthKey("");
});

// ── Proxy Routes (/proxy/*) ──────────────────────────────────────────

describe("OPTIONS /proxy/* (CORS preflight)", () => {
  it("returns 204 with CORS headers", async () => {
    const res = await req("/proxy/v1/messages", {
      method: "OPTIONS",
      headers: { Origin: "http://example.com" },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
    const methods = res.headers.get("Access-Control-Allow-Methods") ?? "";
    expect(methods).toInclude("POST");
  });
});

describe("POST /proxy/v1/messages", () => {
  it("returns 503 when proxy is disabled", async () => {
    proxyService.setEnabled(false);
    const res = await req("/proxy/v1/messages", {
      method: "POST",
      body: JSON.stringify({ model: "claude-sonnet-4-6", messages: [] }),
    });
    expect(res.status).toBe(503);
    const json = await res.json() as any;
    expect(json.type).toBe("error");
    expect(json.error.message).toContain("disabled");
  });

  it("returns 401 when no auth header", async () => {
    proxyService.setEnabled(true);
    proxyService.setAuthKey("test-key-123");
    const res = await req("/proxy/v1/messages", {
      method: "POST",
      body: JSON.stringify({ model: "claude-sonnet-4-6", messages: [] }),
    });
    expect(res.status).toBe(401);
    const json = await res.json() as any;
    expect(json.error.type).toBe("authentication_error");
  });

  it("returns 401 when auth key is wrong", async () => {
    proxyService.setEnabled(true);
    proxyService.setAuthKey("correct-key");
    const res = await req("/proxy/v1/messages", {
      method: "POST",
      headers: { Authorization: "Bearer wrong-key" },
      body: JSON.stringify({ model: "claude-sonnet-4-6", messages: [] }),
    });
    expect(res.status).toBe(401);
  });

  it("accepts Bearer auth header", async () => {
    proxyService.setEnabled(true);
    const key = proxyService.generateAuthKey();
    // No accounts → forward returns 401 "No active accounts"
    const res = await req("/proxy/v1/messages", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}` },
      body: JSON.stringify({ model: "claude-sonnet-4-6", messages: [] }),
    });
    // With no accounts, proxyService.forward returns 401
    expect(res.status).toBe(401);
    const json = await res.json() as any;
    expect(json.error.message).toContain("No active accounts");
  });

  it("accepts x-api-key header", async () => {
    proxyService.setEnabled(true);
    const key = proxyService.generateAuthKey();
    const res = await req("/proxy/v1/messages", {
      method: "POST",
      headers: { "x-api-key": key },
      body: JSON.stringify({ model: "claude-sonnet-4-6", messages: [] }),
    });
    // Passes auth, fails at "no accounts"
    expect(res.status).toBe(401);
    const json = await res.json() as any;
    expect(json.error.message).toContain("No active accounts");
  });

  it("forwards to Anthropic when account available", async () => {
    proxyService.setEnabled(true);
    const key = proxyService.generateAuthKey();

    // Add a test account with an API key (non-OAuth)
    accountService.add({
      email: "proxy-test@example.com",
      accessToken: "sk-ant-api-test-key",
      refreshToken: "",
      expiresAt: Date.now() + 3600_000,
    });

    // Mock global fetch to simulate Anthropic response
    const originalFetch = globalThis.fetch;
    const mockFetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
      const urlStr = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
      if (urlStr.includes("api.anthropic.com")) {
        return new Response(JSON.stringify({
          id: "msg_test",
          type: "message",
          content: [{ type: "text", text: "Hello" }],
        }), {
          status: 200,
          headers: { "Content-Type": "application/json", "x-request-id": "req-123" },
        });
      }
      return originalFetch(url, init);
    }) as typeof globalThis.fetch;
    globalThis.fetch = mockFetch;

    try {
      const res = await req("/proxy/v1/messages", {
        method: "POST",
        headers: {
          "x-api-key": key,
          "anthropic-version": "2023-06-01",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "claude-sonnet-4-6",
          max_tokens: 100,
          messages: [{ role: "user", content: "Hello" }],
        }),
      });

      expect(res.status).toBe(200);
      const json = await res.json() as any;
      expect(json.type).toBe("message");
      expect(json.content[0].text).toBe("Hello");

      // Verify CORS header on response
      expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");

      // Verify fetch was called with correct URL
      expect(mockFetch).toHaveBeenCalled();
      const callArgs = mockFetch.mock.calls[0];
      expect(String(callArgs[0])).toContain("api.anthropic.com/v1/messages");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("handles upstream 429 rate limit", async () => {
    proxyService.setEnabled(true);
    const key = proxyService.generateAuthKey();

    accountService.add({
      email: "rate-limit@test.com",
      accessToken: "sk-ant-api-rate-limit",
      refreshToken: "",
      expiresAt: Date.now() + 3600_000,
    });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ type: "error", error: { type: "rate_limit_error", message: "Rate limited" } }), {
        status: 429,
        headers: { "Content-Type": "application/json" },
      })
    ) as typeof globalThis.fetch;

    try {
      const res = await req("/proxy/v1/messages", {
        method: "POST",
        headers: { "x-api-key": key },
        body: JSON.stringify({ model: "claude-sonnet-4-6", messages: [] }),
      });
      expect(res.status).toBe(429);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("handles upstream fetch error as 502", async () => {
    proxyService.setEnabled(true);
    const key = proxyService.generateAuthKey();

    accountService.add({
      email: "error@test.com",
      accessToken: "sk-ant-api-error",
      refreshToken: "",
      expiresAt: Date.now() + 3600_000,
    });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      throw new Error("Connection refused");
    }) as typeof globalThis.fetch;

    try {
      const res = await req("/proxy/v1/messages", {
        method: "POST",
        headers: { "x-api-key": key },
        body: JSON.stringify({ model: "claude-sonnet-4-6", messages: [] }),
      });
      expect(res.status).toBe(502);
      const json = await res.json() as any;
      expect(json.error.message).toContain("Connection refused");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("POST /proxy/v1/messages/count_tokens", () => {
  it("returns 503 when disabled", async () => {
    proxyService.setEnabled(false);
    const res = await req("/proxy/v1/messages/count_tokens", {
      method: "POST",
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(503);
  });

  it("returns 401 without valid auth", async () => {
    proxyService.setEnabled(true);
    proxyService.setAuthKey("key-123");
    const res = await req("/proxy/v1/messages/count_tokens", {
      method: "POST",
      headers: { "x-api-key": "wrong" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(401);
  });
});

// ── Settings Proxy Routes (/api/settings/proxy) ─────────────────────

describe("GET /api/settings/proxy", () => {
  it("returns proxy status (disabled by default)", async () => {
    const res = await req("/api/settings/proxy");
    const json = await res.json() as any;
    expect(json.ok).toBe(true);
    expect(json.data.enabled).toBe(false);
    expect(typeof json.data.requestCount).toBe("number");
    expect(json.data.tunnelUrl).toBeNull();
    expect(json.data.proxyEndpoint).toBeNull();
  });

  it("reflects enabled state and auth key", async () => {
    proxyService.setEnabled(true);
    proxyService.setAuthKey("my-key-abc");
    const res = await req("/api/settings/proxy");
    const json = await res.json() as any;
    expect(json.data.enabled).toBe(true);
    expect(json.data.authKey).toBe("my-key-abc");
  });
});

describe("PUT /api/settings/proxy", () => {
  it("enables proxy", async () => {
    const res = await req("/api/settings/proxy", {
      method: "PUT",
      body: JSON.stringify({ enabled: true }),
    });
    const json = await res.json() as any;
    expect(json.ok).toBe(true);
    expect(json.data.enabled).toBe(true);
    expect(proxyService.isEnabled()).toBe(true);
  });

  it("disables proxy", async () => {
    proxyService.setEnabled(true);
    const res = await req("/api/settings/proxy", {
      method: "PUT",
      body: JSON.stringify({ enabled: false }),
    });
    const json = await res.json() as any;
    expect(json.data.enabled).toBe(false);
  });

  it("generates auth key", async () => {
    const res = await req("/api/settings/proxy", {
      method: "PUT",
      body: JSON.stringify({ generateKey: true }),
    });
    const json = await res.json() as any;
    expect(json.data.authKey).toBeTruthy();
    expect(json.data.authKey).toStartWith("ppm-proxy-");
    expect(json.data.authKey.length).toBeGreaterThan(20);
  });

  it("sets custom auth key", async () => {
    const res = await req("/api/settings/proxy", {
      method: "PUT",
      body: JSON.stringify({ authKey: "custom-secret-key" }),
    });
    const json = await res.json() as any;
    expect(json.data.authKey).toBe("custom-secret-key");
  });

  it("regenerates key (replaces old key)", async () => {
    proxyService.setAuthKey("old-key");
    const res = await req("/api/settings/proxy", {
      method: "PUT",
      body: JSON.stringify({ generateKey: true }),
    });
    const json = await res.json() as any;
    expect(json.data.authKey).not.toBe("old-key");
    expect(json.data.authKey).toStartWith("ppm-proxy-");
  });
});
