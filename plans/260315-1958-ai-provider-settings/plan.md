---
title: "AI Provider Settings"
description: "Configurable AI provider settings via ppm.yaml with FE UI and API endpoints"
status: complete
priority: P1
effort: 6h
branch: feat/ai-provider-settings
tags: [ai, settings, config, frontend, api]
created: 2026-03-15
completed: 2026-03-15
---

# AI Provider Settings

## Goal
Make AI provider params (model, effort, maxTurns, budget, thinking) configurable via `ppm.yaml`, exposed through REST API and settings UI. Remove dead CLI provider.

## Phases

| # | Phase | Status | Effort | Files |
|---|-------|--------|--------|-------|
| 1 | [Remove CLI provider](./phase-01-remove-cli-provider.md) | complete | 15m | 4 delete, 1 edit |
| 2 | [Extend config types](./phase-02-extend-config-types.md) | complete | 30m | 1 edit |
| 3 | [API endpoints](./phase-03-api-endpoints.md) | complete | 45m | 2 create, 1 edit |
| 4 | [Provider reads config](./phase-04-provider-reads-config.md) | complete | 1h | 1 edit |
| 5 | [JSON schema](./phase-05-json-schema.md) | complete | 30m | 1 create, 1 edit |
| 6 | [Frontend settings UI](./phase-06-frontend-settings-ui.md) | complete | 2h | 2 create, 1 edit |
| 7 | [Tests](./phase-07-tests.md) | complete | 1h | 2 edit |

## Dependencies
- Phase 2 must complete before 3, 4, 5
- Phase 3 must complete before 6
- Phase 1 is independent (can run in parallel with 2)
- Phase 7 runs after all others

## Key Decisions
- `ppm.yaml` is sole source of truth (no localStorage for AI settings)
- Settings are global (not per-session) -- YAGNI
- Mock provider has no configurable fields -- only agent-sdk gets settings
- CLI provider fully removed (dead code, SDK supersedes it)
- Provider constructor receives config; `sendMessage` reads fresh config each call
- API sits at `/api/settings/ai` (not project-scoped -- global config)

## Config Shape (after Phase 2)
```yaml
ai:
  default_provider: claude
  providers:
    claude:
      type: agent-sdk
      api_key_env: ANTHROPIC_API_KEY
      model: claude-sonnet-4-6
      effort: high
      max_turns: 100
      max_budget_usd: 2.00
      thinking_budget_tokens: 10000
```

## Risks
- Changing config mid-session won't affect active queries (acceptable)
- Invalid yaml values need validation at API layer
