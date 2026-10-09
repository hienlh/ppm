/**
 * Settings → PPM Assistant on the server: an MCP server's env and header values never reach a
 * browser, and a blank sent back keeps the saved value — following its server across a rename.
 */
import { afterEach, describe, expect, it } from "bun:test";
import "../../test-setup.ts";
import { Hono } from "hono";
import { configService } from "../../../src/services/config.service.ts";
import {
  assistantSettingsView, enabledAssistantMcpServers, getAssistantSettings, saveAssistantSettings,
} from "../../../src/services/assistant/assistant-settings.service.ts";
import { assistantSettingsRoutes } from "../../../src/server/routes/assistant-settings.ts";
import { DEFAULT_ASSISTANT_SETTINGS } from "../../../src/shared/assistant-settings.ts";
import { redactSecretConfigValue } from "../../../src/services/config-secret-keys.ts";

const anyProvider = () => true;
const SERVER = { name: "github", transport: "stdio", command: "npx", args: ["gh-mcp"], env: { GH_TOKEN: "ghp-secret" } };
const HTTP = { name: "docs", transport: "http", url: "https://docs.example/mcp", headers: { Authorization: "Bearer docs-secret" } };

afterEach(() => configService.set("assistant", structuredClone(DEFAULT_ASSISTANT_SETTINGS)));

function saveOk(input: unknown) {
  const result = saveAssistantSettings(input, anyProvider);
  if (!result.ok) throw new Error(result.errors.join("; "));
  return result.settings;
}

describe("assistant settings service", () => {
  it("stores the secrets, gives each server an id, and shows a browser blanks", () => {
    const view = saveOk({ mcp_servers: [SERVER, HTTP] });
    expect(JSON.stringify(view)).not.toContain("ghp-secret");
    expect(JSON.stringify(assistantSettingsView())).not.toContain("docs-secret");
    expect(view.mcp_servers[0]).toMatchObject({ env: { GH_TOKEN: "" } });
    expect(view.mcp_servers[0]!.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(getAssistantSettings().mcp_servers[0]).toMatchObject({ env: { GH_TOKEN: "ghp-secret" } });
    expect(enabledAssistantMcpServers().map((s) => s.name)).toEqual(["github", "docs"]);
  });

  it("keeps a saved value for a blank, across a rename, and refuses a blank with nothing saved", () => {
    const [github, docs] = saveOk({ mcp_servers: [SERVER, HTTP] }).mcp_servers;
    saveOk({ mcp_servers: [{ ...github, name: "gh" }, { ...docs, headers: { Authorization: "" } }] });
    const stored = getAssistantSettings().mcp_servers;
    expect(stored[0]).toMatchObject({ name: "gh", env: { GH_TOKEN: "ghp-secret" } });
    expect(stored[1]).toMatchObject({ headers: { Authorization: "Bearer docs-secret" } });

    const result = saveAssistantSettings({ mcp_servers: [{ ...github, env: { GH_TOKEN: "", NEW_KEY: "" } }] }, anyProvider);
    expect(result).toEqual({ ok: false, errors: ['MCP server "github": variable NEW_KEY needs a value'] });
    // A server the store has never seen cannot borrow another's secret.
    expect(saveAssistantSettings({ mcp_servers: [{ ...SERVER, id: "forged", env: { GH_TOKEN: "" } }] }, anyProvider).ok).toBe(false);
  });

  it("replaces a value that is sent, and drops a key that is not", () => {
    const [github] = saveOk({ mcp_servers: [{ ...SERVER, env: { GH_TOKEN: "old", EXTRA: "x" } }] }).mcp_servers;
    saveOk({ mcp_servers: [{ ...github, env: { GH_TOKEN: "new" } }] });
    expect(getAssistantSettings().mcp_servers[0]).toEqual({ ...github, env: { GH_TOKEN: "new" } });
  });

  it("refuses a default provider that cannot run the Assistant", () => {
    expect(saveAssistantSettings({ default_provider: "cursor" }, (id) => id === "claude"))
      .toEqual({ ok: false, errors: ['"cursor" cannot run PPM Assistant sessions'] });
  });

  it("keeps the whole server list out of config dumps", () => {
    saveOk({ mcp_servers: [SERVER] });
    expect(JSON.stringify(redactSecretConfigValue("assistant", configService.get("assistant")))).not.toContain("ghp-secret");
  });
});

describe("/api/assistant/settings", () => {
  const app = new Hono().route("/api/assistant", assistantSettingsRoutes);

  it("never answers with a secret, on GET or PUT", async () => {
    saveOk({ mcp_servers: [SERVER] });
    const get = await (await app.request("/api/assistant/settings")).json() as any;
    expect(get.ok).toBe(true);
    expect(JSON.stringify(get)).not.toContain("ghp-secret");
    expect(get.data.limits.instructionsMaxChars).toBe(8000);

    const put = await app.request("/api/assistant/settings", {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...get.data.settings, instructions: "Be brief." }),
    });
    const body = await put.json() as any;
    expect(put.status).toBe(200);
    expect(JSON.stringify(body)).not.toContain("ghp-secret");
    expect(getAssistantSettings()).toMatchObject({ instructions: "Be brief.", mcp_servers: [{ env: { GH_TOKEN: "ghp-secret" } }] });
  });

  it("answers 400 with every problem found", async () => {
    const res = await app.request("/api/assistant/settings", {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mcp_servers: [{ ...SERVER, name: "ppm-assistant" }] }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).error).toContain("own tool server");
  });
});
