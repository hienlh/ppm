import { Hono } from "hono";
import { configService } from "../../services/config.service.ts";
import { getConfigValue, setConfigValue } from "../../services/db.service.ts";
import {
  validateAIProviderConfig,
  validateDefaultProvider,
  VALID_PROVIDERS,
  type AIProviderConfig,
  type TelegramConfig,
  type ThemeConfig,
} from "../../types/config.ts";
import { ok, err } from "../../types/api.ts";
import { proxyService } from "../../services/proxy.service.ts";

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
    try {
      const { getCloudDevice, saveCloudDevice, linkDevice } = await import("../../services/cloud.service.ts");
      const device = getCloudDevice();
      if (device && trimmed) {
        // Re-link with new name (cloud upserts by machine_id)
        const updated = await linkDevice(trimmed);
        // Also update local cloud-device.json name
        if (updated) {
          saveCloudDevice({ ...updated, name: trimmed });
        }
      }
    } catch {
      // Cloud update is best-effort
    }

    return c.json(ok({ device_name: trimmed }));
  } catch (e) {
    return c.json(err((e as Error).message), 400);
  }
});

// ── Theme ─────────────────────────────────────────────────────────────

/** GET /settings/theme */
settingsRoutes.get("/theme", (c) => {
  return c.json(ok({ theme: configService.get("theme") ?? "system" }));
});

/** PUT /settings/theme */
settingsRoutes.put("/theme", async (c) => {
  try {
    const { theme } = await c.req.json<{ theme: ThemeConfig }>();
    if (!["light", "dark", "system"].includes(theme)) {
      return c.json(err("theme must be light, dark, or system"), 400);
    }
    configService.set("theme", theme);
    configService.save();
    return c.json(ok({ theme }));
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

/** PUT /settings/ai — update AI provider settings, writes to yaml */
settingsRoutes.put("/ai", async (c) => {
  try {
    const body = await c.req.json<{
      default_provider?: string;
      providers?: Record<string, Partial<AIProviderConfig>>;
    }>();

    const currentAi = configService.get("ai");

    // Validate each provider config
    if (body.providers) {
      for (const [name, providerConfig] of Object.entries(body.providers)) {
        const errors = validateAIProviderConfig(providerConfig);
        if (errors.length > 0) {
          return c.json(err(`Provider "${name}": ${errors.join(", ")}`), 400);
        }
      }
    }

    // Merge: body overrides current values (shallow merge per provider)
    const updated = {
      ...currentAi,
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
      }
    }

    // Validate default_provider is in allowed list and references existing provider
    if (body.default_provider) {
      if (!VALID_PROVIDERS.includes(body.default_provider as any)) {
        return c.json(err(`default_provider must be one of: ${VALID_PROVIDERS.join(", ")}`), 400);
      }
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

// ── Telegram ──────────────────────────────────────────────────────────

/** GET /settings/telegram — return current telegram config (masks bot_token) */
settingsRoutes.get("/telegram", (c) => {
  const tg = configService.get("telegram") as TelegramConfig | undefined;
  if (!tg) return c.json(ok({ bot_token: "", chat_id: "" }));
  return c.json(ok({
    bot_token: tg.bot_token ? `${tg.bot_token.slice(0, 6)}...` : "",
    chat_id: tg.chat_id,
  }));
});

/** PUT /settings/telegram — save telegram bot_token + chat_id */
settingsRoutes.put("/telegram", async (c) => {
  try {
    const body = await c.req.json<{ bot_token?: string; chat_id?: string }>();
    const current = (configService.get("telegram") as TelegramConfig | undefined) ?? { bot_token: "", chat_id: "" };
    const updated: TelegramConfig = {
      bot_token: body.bot_token ?? current.bot_token,
      chat_id: body.chat_id ?? current.chat_id,
    };
    configService.set("telegram", updated);
    configService.save();
    return c.json(ok({
      bot_token: updated.bot_token ? `${updated.bot_token.slice(0, 6)}...` : "",
      chat_id: updated.chat_id,
    }));
  } catch (e) {
    return c.json(err((e as Error).message), 400);
  }
});

/** POST /settings/telegram/test — send a test message */
settingsRoutes.post("/telegram/test", async (c) => {
  try {
    const body = await c.req.json<{ bot_token?: string; chat_id?: string }>();
    const current = (configService.get("telegram") as TelegramConfig | undefined) ?? { bot_token: "", chat_id: "" };
    const token = body.bot_token || current.bot_token;
    const chatId = body.chat_id || current.chat_id;
    if (!token || !chatId) {
      return c.json(err("bot_token and chat_id are required"), 400);
    }
    const { telegramService } = await import("../../services/telegram-notification.service.ts");
    const result = await telegramService.sendTest(token, chatId);
    if (!result.ok) return c.json(err(result.error ?? "Failed"), 500);
    return c.json(ok({ sent: true }));
  } catch (e) {
    return c.json(err((e as Error).message), 500);
  }
});

// ── Proxy ────────────────────────────────────────────────────────────

/** GET /settings/proxy — proxy status */
settingsRoutes.get("/proxy", async (c) => {
  const { tunnelService } = await import("../../services/tunnel.service.ts");
  const tunnelUrl = tunnelService.getTunnelUrl();
  const authKey = proxyService.getAuthKey();
  return c.json(ok({
    enabled: proxyService.isEnabled(),
    authKey: authKey ?? null,
    requestCount: proxyService.getRequestCount(),
    tunnelUrl: tunnelUrl ?? null,
    proxyEndpoint: tunnelUrl ? `${tunnelUrl}/proxy/v1/messages` : null,
  }));
});

/** PUT /settings/proxy — update proxy settings */
settingsRoutes.put("/proxy", async (c) => {
  try {
    const body = await c.req.json<{ enabled?: boolean; authKey?: string; generateKey?: boolean }>();
    if (body.enabled !== undefined) {
      proxyService.setEnabled(body.enabled);
    }
    if (body.generateKey) {
      proxyService.generateAuthKey();
    } else if (body.authKey !== undefined) {
      proxyService.setAuthKey(body.authKey);
    }
    const { tunnelService } = await import("../../services/tunnel.service.ts");
    const tunnelUrl = tunnelService.getTunnelUrl();
    return c.json(ok({
      enabled: proxyService.isEnabled(),
      authKey: proxyService.getAuthKey() ?? null,
      requestCount: proxyService.getRequestCount(),
      tunnelUrl: tunnelUrl ?? null,
      proxyEndpoint: tunnelUrl ? `${tunnelUrl}/proxy/v1/messages` : null,
    }));
  } catch (e) {
    return c.json(err((e as Error).message), 400);
  }
});
