---
phase: 3
title: "API Endpoints"
status: complete
effort: 45m
depends_on: [2]
---

# Phase 3: API Endpoints

## Overview
Add `GET /api/settings/ai` and `PUT /api/settings/ai` endpoints. These are global (not project-scoped) since AI config applies to the whole PPM instance.

## Context
- Routes mount at `/api/settings/ai` in `src/server/index.ts` (alongside `/api/projects`)
- `configService` singleton handles yaml read/write
- Use existing `ok()`/`err()` response helpers from `src/types/api.ts`

## Files to Create
- `src/server/routes/settings.ts` — settings routes (GET + PUT)

## Files to Edit
- `src/server/index.ts` — mount settings routes

## Implementation Steps

1. **Create `src/server/routes/settings.ts`**

```typescript
import { Hono } from "hono";
import { configService } from "../../services/config.service.ts";
import { validateAIProviderConfig } from "../../types/config.ts";
import { ok, err } from "../../types/api.ts";

export const settingsRoutes = new Hono();

/** GET /settings/ai — return current AI config */
settingsRoutes.get("/ai", (c) => {
  const ai = configService.get("ai");
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
        };
      }
    }

    configService.set("ai", updated);
    configService.save();

    return c.json(ok(updated));
  } catch (e) {
    return c.json(err((e as Error).message), 400);
  }
});
```

Key design decisions:
- Shallow merge per provider: PUT only changes fields you send, preserves others
- Validates before writing to disk
- Returns the full updated AI config in response

2. **Mount in `src/server/index.ts`**

Add after the projects route:
```typescript
import { settingsRoutes } from "./routes/settings.ts";
// ...
app.route("/api/settings", settingsRoutes);
```

Place between the auth check and project-scoped routes:
```
app.get("/api/auth/check", ...);
app.route("/api/settings", settingsRoutes);  // <-- new
app.route("/api/projects", projectRoutes);
```

## API Contract

### GET /api/settings/ai
**Response 200:**
```json
{
  "ok": true,
  "data": {
    "default_provider": "claude",
    "providers": {
      "claude": {
        "type": "agent-sdk",
        "api_key_env": "ANTHROPIC_API_KEY",
        "model": "claude-sonnet-4-6",
        "effort": "high",
        "max_turns": 100
      }
    }
  }
}
```

### PUT /api/settings/ai
**Request body:**
```json
{
  "providers": {
    "claude": {
      "model": "claude-opus-4-6",
      "max_turns": 50
    }
  }
}
```
**Response 200:** Full updated AI config (same shape as GET)
**Response 400:** Validation error

## Todo
- [x] Create `src/server/routes/settings.ts` with GET and PUT handlers
- [x] Mount at `/api/settings` in `src/server/index.ts`
- [x] Verify auth middleware protects the new endpoints
- [x] Test with curl: GET returns defaults, PUT updates yaml on disk

## Success Criteria
- `GET /api/settings/ai` returns current AI config from yaml
- `PUT /api/settings/ai` validates, merges, writes to yaml, returns updated config
- Invalid values (e.g. max_turns: -1) return 400
- Auth middleware applies (endpoints require token)
