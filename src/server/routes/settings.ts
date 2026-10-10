import { Hono } from "hono";
import { configService, FILE_CONFIG_KEYS } from "../../services/config.service.ts";
import { getConfigValue, setConfigValue, listPairedChats, revokePairing, getPPMBotMemories, getDb } from "../../services/db.service.ts";
import {
  validateAIProviderConfig,
  validateCodexContextConfig,
  validateDefaultProvider,
  DEFAULT_CONFIG,
  type AIProviderConfig,
  type NewChatProviderMode,
  type TelegramConfig,
  type PPMBotConfig,
  type ThemeConfig,
} from "../../types/config.ts";
import { ok, err } from "../../types/api.ts";
import { isDbExplorerPrefs } from "../../shared/db-explorer-prefs.ts";
import { isLookupDescriptions } from "../../shared/db-lookup-prefs.ts";
import type { PPMBotTelegramStatus } from "../../shared/ppmbot-telegram.ts";
import { proxyService } from "../../services/proxy.service.ts";
import { clearIndexCache } from "../../services/file-list-index.service.ts";
import { providerRegistry, providerProbeStatuses, retryProviderProbe } from "../../providers/registry.ts";
import { createLogger } from "../../services/logger.ts";

const log = createLogger("settings");
const assistantTelegramLog = createLogger("assistant-telegram");

export const settingsRoutes = new Hono();

/** Strip api_key_env from all providers in an AI config object */
function stripSensitiveFields(ai: { providers: Record<string, unknown> }) {
  const clone = structuredClone(ai);
  for (const provider of Object.values(clone.providers)) {
    const p = provider as Record<string, unknown>;
    delete p.api_key_env;
    // Mask api_key: show only that it's set, not the value
    if (p.api_key && typeof p.api_key === "string" && p.api_key.length > 0) {
      p.api_key = "••••" + (p.api_key as string).slice(-4);
    }
  }
  return clone;
}

// ── Device Name ──────────────────────────────────────────────────────

/** PUT /settings/device-name */
settingsRoutes.put("/device-name", async (c) => {
  try {
    const { device_name } = await c.req.json<{ device_name: string }>();
    if (typeof device_name !== "string") {
      return c.json(err("device_name must be a string"), 400);
    }
    const trimmed = device_name.trim();
    if (trimmed.length > 100) {
      return c.json(err("device_name must be 100 characters or less"), 400);
    }

    // Save to config
    configService.set("device_name", trimmed);
    configService.save();

    // Update cloud device name if linked
    let cloud_synced = false;
    let cloud_error: string | undefined;
    try {
      const { getCloudDevice, saveCloudDevice, linkDevice } = await import("../../services/cloud.service.ts");
      const device = getCloudDevice();
      if (device && trimmed) {
        // Re-link with new name (cloud upserts by machine_id)
        const updated = await linkDevice(trimmed);
        // Also update local cloud-device.json name
        if (updated) {
          saveCloudDevice({ ...updated, name: trimmed });
          cloud_synced = true;
        }
      }
    } catch (e) {
      cloud_error = (e as Error).message;
      // The response is a 200 that carries the error, so this is the only place it is recorded.
      log.warn(`Device name saved, cloud sync failed: ${cloud_error.slice(0, 200)}`);
    }

    return c.json(ok({ device_name: trimmed, cloud_synced, cloud_error }));
  } catch (e) {
    return c.json(err((e as Error).message), 400);
  }
});

// ── Theme ─────────────────────────────────────────────────────────────

/** GET /settings/theme — returns the {style, mode, customThemeId?} object */
settingsRoutes.get("/theme", (c) => {
  const theme = configService.get("theme") ?? { style: "aurora", mode: "system" };
  return c.json(ok({ theme }));
});

