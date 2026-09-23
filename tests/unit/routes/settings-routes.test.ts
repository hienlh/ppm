import { describe, it, expect, beforeEach } from "bun:test";
import { Hono } from "hono";
import { openTestDb, setDb, getConfigValue } from "../../../src/services/db.service.ts";
import { settingsRoutes } from "../../../src/server/routes/settings.ts";
import { configService } from "../../../src/services/config.service.ts";
import { DEFAULT_CONFIG } from "../../../src/types/config.ts";

function createApp() {
  return new Hono().route("/settings", settingsRoutes);
}

/** Set config to known defaults — uses in-memory DB to avoid corrupting prod */
function resetConfig() {
  setDb(openTestDb());
  configService.load();
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
    expect(json.data.new_chat_provider_mode).toBe("follow-focus");
    expect(json.data.share_provider_context).toBe(true);
    expect(json.data.providers.claude.type).toBe("agent-sdk");
    expect(json.data.providers.claude.model).toBe("claude-opus-5-5");
    expect(json.data.providers.claude.effort).toBe("high");
    expect(json.data.providers.claude.max_turns).toBe(1000);
    // api_key_env should be stripped from GET response
    expect(json.data.providers.claude.api_key_env).toBeUndefined();
  });
});

describe("PUT /settings/ai", () => {
  beforeEach(resetConfig);

  it("persists each new-chat mode and preserves it on unrelated updates", async () => {
    const app = createApp();
    const put = (body: Record<string, unknown>) => app.request("/settings/ai", {
      method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    const providers = structuredClone(configService.get("ai").providers);
    for (const mode of ["default", "follow-focus"]) {
      const res = await put({ new_chat_provider_mode: mode });
      expect(res.status).toBe(200);
      expect((await res.json()).data.new_chat_provider_mode).toBe(mode);
      expect(configService.load().ai.new_chat_provider_mode).toBe(mode);
      expect((await put({ share_provider_context: false })).status).toBe(200);
      expect(configService.load().ai.new_chat_provider_mode).toBe(mode);
      expect(configService.get("ai").providers).toEqual(providers);
    }
  });

  it("rejects invalid modes atomically", async () => {
    const app = createApp();
    const before = getConfigValue("ai");
    for (const value of [null, "recent", "", 0, true, {}]) {
      const res = await app.request("/settings/ai", {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ new_chat_provider_mode: value, share_provider_context: false }),
      });
      expect(res.status).toBe(400);
      expect(getConfigValue("ai")).toBe(before);
    }
  });

  it("accepts configured Codex as the default provider", async () => {
    const app = createApp();
    const res = await app.request("/settings/ai", {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ default_provider: "codex", providers: { codex: { type: "cli", cli_command: "codex" } } }),
    });
    expect(res.status).toBe(200);
    expect(configService.load().ai.default_provider).toBe("codex");
  });

  it("rejects malformed or inherited default provider keys", async () => {
    const app = createApp();
    for (const value of [null, "", 123, {}, "toString", "__proto__"]) {
      const res = await app.request("/settings/ai", {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ default_provider: value }),
      });
      expect(res.status).toBe(400);
    }
  });

  it("persists model-only updates and Auto for configured CLI providers", async () => {
    const app = createApp();
    for (const [name, command] of [["codex", "codex"], ["cursor", "cursor-agent"]]) {
      const put = (patch: Record<string, unknown>) => app.request("/settings/ai", {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ providers: { [name!]: patch } }),
      });
      expect((await put({ type: "cli", cli_command: command })).status).toBe(200);
      for (const model of ["gpt-5.6-terra", ""]) {
        const res = await put({ model });
        expect(res.status).toBe(200);
        expect((await res.json()).data.providers[name!].model).toBe(model);
        expect(configService.load().ai.providers[name!]).toMatchObject({
          type: "cli", cli_command: command, model,
        });
      }
      const before = getConfigValue("ai");
      expect((await put({ cli_command: "invalid-command" })).status).toBe(400);
      expect(getConfigValue("ai")).toBe(before);
    }
  });

  it("rejects non-Claude models in model-only SDK updates without saving", async () => {
    const before = getConfigValue("ai");
    const res = await createApp().request("/settings/ai", {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ providers: { claude: { model: "gpt-5.6-terra" } } }),
    });
    expect(res.status).toBe(400);
    expect(getConfigValue("ai")).toBe(before);
  });

  it("persists Codex token limits and resets overrides with null", async () => {
    const app = createApp();
    const put = (codex: Record<string, unknown>) => app.request("/settings/ai", {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ providers: { codex } }),
    });
    expect((await put({ type: "cli", cli_command: "codex", model_context_window: 872000,
      model_auto_compact_token_limit: 800000 })).status).toBe(200);
    expect(configService.load().ai.providers.codex!.model_context_window).toBe(872000);
    expect((await put({ model_context_window: null, model_auto_compact_token_limit: null })).status).toBe(200);
    const saved = JSON.parse(getConfigValue("ai")!).providers.codex;
    expect(saved).not.toHaveProperty("model_context_window");
    expect(saved).not.toHaveProperty("model_auto_compact_token_limit");
    expect(saved.cli_command).toBe("codex");
  });

  it("rejects malformed and inconsistent token limits atomically, including partial updates", async () => {
    const app = createApp();
    const put = (codex: Record<string, unknown>) => app.request("/settings/ai", {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ providers: { codex } }),
    });
    const initialConfig = getConfigValue("ai");
    for (const key of ["model_context_window", "model_auto_compact_token_limit"]) {
      for (const value of [0, -1, 2.5, "800000", true, {}, Number.MAX_SAFE_INTEGER + 1]) {
        expect((await put({ [key]: value })).status).toBe(400);
        expect(getConfigValue("ai")).toBe(initialConfig);
      }
    }
    expect((await put({ type: "cli", cli_command: "codex", model_context_window: 872000,
      model_auto_compact_token_limit: 800000 })).status).toBe(200);
    const before = getConfigValue("ai");
    expect((await put({ model_context_window: 700000 })).status).toBe(400);
    expect((await put({ model_auto_compact_token_limit: 900000 })).status).toBe(400);
    expect(getConfigValue("ai")).toBe(before);
    expect(configService.get("ai").providers.codex!.model_context_window).toBe(872000);
  });

  it("persists sharing off and on without modifying provider settings", async () => {
    const app = createApp();
    const providers = structuredClone(configService.get("ai").providers);
    for (const enabled of [false, true]) {
      const res = await app.request("/settings/ai", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ share_provider_context: enabled }),
      });
      expect(res.status).toBe(200);
      expect((await res.json()).data.share_provider_context).toBe(enabled);
      expect(JSON.parse(getConfigValue("ai")!).share_provider_context).toBe(enabled);
      expect(configService.load().ai.share_provider_context).toBe(enabled);
      expect(configService.get("ai").providers).toEqual(providers);
    }
  });

  it("rejects invalid sharing values without changing stored settings", async () => {
    const app = createApp();
    for (const value of ["false", 0, null, {}]) {
      const res = await app.request("/settings/ai", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ share_provider_context: value }),
      });
      expect(res.status).toBe(400);
      expect(configService.get("ai").share_provider_context).toBe(true);
    }
  });

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

  it("rejects default_provider that is not configured", async () => {
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
