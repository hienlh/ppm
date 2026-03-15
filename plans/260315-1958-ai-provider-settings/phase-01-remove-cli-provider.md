---
phase: 1
title: "Remove CLI Provider"
status: complete
effort: 15m
---

# Phase 1: Remove CLI Provider

## Overview
Delete `ClaudeCodeCliProvider` and its helper modules. SDK provider supersedes it entirely.

## Files to Delete
- `src/providers/claude-code-cli.ts` — CLI provider (414 lines)
- `src/providers/claude-binary-finder.ts` — binary discovery helper
- `src/providers/claude-process-registry.ts` — process lifecycle helper

## Files to Edit
- `src/providers/registry.ts` — remove CLI import and registration

## Implementation Steps

1. **Delete CLI provider and helpers**
   ```bash
   rm src/providers/claude-code-cli.ts
   rm src/providers/claude-binary-finder.ts
   rm src/providers/claude-process-registry.ts
   ```

2. **Update registry.ts** — remove CLI provider lines:
   ```typescript
   // REMOVE these lines:
   import { ClaudeCodeCliProvider } from "./claude-code-cli.ts";
   providerRegistry.register(new ClaudeCodeCliProvider());
   ```
   Final registry.ts should only register `ClaudeAgentSdkProvider` and `MockProvider`.

3. **Search for stale references**
   ```bash
   grep -r "claude-code-cli\|ClaudeCodeCliProvider\|claude-binary-finder\|claude-process-registry" src/
   ```
   Fix any remaining imports.

4. **Update config type** — remove `"cli"` from union:
   In `src/types/config.ts`, change `type: "agent-sdk" | "cli"` to `type: "agent-sdk" | "mock"`.

## Todo
- [x] Delete 3 CLI-related files
- [x] Update registry.ts imports and registration
- [x] Remove `"cli"` from `AIProviderConfig.type` union
- [x] Grep for stale references
- [x] Verify `bun dev:server` starts without errors

## Success Criteria
- No references to CLI provider remain in `src/`
- Registry only has `claude-sdk` and `mock` providers
- Existing tests pass (`bun test tests/unit/`)
