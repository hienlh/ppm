import { Hono } from "hono";
import { configService } from "../../services/config.service.ts";
import { getConfigValue, setConfigValue } from "../../services/db.service.ts";
import {
  validateAIProviderConfig,
  validateDefaultProvider,
  VALID_PROVIDERS,
  type AIProviderConfig,
  type ThemeConfig,
} from "../../types/config.ts";
import { ok, err } from "../../types/api.ts";

export const settingsRoutes = new Hono();

/** Strip api_key_env from all providers in an AI config object */
function stripSensitiveFields(ai: { providers: Record<string, unknown> }) {
  const clone = structuredClone(ai);
  for (const provider of Object.values(clone.providers)) {
    delete (provider as Record<string, unknown>).api_key_env;
  }
  return clone;
}

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
