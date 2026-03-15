---
phase: 2
title: "Extend Config Types"
status: complete
effort: 30m
---

# Phase 2: Extend Config Types

## Overview
Add model/effort/maxTurns/budget/thinking fields to `AIProviderConfig`. These map directly to SDK `query()` options.

## Context
- SDK reference (Section 3): `model`, `effort`, `maxTurns`, `maxBudgetUsd` are direct `query()` options
- `thinkingBudgetTokens` maps to SDK's thinking budget control
- All new fields are optional with sensible defaults

## Files to Edit
- `src/types/config.ts`

## Implementation Steps

1. **Update `AIProviderConfig` interface**

```typescript
export interface AIProviderConfig {
  type: "agent-sdk" | "mock";
  api_key_env?: string;
  // Agent SDK-specific settings (ignored by mock provider)
  model?: string;
  effort?: "low" | "medium" | "high" | "max";
  max_turns?: number;
  max_budget_usd?: number;
  thinking_budget_tokens?: number;
}
```

Note: using snake_case field names to match yaml convention (yaml files use snake_case). TypeScript code will map these to camelCase when passing to SDK.

2. **Update `DEFAULT_CONFIG`** — add default values to the claude provider:

```typescript
export const DEFAULT_CONFIG: PpmConfig = {
  port: 8080,
  host: "0.0.0.0",
  auth: { enabled: true, token: "" },
  projects: [],
  ai: {
    default_provider: "claude",
    providers: {
      claude: {
        type: "agent-sdk",
        api_key_env: "ANTHROPIC_API_KEY",
        model: "claude-sonnet-4-6",
        effort: "high",
        max_turns: 100,
      },
    },
  },
};
```

Defaults rationale:
- `model: "claude-sonnet-4-6"` — best balance of speed/quality
- `effort: "high"` — good quality without max cost
- `max_turns: 100` — matches current hardcoded value
- `max_budget_usd` and `thinking_budget_tokens` — omitted (no limit by default)

3. **Add validation helper** (in same file, export for use by API):

```typescript
export function validateAIProviderConfig(config: Partial<AIProviderConfig>): string[] {
  const errors: string[] = [];
  if (config.max_turns != null && (config.max_turns < 1 || config.max_turns > 500)) {
    errors.push("max_turns must be 1-500");
  }
  if (config.max_budget_usd != null && (config.max_budget_usd < 0.01 || config.max_budget_usd > 50)) {
    errors.push("max_budget_usd must be 0.01-50.00");
  }
  if (config.thinking_budget_tokens != null && config.thinking_budget_tokens < 0) {
    errors.push("thinking_budget_tokens must be >= 0");
  }
  const validEfforts = ["low", "medium", "high", "max"];
  if (config.effort && !validEfforts.includes(config.effort)) {
    errors.push(`effort must be one of: ${validEfforts.join(", ")}`);
  }
  return errors;
}
```

## Todo
- [x] Add new optional fields to `AIProviderConfig`
- [x] Remove `"cli"` from type union (if not done in Phase 1)
- [x] Update `DEFAULT_CONFIG` with default model/effort/max_turns
- [x] Add `validateAIProviderConfig()` export
- [x] Verify file stays under 200 lines

## Success Criteria
- `AIProviderConfig` has all 5 new optional fields
- `DEFAULT_CONFIG` provides sensible defaults
- Validation covers range/enum constraints
- Existing code compiles (new fields are optional, no breaking change)
