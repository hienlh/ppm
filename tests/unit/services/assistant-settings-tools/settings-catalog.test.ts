/**
 * The settings catalog's promises: it covers every Settings category in the rail, never offers a
 * secret, puts every permission/security setting behind a card, checks values strictly, and only
 * ever writes through routes the settings family may reach.
 */
import { describe, expect, it } from "bun:test";
import "../../../test-setup.ts";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { allSettings, coveredCategories, lookupSetting } from "../../../../src/services/assistant-settings-tools/settings-catalog.ts";
import { checkValue, enumValues, type SettingEntry } from "../../../../src/services/assistant-settings-tools/settings-catalog-types.ts";
import { SETTINGS_ROUTES, isSettingsFamilyPath, CONFIG_KEY_WRITES } from "../../../../src/services/assistant-settings-tools/settings-tool-routes.ts";
import { checkRouteCall, ruleProblem } from "../../../../src/services/assistant-mcp/assistant-route-call.ts";
import { SECRET_CONFIG_KEYS } from "../../../../src/services/config-secret-keys.ts";
import { hardLimitReason } from "../../../../src/services/assistant/assistant-full-mode.ts";

const RAIL = readFileSync(resolve(import.meta.dir, "../../../../src/web/components/settings/settings-categories.ts"), "utf8");
const CATEGORY_IDS = [...RAIL.matchAll(/\{ id: "([a-z-]+)", group: "/g)].map((m) => m[1]!);

function sample(entry: SettingEntry): unknown {
  const v = entry.value;
  switch (v.type) {
    case "boolean": return true;
    case "enum": return enumValues(v)[0];
    case "int": return v.min;
    case "time": return "08:00";
    case "text": return "x";
    case "string_list": return ["a"];
    case "id_list": return [1];
  }
}

describe("coverage", () => {
  it("reads the rail", () => expect(CATEGORY_IDS.length).toBeGreaterThan(15));
  it("covers every Settings category: a setting, a refusal or a stated reason", () => {
    const covered = coveredCategories();
    expect(CATEGORY_IDS.filter((id) => !covered.has(id))).toEqual([]);
  });
  it("names only real categories", () => {
    expect([...coveredCategories()].filter((c) => !CATEGORY_IDS.includes(c))).toEqual([]);
  });
  it("has unique keys", () => {
    const keys = allSettings().map((e) => e.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe("secrets", () => {
  it("refuses every secret config key, whatever provider it names", () => {
    for (const pattern of SECRET_CONFIG_KEYS) {
      const key = pattern.replace("*", "claude");
      expect(lookupSetting(key).kind).toBe("refused");
    }
  });
  it("offers no setting whose key or label is a token, key or password", () => {
    const leaks = allSettings().filter((e) => /token|api_key|password|secret|mcp_servers/i.test(e.key));
    expect(leaks.map((e) => e.key)).toEqual([]);
  });
});

describe("tiers", () => {
  const card = (key: string) => (lookupSetting(key) as { kind: string; entry?: SettingEntry }).entry?.tier;
  it("puts security, permissions, trusted text, accounts and the Telegram bridge behind a card", () => {
    for (const key of [
      "auth.enabled", "assistant.permission_mode", "assistant.act_on_own", "assistant.auto_readonly_commands",
      "assistant.db_write_connections", "assistant.instructions", "assistant.persona.name", "assistant.persona.soul",
      "assistant.manager_template", "assistant.manager_default_mode", "assistant.telegram.enabled", "accounts.strategy",
      "design.instructions", "ai.ppm_tools.open_file", "ai.providers.claude.permission_mode",
      "session_trace.retention_days", "session_trace.max_size_mb", "query_audit.retention_days", "query_audit.max_size_mb",
    ]) expect([key, card(key)]).toEqual([key, "card"]);
  });
  it("changes the everyday ones directly", () => {
    for (const key of ["voice.enabled", "voice.cleanup_enabled", "theme.mode", "notifications.delay_seconds", "assistant.quiet_hours.start", "log_level", "files.exclude"]) {
      expect([key, card(key)]).toEqual([key, "direct"]);
    }
  });
  it("Full mode honours a tool's always-ask reason", () => {
    expect(hardLimitReason({ tool: "settings_set", input: {}, alwaysAsk: "It changes permissions" }, new Set())).toBe("It changes permissions");
    expect(hardLimitReason({ tool: "settings_set", input: {} }, new Set())).toBeNull();
  });
});

describe("values", () => {
  const entry = (key: string) => (lookupSetting(key) as { entry: SettingEntry }).entry;
  it("checks types strictly", () => {
    expect(checkValue(entry("voice.enabled"), "true").ok).toBe(false);
    expect(checkValue(entry("theme.mode"), "purple").ok).toBe(false);
    expect(checkValue(entry("notifications.delay_seconds"), 99999).ok).toBe(false);
    expect(checkValue(entry("assistant.quiet_hours.start"), "25:00").ok).toBe(false);
    expect(checkValue(entry("device_name"), "a\nb").ok).toBe(false);
    expect(checkValue(entry("files.exclude"), [" a ", "a", ""])).toEqual({ ok: true, value: ["a"] });
  });
});

describe("routes", () => {
  it("every rule is one the caller can enforce", () => {
    for (const rule of SETTINGS_ROUTES) expect([rule.path, ruleProblem(rule)]).toEqual([rule.path, null]);
  });
  it("every catalog write is a call the family's allowlist and gate accept", async () => {
    for (const entry of allSettings()) {
      const value = sample(entry);
      const c = await entry.write(value);
      const body = c.method === "DELETE" ? undefined : c.body;
      const checked = checkRouteCall(SETTINGS_ROUTES, c.method, c.path, body, () => null);
      expect([entry.key, checked.ok]).toEqual([entry.key, true]);
      expect([entry.key, isSettingsFamilyPath(c.path)]).toEqual([entry.key, true]);
      if (c.path === "/api/settings/config-key") expect(CONFIG_KEY_WRITES.has(String(c.body.key))).toBe(true);
    }
  });
  it("the gate refuses everything else of those routers", () => {
    for (const path of ["/api/settings/auth/password", "/api/settings/ui-prefs", "/api/settings/keybindings", "/api/settings/mcp", "/api/accounts/export", "/api/speech/transcribe", "/api/db/drivers", "/api/db/connections/export"]) {
      expect([path, isSettingsFamilyPath(path)]).toEqual([path, false]);
    }
    expect(isSettingsFamilyPath("/api/db/drivers/mysql/install")).toBe(true);
  });
});