/** PUT /settings/theme — accepts {style, mode, customThemeId?} (legacy string body removed) */
settingsRoutes.put("/theme", async (c) => {
  try {
    const body = await c.req.json<Partial<ThemeConfig>>();
    if (typeof body.style !== "string" || !body.style.trim()) {
      return c.json(err("style must be a non-empty string"), 400);
    }
    if (!["light", "dark", "system"].includes(body.mode as string)) {
      return c.json(err("mode must be light, dark, or system"), 400);
    }
    const theme: ThemeConfig = { style: body.style, mode: body.mode as ThemeConfig["mode"] };
    if (typeof body.customThemeId === "string") theme.customThemeId = body.customThemeId;
    configService.set("theme", theme);
    configService.save();
    return c.json(ok({ theme }));
  } catch (e) {
    return c.json(err((e as Error).message), 400);
  }
});

// ── UI Preferences ────────────────────────────────────────────────────
// Device-agnostic UI prefs stored server-side so they survive origin changes
// (e.g. switching tunnel URL wipes localStorage, which is origin-scoped).

const UI_PREFS_KEY = "ui_prefs";

/** Whitelisted UI pref keys with their validators */
const UI_PREF_VALIDATORS: Record<string, (v: unknown) => boolean> = {
  wordWrap: (v) => typeof v === "boolean",
  inlineBlame: (v) => typeof v === "boolean",
  designWindows: (v) => typeof v === "boolean",
  tabWrap: (v) => typeof v === "boolean",
  sidebarCollapsed: (v) => typeof v === "boolean",
  remoteDesktopStatsVisible: (v) => typeof v === "boolean",
  remoteDesktopWarningDismissed: (v) => typeof v === "boolean",
  // MCP servers the user hid from the chat's sign-in bar (by name)
  mcpSignInDismissed: (v) => Array.isArray(v) && v.length <= 200 && v.every((s) => typeof s === "string" && s.length <= 200),
  keepScreenAwake: (v) => typeof v === "boolean",
  sidebarWidth: (v) => typeof v === "number" && v >= 200 && v <= 600,
  gitStatusViewMode: (v) => v === "flat" || v === "tree",
  editorTabStyle: (v) => v === "default" || v === "boxed" || v === "pill",
  sidebarActiveTab: (v) => typeof v === "string",
  sidebarTabOrder: (v) => Array.isArray(v) && v.length <= 50 && v.every((t) => typeof t === "string"),
  jiraEnabled: (v) => typeof v === "boolean",
  // Database sidebar tree: open connections, expanded nodes, empty folders (see db-explorer-prefs)
  dbExplorer: isDbExplorerPrefs,
  // ⋯ Lookup in a table's filter row: the column that describes a row, per table (see db-lookup-prefs)
  dbLookupDescriptions: isLookupDescriptions,
  // OS Explorer window chrome override — "auto" follows the host platform
  explorerSkin: (v) => v === "auto" || v === "windows" || v === "macos",
  // Project switcher prefs
  projectSortMode: (v) => v === "recent" || v === "priority" || v === "name",
  recentOpen: (v) =>
    typeof v === "object" && v !== null && !Array.isArray(v) &&
    Object.values(v as Record<string, unknown>).every((t) => typeof t === "number"),
};

/** GET /settings/ui-prefs — return stored UI preferences */
settingsRoutes.get("/ui-prefs", (c) => {
  const raw = getConfigValue(UI_PREFS_KEY);
  const prefs: Record<string, unknown> = raw ? JSON.parse(raw) : {};
  return c.json(ok(prefs));
});

/** PUT /settings/ui-prefs — merge-patch UI preferences (only whitelisted keys) */
settingsRoutes.put("/ui-prefs", async (c) => {
  try {
    const body = await c.req.json<Record<string, unknown>>();
    const raw = getConfigValue(UI_PREFS_KEY);
    const current: Record<string, unknown> = raw ? JSON.parse(raw) : {};
    for (const [key, value] of Object.entries(body)) {
      const validate = UI_PREF_VALIDATORS[key];
      if (!validate) continue; // ignore unknown keys
      if (!validate(value)) return c.json(err(`Invalid value for "${key}"`), 400);
      current[key] = value;
    }
    setConfigValue(UI_PREFS_KEY, JSON.stringify(current));
    return c.json(ok(current));
  } catch (e) {
    return c.json(err((e as Error).message), 400);
  }
});

// ── AI ────────────────────────────────────────────────────────────────

/** GET /settings/ai — return current AI config (strips api_key_env) */
settingsRoutes.get("/ai", (c) => {
  const ai = configService.get("ai");
  return c.json(ok(stripSensitiveFields(ai)));
});

