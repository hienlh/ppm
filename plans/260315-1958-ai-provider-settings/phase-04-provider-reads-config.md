---
phase: 4
title: "Provider Reads Config"
status: complete
effort: 1h
depends_on: [2]
---

# Phase 4: Provider Reads Config

## Overview
Make `ClaudeAgentSdkProvider.sendMessage()` read AI settings from `configService` instead of hardcoding values. Config is read fresh each `sendMessage` call so yaml changes take effect on next query.

## Context
- Current hardcoded values in `sendMessage()` (line 219-248 of claude-agent-sdk.ts):
  - `maxTurns: 100` (hardcoded)
  - No model override (uses SDK default)
  - No effort setting
  - No budget limit
  - No thinking budget
- `configService` is a singleton already imported elsewhere in the codebase
- SDK `query()` options accept: `model`, `effort`, `maxTurns`, `maxBudgetUsd` directly

## Files to Edit
- `src/providers/claude-agent-sdk.ts`

## Implementation Steps

1. **Add configService import at top of file**

```typescript
import { configService } from "../services/config.service.ts";
```

2. **Create helper method to read provider config**

Add to `ClaudeAgentSdkProvider` class:

```typescript
/** Read current provider config from yaml (fresh each call) */
private getProviderConfig() {
  const ai = configService.get("ai");
  const providerId = ai.default_provider ?? "claude";
  return ai.providers[providerId] ?? {};
}
```

3. **Update `sendMessage()` query options** (around line 219)

Replace the hardcoded options block. The key change is in the `query()` call:

```typescript
const providerConfig = this.getProviderConfig();

const q = query({
  prompt: message,
  options: {
    sessionId: isFirstMessage ? sessionId : undefined,
    resume: isFirstMessage ? undefined : sessionId,
    cwd: meta.projectPath,
    systemPrompt: { type: "preset", preset: "claude_code" },
    settingSources: ["project"],
    env: {
      ...process.env,
      ANTHROPIC_API_KEY: "",
      ANTHROPIC_BASE_URL: "",
      ANTHROPIC_AUTH_TOKEN: "",
    },
    settings: { permissions: { allow: [], deny: [] } },
    allowedTools: [
      "Read", "Write", "Edit", "Bash", "Glob", "Grep",
      "WebSearch", "WebFetch", "AskUserQuestion",
      "Agent", "Skill", "TodoWrite", "ToolSearch",
    ],
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
    // --- Config-driven values ---
    ...(providerConfig.model && { model: providerConfig.model }),
    ...(providerConfig.effort && { effort: providerConfig.effort }),
    maxTurns: providerConfig.max_turns ?? 100,
    ...(providerConfig.max_budget_usd && { maxBudgetUsd: providerConfig.max_budget_usd }),
    ...(providerConfig.thinking_budget_tokens != null && {
      thinkingBudgetTokens: providerConfig.thinking_budget_tokens,
    }),
    canUseTool,
    includePartialMessages: true,
  } as any,
});
```

Key points:
- `model`, `effort`, `maxBudgetUsd`, `thinkingBudgetTokens` only set if configured (spread with conditional)
- `maxTurns` falls back to 100 if not in config
- Uses snake_case config keys mapped to camelCase SDK options
- `as any` cast already present (SDK types incomplete)

4. **No changes to provider interface** — `AIProvider` contract stays identical. This is purely internal wiring.

## Todo
- [x] Import `configService` in claude-agent-sdk.ts
- [x] Add `getProviderConfig()` private method
- [x] Replace hardcoded `maxTurns: 100` with config-driven value
- [x] Add model/effort/budget/thinking from config
- [x] Verify existing unit tests still pass (they mock `query()` so config doesn't matter)
- [x] Manual test: change yaml, send message, verify SDK receives new values

## Success Criteria
- Provider reads model/effort/maxTurns/budget/thinking from `configService`
- Missing config fields fall back to defaults (not errors)
- Existing unit tests pass without modification
- SDK `query()` call includes config-driven options
