/**
 * `settings:changed {section}` goes out only after a 2xx write to an allowlisted settings route —
 * never for UI preferences (written on every sidebar drag), a provider probe, a read or a refused
 * write. Exercised through the real settings routers behind the middleware, the way
 * `src/server/index.ts` mounts them.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import "../../test-setup.ts";
import { Hono } from "hono";
import { openTestDb, setDb } from "../../../src/services/db.service.ts";
import { configService } from "../../../src/services/config.service.ts";
import { settingsRoutes } from "../../../src/server/routes/settings.ts";
import { settingsConfigKeyRoutes } from "../../../src/server/routes/settings-config-key.ts";
import { settingsProxyRoutes } from "../../../src/server/routes/settings-proxy.ts";
import { settingsThemesRoutes } from "../../../src/server/routes/settings-themes.ts";
import {
  ANNOUNCE_SETTINGS_ENV_KEY, announceSettingsChanges, settingsSectionOf, settingsSectionOfConfigKey,
} from "../../../src/server/routes/settings-broadcast.ts";
import { SETTINGS_EVENT_SECTIONS } from "../../../src/shared/settings-events.ts";

const announced: string[] = [];
const app = new Hono();
app.use("/api/settings/*", announceSettingsChanges);
app.route("/api/settings/themes", settingsThemesRoutes);
app.route("/api/settings", settingsRoutes);
app.route("/api/settings", settingsConfigKeyRoutes);
app.route("/api/settings", settingsProxyRoutes);

async function call(method: string, path: string, body?: unknown): Promise<number> {
  const res = await app.request(`/api/settings${path}`, {
    method,
    ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { "Content-Type": "application/json" } }),
  }, { [ANNOUNCE_SETTINGS_ENV_KEY]: (section: string) => announced.push(section) });
  return res.status;
}

let processConfig: unknown;
beforeAll(() => { processConfig = structuredClone((configService as any).config); });
afterAll(() => {
  setDb(openTestDb());
  (configService as any).config = processConfig;
});
beforeEach(() => {
  setDb(openTestDb());
  configService.load();
  announced.length = 0;
});

describe("settings:changed through the real routes", () => {
  it("announces a theme change once, with its section", async () => {
    expect(await call("PUT", "/theme", { style: "slate", mode: "dark" })).toBe(200);
    expect(announced).toEqual(["theme"]);
  });

  it("announces nothing for UI preferences, however often they are written", async () => {
    expect(await call("PUT", "/ui-prefs", { sidebarWidth: 300 })).toBe(200);
    expect(await call("PUT", "/ui-prefs", { tabWrap: true })).toBe(200);
    expect(announced).toEqual([]);
  });

  it("announces nothing for a read or a refused write", async () => {
    expect(await call("GET", "/theme")).toBe(200);
    expect(await call("GET", "/proxy")).toBe(200);
    expect(await call("PUT", "/theme", { style: "slate", mode: "sideways" })).toBe(400);
    expect(announced).toEqual([]);
  });

  it("announces keybindings, files, proxy and the AI settings under their own sections", async () => {
    expect(await call("PUT", "/keybindings", { "open-chat": "Mod+Shift+L" })).toBe(200);
    expect(await call("PATCH", "/files", { useIgnoreFiles: false })).toBe(200);
    expect(await call("PUT", "/proxy", { enabled: false })).toBe(200);
    expect(await call("PUT", "/ai", { share_provider_context: false })).toBe(200);
    expect(announced).toEqual(["keybindings", "files", "proxy", "ai"]);
  });

  it("announces a config-key write only for a key a settings pane shows", async () => {
    expect(await call("PUT", "/config-key", { key: "ai.share_provider_context", value: "false" })).toBe(200);
    expect(await call("PUT", "/config-key", { key: "device_name", value: "box" })).toBe(200);
    expect(announced).toEqual(["ai"]);
  });
});

describe("settingsSectionOf", () => {
  it("names no section for a provider probe, the provider status or UI preferences", () => {
    expect(settingsSectionOf("POST", "/api/settings/ai/providers/codex/probe")).toBeNull();
    expect(settingsSectionOf("GET", "/api/settings/ai/providers/status")).toBeNull();
    expect(settingsSectionOf("PUT", "/api/settings/ui-prefs")).toBeNull();
    expect(settingsSectionOf("PUT", "/api/settings/device-name")).toBeNull();
    expect(settingsSectionOf("PUT", "/api/settings/mcp/x")).toBeNull();
  });

  it("covers every section the event can name", () => {
    const writes: Array<[string, string]> = [
      ["PUT", "/theme"], ["POST", "/themes"], ["PATCH", "/themes/custom-1"], ["DELETE", "/themes/custom-1"],
      ["PUT", "/ai"], ["PUT", "/keybindings"], ["PUT", "/proxy"], ["PUT", "/query-audit"],
      ["DELETE", "/query-audit/logs"], ["PUT", "/session-trace"], ["PATCH", "/files"],
    ];
    const seen = new Set(writes.map(([m, p]) => settingsSectionOf(m, `/api/settings${p}`)));
    expect([...seen].sort()).toEqual([...SETTINGS_EVENT_SECTIONS].sort());
  });

  it("maps only the config keys a settings pane shows", () => {
    expect(settingsSectionOfConfigKey("ai.default_provider")).toBe("ai");
    expect(settingsSectionOfConfigKey("query_audit.retention_days")).toBe("query-audit");
    expect(settingsSectionOfConfigKey("session_trace.max_size_mb")).toBe("session-trace");
    expect(settingsSectionOfConfigKey("log_level")).toBeNull();
  });
});