/** PUT /settings/ai — update AI settings, persists to SQLite */
settingsRoutes.put("/ai", async (c) => {
  try {
    const body = await c.req.json<{
      default_provider?: string;
      new_chat_provider_mode?: NewChatProviderMode;
      share_provider_context?: boolean;
      tab_tools?: boolean;
      providers?: Record<string, Partial<AIProviderConfig>>;
    }>();

    const currentAi = configService.get("ai");

    if ("new_chat_provider_mode" in body && body.new_chat_provider_mode !== "default" && body.new_chat_provider_mode !== "follow-focus") {
      return c.json(err("new_chat_provider_mode must be one of: default, follow-focus"), 400);
    }
    if ("default_provider" in body && (typeof body.default_provider !== "string" || !body.default_provider)) {
      return c.json(err("default_provider must be a non-empty string"), 400);
    }

    if ("share_provider_context" in body && typeof body.share_provider_context !== "boolean") {
      return c.json(err("share_provider_context must be a boolean"), 400);
    }
    if ("tab_tools" in body && typeof body.tab_tools !== "boolean") {
      return c.json(err("tab_tools must be a boolean"), 400);
    }

    // Validate each provider config
    if (body.providers) {
      for (const [name, providerConfig] of Object.entries(body.providers)) {
        // Field-only updates still need the saved provider kind and CLI command.
        // Validate submitted values without revalidating unrelated legacy settings.
        const existing = currentAi.providers[name];
        const errors = validateAIProviderConfig({
          type: existing?.type,
          cli_command: existing?.cli_command,
          ...providerConfig,
        });
        if (errors.length > 0) {
          return c.json(err(`Provider "${name}": ${errors.join(", ")}`), 400);
        }
      }
    }

    // Merge: body overrides current values (shallow merge per provider)
    const updated = {
      ...currentAi,
      new_chat_provider_mode: body.new_chat_provider_mode ?? currentAi.new_chat_provider_mode ?? "default",
      share_provider_context: body.share_provider_context ?? currentAi.share_provider_context ?? true,
      ...(typeof body.tab_tools === "boolean" && { tab_tools: body.tab_tools }),
      ...(body.default_provider && { default_provider: body.default_provider }),
    };
    if (body.providers) {
      updated.providers = { ...currentAi.providers };
      for (const [name, config] of Object.entries(body.providers)) {
        // Don't overwrite api_key with the masked value from UI
        if (config.api_key && config.api_key.startsWith("••••")) {
          delete config.api_key;
        }
        updated.providers[name] = {
          ...currentAi.providers[name],
          ...config,
        } as AIProviderConfig;
        for (const key of ["model_context_window", "model_auto_compact_token_limit"] as const) {
          if (updated.providers[name]![key] === null) delete updated.providers[name]![key];
        }
        const contextErrors = validateCodexContextConfig(updated.providers[name]!);
        if (contextErrors.length) {
          return c.json(err(`Provider "${name}": ${contextErrors.join(", ")}`), 400);
        }
      }
    }

    // Configured providers include runtime integrations such as Codex.
    if (body.default_provider) {
      const dpErr = validateDefaultProvider(updated.default_provider, updated.providers);
      if (dpErr) return c.json(err(dpErr), 400);
    }

    configService.set("ai", updated);
    configService.save();

    return c.json(ok(stripSensitiveFields(updated)));
  } catch (e) {
    return c.json(err((e as Error).message), 400);
  }
});

/**
 * GET /settings/ai/providers/status — which CLI providers registered, and why one did not.
 *
 * Settings builds its provider tabs from config, which keeps a codex entry
 * forever once it has been written — so the tab is there while chat offers no
 * Codex at all. This is what lets that tab say which of the two it is.
 */
settingsRoutes.get("/ai/providers/status", (c) => c.json(ok(providerProbeStatuses())));

/** POST /settings/ai/providers/:id/probe — probe now, ahead of the backoff */
settingsRoutes.post("/ai/providers/:id/probe", async (c) => {
  try {
    return c.json(ok(await retryProviderProbe(c.req.param("id"))));
  } catch (e) {
    return c.json(err((e as Error).message), 400);
  }
});

