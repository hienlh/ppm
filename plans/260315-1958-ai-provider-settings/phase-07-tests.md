---
phase: 7
title: "Tests"
status: complete
effort: 1h
depends_on: [1, 2, 3, 4]
---

# Phase 7: Tests

## Overview
Update existing tests and add new ones covering config validation, API endpoints, and provider config reading.

## Files to Edit
- `tests/unit/providers/claude-agent-sdk.test.ts` — add config-reading tests
- `tests/integration/claude-agent-sdk-integration.test.ts` — no changes needed (provider interface unchanged)

## Files to Create
- `tests/unit/config-validation.test.ts` — validate config helper
- `tests/unit/routes/settings-routes.test.ts` — API endpoint tests

## Implementation Steps

### 1. Config validation tests: `tests/unit/config-validation.test.ts`

```typescript
import { describe, it, expect } from "bun:test";
import { validateAIProviderConfig } from "../../src/types/config.ts";

describe("validateAIProviderConfig", () => {
  it("returns empty array for valid config", () => {
    const errors = validateAIProviderConfig({
      model: "claude-sonnet-4-6",
      effort: "high",
      max_turns: 100,
      max_budget_usd: 2.0,
      thinking_budget_tokens: 10000,
    });
    expect(errors).toHaveLength(0);
  });

  it("rejects max_turns out of range", () => {
    expect(validateAIProviderConfig({ max_turns: 0 })).toHaveLength(1);
    expect(validateAIProviderConfig({ max_turns: 501 })).toHaveLength(1);
  });

  it("rejects invalid effort", () => {
    expect(validateAIProviderConfig({ effort: "turbo" as any })).toHaveLength(1);
  });

  it("rejects negative budget", () => {
    expect(validateAIProviderConfig({ max_budget_usd: -1 })).toHaveLength(1);
  });

  it("rejects negative thinking tokens", () => {
    expect(validateAIProviderConfig({ thinking_budget_tokens: -1 })).toHaveLength(1);
  });

  it("allows empty config (all optional)", () => {
    expect(validateAIProviderConfig({})).toHaveLength(0);
  });

  it("allows zero thinking tokens (means disabled)", () => {
    expect(validateAIProviderConfig({ thinking_budget_tokens: 0 })).toHaveLength(0);
  });
});
```

### 2. Settings API tests: `tests/unit/routes/settings-routes.test.ts`

```typescript
import { describe, it, expect, beforeEach } from "bun:test";
import { Hono } from "hono";
import { settingsRoutes } from "../../../src/server/routes/settings.ts";
import { configService } from "../../../src/services/config.service.ts";

describe("GET /ai", () => {
  it("returns current AI config", async () => {
    configService.load(); // loads defaults
    const app = new Hono().route("/settings", settingsRoutes);
    const res = await app.request("/settings/ai");
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.data.default_provider).toBe("claude");
    expect(json.data.providers.claude.type).toBe("agent-sdk");
  });
});

describe("PUT /ai", () => {
  it("updates provider config and returns merged result", async () => {
    configService.load();
    const app = new Hono().route("/settings", settingsRoutes);
    const res = await app.request("/settings/ai", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        providers: { claude: { model: "claude-opus-4-6", max_turns: 50 } }
      }),
    });
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.data.providers.claude.model).toBe("claude-opus-4-6");
    expect(json.data.providers.claude.max_turns).toBe(50);
    // Original fields preserved
    expect(json.data.providers.claude.type).toBe("agent-sdk");
  });

  it("rejects invalid max_turns", async () => {
    configService.load();
    const app = new Hono().route("/settings", settingsRoutes);
    const res = await app.request("/settings/ai", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        providers: { claude: { max_turns: 999 } }
      }),
    });
    expect(res.status).toBe(400);
  });
});
```

### 3. Update SDK provider unit tests

Add to `tests/unit/providers/claude-agent-sdk.test.ts`:

```typescript
describe("config-driven query options", () => {
  it("passes model from config to query options", async () => {
    // Mock configService to return specific config
    // ... setup mock
    mockQueryFn.mockReturnValue(createMockQueryIterator([{ type: "result" }]));
    const session = await provider.createSession({});
    for await (const _ of provider.sendMessage(session.id, "hi")) {}

    const opts = mockQueryFn.mock.calls[0]![0].options;
    // Verify config values are passed through
    // (exact assertions depend on how configService is mocked)
  });
});
```

Note: Since `configService` is a singleton imported at module level, mocking it requires either:
- Using `mock.module()` for config.service (preferred for unit tests)
- Or setting config values directly via `configService.set("ai", ...)`

Recommend the direct approach since configService is already loaded:
```typescript
import { configService } from "../../../src/services/config.service.ts";
// In beforeEach:
configService.load(); // loads defaults
configService.set("ai", {
  default_provider: "claude",
  providers: {
    claude: { type: "agent-sdk", model: "claude-opus-4-6", effort: "low", max_turns: 25 }
  }
});
```

Then assert `mockQueryFn.mock.calls[0]![0].options.model === "claude-opus-4-6"`.

### 4. Verify existing tests still pass

```bash
bun test tests/unit/
```

Existing tests should pass without changes because:
- Provider interface is unchanged
- Unit tests mock the SDK `query()` call
- Config fields are optional with defaults

## Todo
- [x] Create `tests/unit/config-validation.test.ts`
- [x] Create `tests/unit/routes/settings-routes.test.ts`
- [x] Add config-reading test cases to SDK provider unit tests
- [x] Run full test suite: `bun test`
- [x] Verify no regressions in integration tests

## Success Criteria
- All new tests pass
- All existing tests pass
- Config validation covers boundary cases
- API routes tested for happy path and error cases
- Provider config pass-through verified
