import { Hono } from "hono";
import { configService } from "../../services/config.service.ts";
import {
  validateAIProviderConfig,
  validateDefaultProvider,
  type AIProviderConfig,
} from "../../types/config.ts";
import { ok, err } from "../../types/api.ts";

export const settingsRoutes = new Hono();

/** GET /settings/ai — return current AI config (strips api_key_env) */
settingsRoutes.get("/ai", (c) => {
  const ai = structuredClone(configService.get("ai"));
  // Strip sensitive env var names from response
  for (const provider of Object.values(ai.providers)) {
    delete (provider as unknown as Record<string, unknown>).api_key_env;
  }
  return c.json(ok(ai));
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

    // Validate default_provider references existing provider
    if (body.default_provider) {
      const dpErr = validateDefaultProvider(updated.default_provider, updated.providers);
      if (dpErr) return c.json(err(dpErr), 400);
    }

    configService.set("ai", updated);
    configService.save();

    return c.json(ok(updated));
  } catch (e) {
    return c.json(err((e as Error).message), 400);
  }
});