/** GET /settings/ai/providers/:id/models — list models for a provider (global, no project context needed) */
settingsRoutes.get("/ai/providers/:id/models", async (c) => {
  try {
    const id = c.req.param("id");
    const provider = providerRegistry.get(id);
    if (!provider) return c.json(err(`Provider "${id}" not found`), 404);
    const models = await provider.listModels?.() ?? [];
    return c.json(ok(models));
  } catch (e) {
    return c.json(err((e as Error).message), 500);
  }
});

// ── Keybindings ──────────────────────────────────────────────────────

const KEYBINDINGS_KEY = "keybindings";

/** GET /settings/keybindings — return user overrides (partial) */
settingsRoutes.get("/keybindings", (c) => {
  const raw = getConfigValue(KEYBINDINGS_KEY);
  const overrides: Record<string, string> = raw ? JSON.parse(raw) : {};
  return c.json(ok(overrides));
});

/** PUT /settings/keybindings — save user overrides (partial, only changed keys) */
settingsRoutes.put("/keybindings", async (c) => {
  try {
    const body = await c.req.json<Record<string, string | null>>();
    // Merge with existing overrides
    const raw = getConfigValue(KEYBINDINGS_KEY);
    const current: Record<string, string> = raw ? JSON.parse(raw) : {};
    for (const [actionId, combo] of Object.entries(body)) {
      if (combo === null) {
        delete current[actionId]; // reset to default
      } else {
        current[actionId] = combo;
      }
    }
    setConfigValue(KEYBINDINGS_KEY, JSON.stringify(current));
    return c.json(ok(current));
  } catch (e) {
    return c.json(err((e as Error).message), 400);
  }
});

// ── Telegram ───────────────────────────────────────────────────────
// Two bots: `/telegram` is the one Notifications send through, `/clawbot/telegram` (below)
// is PPMBot's. See `services/telegram-bots.ts`.

/** The bot a PUT asked for, checked with Telegram (getMe) before it is kept. An empty token removes the bot. */
async function checkedBot(
  requested: string | undefined,
  current: TelegramConfig,
): Promise<{ bot: TelegramConfig } | { error: string; status: 400 | 502 }> {
  const token = (requested ?? current.bot_token).trim();
  if (!token) return { bot: { bot_token: "" } };
  const { getBotIdentity } = await import("../../services/telegram-bot-api.ts");
  const identity = await getBotIdentity(token);
  if (!identity.ok) return { error: identity.message, status: identity.reason === "invalid" ? 400 : 502 };
  return { bot: { bot_token: token, bot_username: identity.username } };
}

/** A bot as the browser may see it: the token is a password for the bot, so only its start. */
function maskedBot(bot: TelegramConfig | undefined) {
  return {
    bot_token: bot?.bot_token ? `${bot.bot_token.slice(0, 6)}...` : "",
    bot_username: bot?.bot_token ? bot.bot_username ?? null : null,
  };
}

/** GET /settings/telegram — the notification bot (masks bot_token) */
settingsRoutes.get("/telegram", (c) => {
  return c.json(ok(maskedBot(configService.get("telegram") as TelegramConfig | undefined)));
});

/**
 * PUT /settings/telegram — save the notification bot's token.
 *
 * Telegram is asked whether the token is real before it is kept: a mistyped one used to
 * save as "(saved)" and then fail in silence.
 */
settingsRoutes.put("/telegram", async (c) => {
  try {
    const body = await c.req.json<{ bot_token?: string }>();
    const current = (configService.get("telegram") as TelegramConfig | undefined) ?? { bot_token: "" };
    const checked = await checkedBot(body.bot_token, current);
    if ("error" in checked) return c.json(err(checked.error), checked.status);
    configService.set("telegram", checked.bot);
    configService.save();
    if (checked.bot.bot_token !== current.bot_token) {
      // An open connect link names the old bot.
      const { notifyConnect } = await import("../../services/telegram-connect.service.ts");
      notifyConnect.cancel();
    }
    return c.json(ok(maskedBot(checked.bot)));
  } catch (e) {
    return c.json(err((e as Error).message), 400);
  }
});

