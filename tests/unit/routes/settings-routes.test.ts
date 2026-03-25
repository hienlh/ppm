import { describe, it, expect, beforeEach } from "bun:test";
import { Hono } from "hono";
import { openTestDb, setDb } from "../../../src/services/db.service.ts";
import { settingsRoutes } from "../../../src/server/routes/settings.ts";
import { configService } from "../../../src/services/config.service.ts";
import { DEFAULT_CONFIG } from "../../../src/types/config.ts";

function createApp() {
  return new Hono().route("/settings", settingsRoutes);
}

/** Set config to known defaults — uses in-memory DB to avoid corrupting prod */
function resetConfig() {
  setDb(openTestDb());
  (configService as any).config.ai = structuredClone(DEFAULT_CONFIG.ai);
}

describe("GET /settings/ai", () => {
  beforeEach(resetConfig);

  it("returns current AI config with defaults", async () => {
    const app = createApp();
    const res = await app.request("/settings/ai");
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.data.default_provider).toBe("claude");
    expect(json.data.providers.claude.type).toBe("agent-sdk");
    expect(json.data.providers.claude.model).toBe("claude-sonnet-4-6");
    expect(json.data.providers.claude.effort).toBe("high");
    expect(json.data.providers.claude.max_turns).toBe(100);
    // api_key_env should be stripped from GET response
    expect(json.data.providers.claude.api_key_env).toBeUndefined();
  });
});

describe("PUT /settings/ai", () => {
  beforeEach(resetConfig);

  it("updates provider config and returns merged result", async () => {
    const app = createApp();
    const res = await app.request("/settings/ai", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        providers: { claude: { model: "claude-opus-4-6", max_turns: 50 } },
      }),
    });
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.data.providers.claude.model).toBe("claude-opus-4-6");
    expect(json.data.providers.claude.max_turns).toBe(50);
    // Original fields preserved
    expect(json.data.providers.claude.type).toBe("agent-sdk");
    expect(json.data.providers.claude.effort).toBe("high");
  });

  it("rejects invalid max_turns", async () => {
    const app = createApp();
    const res = await app.request("/settings/ai", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        providers: { claude: { max_turns: 999 } },
      }),
    });
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.ok).toBe(false);
  });

  it("rejects invalid effort", async () => {
    const app = createApp();
    const res = await app.request("/settings/ai", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        providers: { claude: { effort: "turbo" } },
      }),
    });
    expect(res.status).toBe(400);
  });

  it("updates default_provider to existing valid provider", async () => {
    // "claude" is the only valid provider — verify it can be explicitly set
    const app = createApp();
    const res = await app.request("/settings/ai", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ default_provider: "claude" }),
    });
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.data.default_provider).toBe("claude");
  });

  it("rejects default_provider not in VALID_PROVIDERS", async () => {
    const app = createApp();
    const res = await app.request("/settings/ai", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ default_provider: "mock" }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects default_provider referencing nonexistent provider", async () => {
    const app = createApp();
    const res = await app.request("/settings/ai", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ default_provider: "nonexistent" }),
    });
    expect(res.status).toBe(400);
  });

  it("handles malformed JSON", async () => {
    const app = createApp();
    const res = await app.request("/settings/ai", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: "not json",
    });
    expect(res.status).toBe(400);
  });

  it("saves api_key and masks it in response", async () => {
    const app = createApp();
    // Save an api_key
    const putRes = await app.request("/settings/ai", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        providers: { claude: { api_key: "sk-ant-test-secret-key-12345" } },
      }),
    });
    const putJson = await putRes.json() as any;
    expect(putJson.ok).toBe(true);
    // Response should have masked key (last 4 chars visible)
    expect(putJson.data.providers.claude.api_key).toBe("••••2345");

    // GET should also return masked
    const getRes = await app.request("/settings/ai");
    const getJson = await getRes.json() as any;
    expect(getJson.data.providers.claude.api_key).toBe("••••2345");
  });

  it("does not overwrite api_key when masked value sent back", async () => {
    const app = createApp();
    // First, save a real key
    await app.request("/settings/ai", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        providers: { claude: { api_key: "sk-ant-real-secret-key-abcd" } },
      }),
    });

    // Now send masked value back (simulating UI onBlur with unchanged field)
    const res = await app.request("/settings/ai", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        providers: { claude: { api_key: "••••abcd", model: "claude-opus-4-6" } },
      }),
    });
    const json = await res.json() as any;
    expect(json.ok).toBe(true);
    // Model updated, key still masked with same last 4
    expect(json.data.providers.claude.model).toBe("claude-opus-4-6");
    expect(json.data.providers.claude.api_key).toBe("••••abcd");

    // Verify underlying config still has real key
    const ai = configService.get("ai");
    expect(ai.providers.claude.api_key).toBe("sk-ant-real-secret-key-abcd");
  });

  it("clears api_key when empty string sent", async () => {
    const app = createApp();
    // Save a key first
    await app.request("/settings/ai", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        providers: { claude: { api_key: "sk-ant-to-clear" } },
      }),
    });

    // Clear it with empty string
    const res = await app.request("/settings/ai", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        providers: { claude: { api_key: "" } },
      }),
    });
    const json = await res.json() as any;
    expect(json.ok).toBe(true);
    // Empty key should not be masked
    expect(json.data.providers.claude.api_key).toBeFalsy();
  });
});