/** POST /settings/telegram/test — send a test notification to every connected chat */
settingsRoutes.post("/telegram/test", async (c) => {
  try {
    const current = (configService.get("telegram") as TelegramConfig | undefined) ?? { bot_token: "" };
    const token = current.bot_token;
    if (!token) {
      return c.json(err("Bot token not configured"), 400);
    }
    const { telegramService } = await import("../../services/telegram-notification.service.ts");
    const result = await telegramService.sendTest(token);
    if (!result.ok) return c.json(err(result.error ?? "Failed"), 500);
    return c.json(ok({ sent: true }));
  } catch (e) {
    return c.json(err((e as Error).message), 500);
  }
});

// ── Auth / Password ──────────────────────────────────────────────────

/** PUT /settings/auth/password — change the access password (token) */
settingsRoutes.put("/auth/password", async (c) => {
  try {
    const { password, confirm } = await c.req.json<{ password: string; confirm: string }>();
    if (typeof password !== "string" || !password.trim()) {
      return c.json(err("Password is required"), 400);
    }
    if (password !== confirm) {
      return c.json(err("Passwords do not match"), 400);
    }
    const trimmed = password.trim();
    if (trimmed.length < 4) {
      return c.json(err("Password must be at least 4 characters"), 400);
    }

    const auth = configService.get("auth");
    configService.set("auth", { ...auth, token: trimmed });
    configService.save();
    // Every other signed-in client has to sign in again. Never the value, nor its length.
    log.info("Access password changed");

    return c.json(ok({ token: trimmed }));
  } catch (e) {
    return c.json(err((e as Error).message), 400);
  }
});

// ── Proxy ────────────────────────────────────────────────────────────

/** Build proxy settings response with correct local/tunnel endpoints */
async function buildProxyResponse() {
  const { tunnelService } = await import("../../services/tunnel.service.ts");
  const tunnelUrl = tunnelService.getTunnelUrl();
  const port = configService.get("port");
  const localOrigin = `http://localhost:${port}`;
  return {
    enabled: proxyService.isEnabled(),
    authKey: proxyService.getAuthKey() ?? null,
    requestCount: proxyService.getRequestCount(),
    localEndpoint: `${localOrigin}/proxy/v1/messages`,
    localOpenAiEndpoint: `${localOrigin}/proxy/v1/chat/completions`,
    tunnelUrl: tunnelUrl ?? null,
    proxyEndpoint: tunnelUrl ? `${tunnelUrl}/proxy/v1/messages` : null,
    openAiEndpoint: tunnelUrl ? `${tunnelUrl}/proxy/v1/chat/completions` : null,
  };
}

/** GET /settings/proxy — proxy status */
settingsRoutes.get("/proxy", async (c) => {
  return c.json(ok(await buildProxyResponse()));
});

/** PUT /settings/proxy — update proxy settings */
settingsRoutes.put("/proxy", async (c) => {
  try {
    const body = await c.req.json<{ enabled?: boolean; authKey?: string; generateKey?: boolean }>();
    if (body.enabled !== undefined) proxyService.setEnabled(body.enabled);
    if (body.generateKey) proxyService.generateAuthKey();
    else if (body.authKey !== undefined) proxyService.setAuthKey(body.authKey);
    return c.json(ok(await buildProxyResponse()));
  } catch (e) {
    return c.json(err((e as Error).message), 400);
  }
});

// ── Query audit log ────────────────────────────────────────────

/** Config plus what the log currently costs on disk, so the UI can show both together. */
async function buildQueryAuditResponse() {
  const { existsSync } = await import("node:fs");
  const config = configService.get("query_audit") ?? DEFAULT_CONFIG.query_audit;
  const { getAuditDbPath, getAuditDbSizeBytes } = await import("../../services/query-audit/query-audit-db.ts");

  if (!existsSync(getAuditDbPath())) {
    return { ...config, size_bytes: 0, entry_count: 0 };
  }

  const { countQueryLogs } = await import("../../services/query-audit/query-audit.service.ts");
  return { ...config, size_bytes: getAuditDbSizeBytes(), entry_count: countQueryLogs() };
}

/** GET /settings/query-audit */
settingsRoutes.get("/query-audit", async (c) => {
  try {
    return c.json(ok(await buildQueryAuditResponse()));
  } catch (e) {
    return c.json(err((e as Error).message), 500);
  }
});

/** PUT /settings/query-audit — body: { retention_days?, max_size_mb? } */
settingsRoutes.put("/query-audit", async (c) => {
  try {
    const body = await c.req.json<{ retention_days?: number; max_size_mb?: number }>();
    const current = configService.get("query_audit") ?? DEFAULT_CONFIG.query_audit;

    const retention_days = body.retention_days ?? current.retention_days;
    const max_size_mb = body.max_size_mb ?? current.max_size_mb;

    if (!Number.isInteger(retention_days) || retention_days < 1) {
      return c.json(err("retention_days must be a whole number of at least 1"), 400);
    }
    // Below ~10MB a single burst of large results would wipe the log immediately.
    if (!Number.isInteger(max_size_mb) || max_size_mb < 10) {
      return c.json(err("max_size_mb must be a whole number of at least 10"), 400);
    }

    configService.set("query_audit", { retention_days, max_size_mb });
    configService.save();
    return c.json(ok(await buildQueryAuditResponse()));
  } catch (e) {
    return c.json(err((e as Error).message), 400);
  }
});

/** DELETE /settings/query-audit/logs — wipe every recorded statement */
settingsRoutes.delete("/query-audit/logs", async (c) => {
  try {
    const { existsSync } = await import("node:fs");
    const { getAuditDbPath } = await import("../../services/query-audit/query-audit-db.ts");
    if (!existsSync(getAuditDbPath())) return c.json(ok({ deleted: 0 }));

    const { clearQueryAudit } = await import("../../services/query-audit/query-audit-cleanup.ts");
    return c.json(ok({ deleted: clearQueryAudit() }));
  } catch (e) {
    return c.json(err((e as Error).message), 500);
  }
});

// ── PPM Assistant on Telegram (kept under PPMBot's `clawbot` key and routes) ──

/** The three settings the bridge reads, whatever else an old PPMBot row still holds. */
const CLAWBOT_KEYS = ["enabled", "show_tool_calls", "debounce_ms"] as const;

/** GET /settings/clawbot — `{ enabled, show_tool_calls, debounce_ms }` */
settingsRoutes.get("/clawbot", async (c) => {
  const { assistantTelegramConfig } = await import("../../services/assistant-telegram/assistant-telegram.service.ts");
  return c.json(ok(assistantTelegramConfig()));
});

/**
 * PUT /settings/clawbot — any of the three settings. PPMBot's other fields (provider, permission
 * mode, thinking, system prompt) are ignored rather than refused, so an older page still saves.
 * Switching `enabled` starts or stops the bridge.
 */
settingsRoutes.put("/clawbot", async (c) => {
  let body: Record<string, unknown>;
  try {
    body = await c.req.json();
  } catch {
    return c.json(err("Body must be JSON"), 400);
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) return c.json(err("Body must be an object"), 400);
  for (const key of ["enabled", "show_tool_calls"] as const) {
    if (body[key] !== undefined && typeof body[key] !== "boolean") return c.json(err(`${key} must be true or false`), 400);
  }
  const debounce = body.debounce_ms;
  if (debounce !== undefined && (typeof debounce !== "number" || !Number.isInteger(debounce) || debounce < 0 || debounce > 30000)) {
    return c.json(err("debounce_ms must be a whole number from 0 to 30000"), 400);
  }
  try {
    const { assistantTelegramConfig } = await import("../../services/assistant-telegram/assistant-telegram.service.ts");
    const { migratePPMBotSettings } = await import("../../services/assistant-telegram/ppmbot-migration.ts");
    // An old row's system prompt is carried over before the row is rewritten without it.
    migratePPMBotSettings();
    const updated: PPMBotConfig = { ...assistantTelegramConfig() };
    for (const key of CLAWBOT_KEYS) if (body[key] !== undefined) (updated as unknown as Record<string, unknown>)[key] = body[key];
    configService.set("clawbot", updated);

    const { syncAssistantTelegram } = await import("../../services/assistant-hub/assistant-hub-startup.ts");
    await syncAssistantTelegram();
    return c.json(ok(updated));
  } catch (e) {
    return c.json(err((e as Error).message), 500);
  }
});

/** GET /settings/clawbot/paired — list paired devices */
settingsRoutes.get("/clawbot/paired", (c) => {
  return c.json(ok(listPairedChats()));
});

/**
 * DELETE /settings/clawbot/paired/:chatId — revoke a chat. The bridge forgets it in the same
 * request (its binding, and anything queued for it), so not one more message reaches it.
 */
settingsRoutes.delete("/clawbot/paired/:chatId", async (c) => {
  const chatId = c.req.param("chatId");
  if (!/^-?\d{1,20}$/.test(chatId)) return c.json(err("Not a Telegram chat id"), 400);
  revokePairing(chatId);
  try {
    const { assistantTelegramBridge } = await import("../../services/assistant-telegram/assistant-telegram.service.ts");
    assistantTelegramBridge.forgetChat(chatId);
  } catch (e) {
    // Revoked all the same: every send checks the connection before it goes.
    assistantTelegramLog.warn(`Telegram chat ${chatId} revoked, but the bridge could not forget it: ${(e as Error).message}`);
  }
  return c.json(ok({ revoked: true }));
});

// ── PPM Assistant's Telegram bot ───────────────────────────────

/** GET /settings/clawbot/telegram — the Assistant's bot, the chats that may use it, and an open connect link */
settingsRoutes.get("/clawbot/telegram", async (c) => {
  const { getPPMBotBot, sameBot } = await import("../../services/telegram-bots.ts");
  const { ppmbotConnect } = await import("../../services/telegram-connect.service.ts");
  const { assistantTelegramBridge, assistantTelegramConfig } = await import("../../services/assistant-telegram/assistant-telegram.service.ts");
  const bot = getPPMBotBot();
  const notifyToken = (configService.get("telegram") as TelegramConfig | undefined)?.bot_token ?? "";
  const rows = listPairedChats();
  const nameOf = (row: (typeof rows)[number]) => row.display_name || `Chat ${row.telegram_chat_id}`;
  const status: PPMBotTelegramStatus = {
    configured: !!bot.bot_token,
    // Tokens saved before PPM stored the bot's name get it now, the first time it is needed.
    botUsername: bot.bot_token ? bot.bot_username ?? await ppmbotConnect.botUsername().catch(() => null) : null,
    sharedWithNotifications: !!bot.bot_token && sameBot(bot.bot_token, notifyToken),
    enabled: assistantTelegramConfig().enabled,
    running: assistantTelegramBridge.running,
    chats: rows.filter((row) => row.status === "approved").map((row) => ({ chatId: row.telegram_chat_id, name: nameOf(row) })),
    connect: ppmbotConnect.status(),
  };
  return c.json(ok(status));
});

/** PUT /settings/clawbot/telegram — the Assistant's bot token, checked with Telegram first. An empty token removes the bot. */
settingsRoutes.put("/clawbot/telegram", async (c) => {
  try {
    const body = await c.req.json<{ bot_token?: string }>();
    const { getPPMBotBot, setPPMBotBot } = await import("../../services/telegram-bots.ts");
    const current = getPPMBotBot();
    const checked = await checkedBot(body.bot_token, current);
    if ("error" in checked) return c.json(err(checked.error), checked.status);
    setPPMBotBot(checked.bot);

    if (checked.bot.bot_token !== current.bot_token) {
      // An open connect link names the old bot.
      const { ppmbotConnect } = await import("../../services/telegram-connect.service.ts");
      ppmbotConnect.cancel();
      // The bridge reads with the token it started with: restarted, it reads the new bot (or,
      // with the token removed, stops). Failures are logged; the token is saved either way.
      const { syncAssistantTelegram } = await import("../../services/assistant-hub/assistant-hub-startup.ts");
      await syncAssistantTelegram({ restart: true });
    }
    return c.json(ok(maskedBot(checked.bot)));
  } catch (e) {
    return c.json(err((e as Error).message), 400);
  }
});

/** POST /settings/clawbot/telegram/connect — a one-time link that lets the chat opening it use the Assistant */
settingsRoutes.post("/clawbot/telegram/connect", async (c) => {
  const { ppmbotConnect, TelegramConnectError } = await import("../../services/telegram-connect.service.ts");
  try {
    return c.json(ok(await ppmbotConnect.start()));
  } catch (e) {
    if (e instanceof TelegramConnectError) return c.json(err(e.message), e.status);
    throw e;
  }
});

/** DELETE /settings/clawbot/telegram/connect — withdraw the open link */
settingsRoutes.delete("/clawbot/telegram/connect", async (c) => {
  const { ppmbotConnect } = await import("../../services/telegram-connect.service.ts");
  ppmbotConnect.cancel();
  return c.json(ok({ cancelled: true }));
});

/** GET /settings/clawbot/memories?project=xxx — list memories for a project */
settingsRoutes.get("/clawbot/memories", (c) => {
  const project = c.req.query("project") || "_global";
  const memories = getPPMBotMemories(project, 50);
  return c.json(ok(memories));
});

/** DELETE /settings/clawbot/memories/:id — delete a specific memory */
settingsRoutes.delete("/clawbot/memories/:id", (c) => {
  const id = Number(c.req.param("id"));
  if (!id) return c.json(err("Invalid memory ID"), 400);
  try {
    getDb().query("DELETE FROM clawbot_memories WHERE id = ?").run(id);
    return c.json(ok({ deleted: id }));
  } catch (e) {
    return c.json(err((e as Error).message), 500);
  }
});

// ── File Filters ──────────────────────────────────────────────────────────────

/** GET /settings/files — return global file filter config */
settingsRoutes.get("/files", (c) => {
  return c.json(ok({
    filesExclude: configService.getFilesExclude(),
    searchExclude: configService.getSearchExclude(),
    useIgnoreFiles: configService.getUseIgnoreFiles(),
  }));
});

/** PATCH /settings/files — partial update to global file filter config */
settingsRoutes.patch("/files", async (c) => {
  try {
    const body = await c.req.json<{
      filesExclude?: string[];
      searchExclude?: string[];
      useIgnoreFiles?: boolean;
    }>();

    if (body.filesExclude !== undefined) {
      if (!Array.isArray(body.filesExclude)) return c.json(err("filesExclude must be an array"), 400);
      const patterns = body.filesExclude.filter((p) => typeof p === "string").slice(0, 200);
      setConfigValue(FILE_CONFIG_KEYS.filesExclude, JSON.stringify(patterns));
    }
    if (body.searchExclude !== undefined) {
      if (!Array.isArray(body.searchExclude)) return c.json(err("searchExclude must be an array"), 400);
      const patterns = body.searchExclude.filter((p) => typeof p === "string").slice(0, 200);
      setConfigValue(FILE_CONFIG_KEYS.searchExclude, JSON.stringify(patterns));
    }
    if (body.useIgnoreFiles !== undefined) {
      if (typeof body.useIgnoreFiles !== "boolean") return c.json(err("useIgnoreFiles must be a boolean"), 400);
      setConfigValue(FILE_CONFIG_KEYS.useIgnoreFiles, JSON.stringify(body.useIgnoreFiles));
    }

    // Invalidate all project index caches — global filter changes affect every project
    clearIndexCache();

    return c.json(ok({
      filesExclude: configService.getFilesExclude(),
      searchExclude: configService.getSearchExclude(),
      useIgnoreFiles: configService.getUseIgnoreFiles(),
    }));
  } catch (e) {
    return c.json(err((e as Error).message), 400);
  }
});

/** GET /settings/clawbot/tasks — list recent delegated tasks */
settingsRoutes.get("/clawbot/tasks", (c) => {
  const limit = Number(c.req.query("limit")) || 20;
  try {
    const rows = getDb().query(
      "SELECT * FROM bot_tasks ORDER BY created_at DESC LIMIT ?",
    ).all(limit);
    return c.json(ok(rows));
  } catch (e) {
    // Answered as an empty list, so the failure is recorded nowhere else.
    log.error("Bot task list failed:", e);
    return c.json(ok([]));
  }
});
