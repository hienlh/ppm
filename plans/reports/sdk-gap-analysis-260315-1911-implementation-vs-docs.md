# SDK Gap Analysis: PPM Implementation vs Official Docs

**Date:** 2026-03-15
**Scope:** Compare `src/providers/claude-agent-sdk.ts` & related files against `docs/claude-agent-sdk-reference.md`

---

## Legend

| Symbol | Meaning |
|--------|---------|
| :white_check_mark: | Implemented correctly |
| :warning: | Implemented but differs from docs / has issues |
| :x: | Not implemented |
| :bulb: | Enhancement opportunity from docs |

---

## 1. Core API (`query()`)

| Feature | Status | Notes |
|---------|--------|-------|
| `query()` async generator | :white_check_mark: | Lines 209-235 |
| `prompt` as string | :white_check_mark: | Single message string |
| `prompt` as AsyncGenerator | :x: | Not used; docs recommend streaming input for custom MCP tools, image uploads, interruptions |
| `options` object | :white_check_mark: | Passed via `as any` cast |

---

## 2. Options Comparison

| Option | PPM Uses | Docs Default | Analysis |
|--------|----------|--------------|----------|
| `allowedTools` | `["Read","Write","Edit","Bash","Glob","Grep","WebSearch","WebFetch","AskUserQuestion"]` | — | :warning: Missing `Agent`, `Skill`, `TodoWrite`, `ToolSearch`. No subagent or skill invocation possible. |
| `permissionMode` | `"bypassPermissions"` | `"default"` | :warning: Docs warn: **propagates to subagents**, all tools run without prompts. Intentional for PPM but risky if subagents added later. |
| `canUseTool` | Only handles `AskUserQuestion` | General callback | :white_check_mark: Correct — bypassPermissions auto-approves other tools. |
| `includePartialMessages` | `true` | `false` | :white_check_mark: Enables real-time streaming. |
| `settingSources` | `[]` (empty) | Not loaded by default | :warning: **CLAUDE.md, skills, hooks NOT loaded**. Docs say set `["project"]` to load project conventions. Skills discovery in PPM is custom (slash-items.service.ts) but SDK skills won't actually execute. |
| `systemPrompt` | Not set | Minimal default | :warning: SDK uses **minimal system prompt** by default. Full Claude Code behavior requires `{ preset: "claude_code" }`. PPM agents don't get coding guidelines, security instructions, or response style. |
| `resume` / `sessionId` | :white_check_mark: | — | Correct: first msg → sessionId, subsequent → resume. |
| `cwd` | `meta.projectPath` | Process cwd | :white_check_mark: Correct for project-scoped tool execution. |
| `env` | Neutralizes ANTHROPIC_* | Process env | :white_check_mark: Prevents .env poisoning (documented in lessons-learned). |
| `settings` | `{ permissions: { allow: [], deny: [] } }` | From filesystem | :white_check_mark: Intentional bypass of project restrictions. |
| `maxTurns` | Not set | No limit | :bulb: Could prevent runaway sessions. Docs recommend setting for production. |
| `maxBudgetUsd` | Not set | No limit | :bulb: Could cap costs per query. |
| `effort` | Not set | `"high"` (TS default) | :bulb: Could use `"low"` for simple tasks to reduce cost. |
| `model` | Not set | CLI default | :bulb: Could allow user to select model per session. |
| `forkSession` | Not used | — | :x: No explore-alternatives feature. |
| `enableFileCheckpointing` | Not used | — | :x: No undo/rewind for file changes. |
| `persistSession` | Not set (default true) | `true` | :white_check_mark: Sessions persist to disk. |
| `mcpServers` | Not used | — | :x: No MCP integration. |
| `agents` | Not used | — | :x: No subagent definitions. |
| `hooks` | Not used (programmatic) | — | :x: No programmatic hooks. |
| `plugins` | Not used | — | :x: No plugin loading. |
| `disallowedTools` | Not used | — | :warning: With bypassPermissions, allowedTools doesn't constrain. Should use disallowedTools to block dangerous tools if needed. |

---

## 3. Message Handling

| Message Type | PPM Handles | How | Issues |
|--------------|-------------|-----|--------|
| `SystemMessage` (init) | :x: | Not processed | Missing: session metadata, MCP server status, available slash commands from SDK init |
| `AssistantMessage` | :white_check_mark: | Parses text + tool_use blocks | Correct |
| `UserMessage` | :x: | Not directly — fetches via getSessionMessages() | :warning: Indirect approach; docs show UserMessage yields tool results directly in stream |
| `StreamEvent` | :white_check_mark: | Handles `content_block_delta` text_delta | Only text deltas; doesn't track tool call streaming (input_json_delta) |
| `ResultMessage` | :white_check_mark: | Extracts total_cost_usd | :warning: Missing: `subtype` check (success/error_max_turns/error_max_budget_usd), `usage` details, `session_id` from result, `stop_reason`, `num_turns` |
| `rate_limit_event` | :white_check_mark: | Custom handling for five_hour/seven_day | Not in official docs — PPM-specific extension |
| `partial` (legacy) | :white_check_mark: | Fallback for older SDK versions | Good backward compat |

### Key Issue: Tool Result Fetching

PPM fetches tool results by calling `getSessionMessages()` after detecting a new assistant/stream_event. This is a workaround because the SDK stream doesn't expose tool results as `UserMessage` in the current implementation.

**Docs say:** UserMessage is yielded after each tool execution with the tool result content. PPM should receive these directly in the `for await` loop.

**Possible cause:** The `as any` cast on options may be hiding type issues, or the SDK version may not emit UserMessage for tool results when `includePartialMessages: true`.

---

## 4. Sessions

| Feature | Status | Notes |
|---------|--------|-------|
| Create session (UUID) | :white_check_mark: | `createSession()` |
| Resume by ID | :white_check_mark: | `resume: sessionId` |
| Continue most recent | :x: | `continue: true` not used |
| Fork session | :x: | `forkSession: true` not used |
| List sessions | :white_check_mark: | `listSessions()` / `listSessionsByDir()` |
| Get session messages | :white_check_mark: | `getSessionMessages()` |
| Session ID from ResultMessage | :warning: | Uses PPM-generated UUID, not SDK's session_id from result |
| Delete from disk | :x: | Only in-memory cleanup; SDK sessions persist forever |

---

## 5. Hooks

| Feature | Status | Notes |
|---------|--------|-------|
| Programmatic hooks (PreToolUse, etc.) | :x: | Not implemented |
| Filesystem hooks (.claude/settings.json) | :x: | `settingSources: []` prevents loading |
| Audit logging | :x: | No tool call auditing |
| Tool blocking/modification | :x: | bypassPermissions skips all checks |
| Notification hooks | :x: | No Slack/external notifications |

---

## 6. Subagents

| Feature | Status | Notes |
|---------|--------|-------|
| `Agent` in allowedTools | :x: | Not listed |
| AgentDefinition in options | :x: | No `agents` parameter |
| Detect subagent invocation | :x: | — |
| Resume subagents | :x: | — |

---

## 7. MCP

| Feature | Status | Notes |
|---------|--------|-------|
| stdio servers | :x: | — |
| HTTP/SSE servers | :x: | — |
| SDK MCP servers (custom tools) | :x: | — |
| .mcp.json auto-load | :x: | settingSources empty |

---

## 8. Custom Tools

| Feature | Status | Notes |
|---------|--------|-------|
| `createSdkMcpServer()` | :x: | Not used |
| `tool()` helper | :x: | Not used |
| PPM-specific tools (file tree, git, terminal) | :x: | Could expose PPM services as MCP tools |

---

## 9. Streaming

| Feature | Status | Notes |
|---------|--------|-------|
| Output streaming (text deltas) | :white_check_mark: | Via stream_event + partial |
| Tool call streaming (input_json_delta) | :x: | Only text deltas processed |
| Streaming input (AsyncGenerator) | :x: | Uses string prompt |
| Image uploads | :x: | Requires streaming input mode |
| Message queueing/interruption | :x: | FE queues but SDK doesn't support mid-stream input |

---

## 10. User Input & Approvals

| Feature | Status | Notes |
|---------|--------|-------|
| canUseTool callback | :white_check_mark: | For AskUserQuestion only |
| AskUserQuestion handling | :white_check_mark: | Yields approval_request, waits for FE response |
| Answer merging | :white_check_mark: | Merges data into updatedInput.answers |
| Deny with message | :white_check_mark: | "User skipped the question" |
| Approval timeout | :x: | Infinite wait if FE disconnects |
| Tool approval UI (non-AskUserQuestion) | :x: | bypassPermissions skips all |
| Preview format (html/markdown) | :x: | `toolConfig.askUserQuestion.previewFormat` not set |

---

## 11. System Prompts & CLAUDE.md

| Feature | Status | Notes |
|---------|--------|-------|
| systemPrompt preset | :x: | Not set → minimal prompt |
| systemPrompt append | :x: | — |
| CLAUDE.md loading | :x: | settingSources empty |
| Output styles | :x: | — |

---

## 12. Skills & Slash Commands

| Feature | Status | Notes |
|---------|--------|-------|
| Skills discovery (PPM custom) | :white_check_mark: | slash-items.service.ts scans .claude/skills/ and .claude/commands/ |
| SDK Skill tool | :x: | Not in allowedTools |
| Slash command execution | :warning: | FE sends `/command` as prompt text, but SDK Skill tool not enabled |

---

## 13. File Checkpointing

| Feature | Status | Notes |
|---------|--------|-------|
| enableFileCheckpointing | :x: | — |
| Checkpoint capture | :x: | — |
| rewindFiles() | :x: | — |

---

## 14. Cost Tracking

| Feature | Status | Notes |
|---------|--------|-------|
| total_cost_usd | :white_check_mark: | From ResultMessage |
| Per-model breakdown (modelUsage) | :x: | TS SDK feature, not extracted |
| Per-step usage dedup | :x: | Not tracked |
| Cumulative across queries | :warning: | FE accumulates totalCostUsd but resets on page reload |
| Cache token tracking | :x: | cache_read/creation_input_tokens not parsed |

---

## 15. Hosting & Security

| Feature | Status | Notes |
|---------|--------|-------|
| Container isolation | N/A | PPM runs on user's machine |
| Credential proxy | N/A | — |
| Sandbox settings | :x: | Not configured |

---

## Priority Recommendations

### High Priority (functionality gaps)

1. **Set `systemPrompt: { preset: "claude_code" }`** — Currently agents get minimal prompt without coding guidelines, security instructions, or response formatting.

2. **Add `Agent` and `Skill` to allowedTools** — Enables subagent delegation and skill invocation. Skills are discovered by PPM but can't execute without SDK Skill tool.

3. **Set `settingSources: ["project"]`** — Loads project CLAUDE.md, skills, and hooks from the project being worked on. Currently all filesystem settings are bypassed.

4. **Check ResultMessage.subtype** — Currently ignores whether result is `success`, `error_max_turns`, or `error_max_budget_usd`. Should surface these to FE for proper UX.

5. **Add approval timeout** — If FE disconnects during AskUserQuestion, SDK hangs forever. Add 60s timeout with auto-deny.

### Medium Priority (robustness)

6. **Set `maxTurns: 50` and/or `maxBudgetUsd: 1.0`** — Prevent runaway sessions. Surface limit-hit errors to user.

7. **Switch to streaming input mode (AsyncGenerator)** — Required for image uploads, mid-stream interruption, and custom MCP tools. Current string prompt mode limits capabilities.

8. **Handle SystemMessage (init)** — Extract session metadata, MCP server status, available tools list for FE display.

9. **Add `disallowedTools`** — bypassPermissions means allowedTools doesn't actually constrain. Use disallowedTools to explicitly block tools that PPM shouldn't use.

### Low Priority (enhancements)

10. **MCP server support** — Connect project-specific MCP servers (databases, browsers, APIs).

11. **Custom tools via `createSdkMcpServer()`** — Expose PPM services (file tree, git status, terminal) as tools Claude can use directly.

12. **File checkpointing** — Enable undo/rewind for editor integration.

13. **Subagent definitions** — Define specialized agents (code-reviewer, test-runner) via `agents` param.

14. **V2 SDK preview** — Monitor `unstable_v2_createSession()` for cleaner multi-turn chat pattern.

15. **Effort level control** — Allow user to select reasoning depth per message.

---

## Code Differences from Docs

### 1. `sessionId` vs `resume` (PPM-specific pattern)

**PPM does:**
```typescript
sessionId: isFirstMessage ? sessionId : undefined,
resume: isFirstMessage ? undefined : sessionId,
```

**Docs say:** First query creates session (no sessionId needed), capture `session_id` from ResultMessage, pass to `resume` for subsequent queries.

**Issue:** PPM generates its own UUID and passes as `sessionId` on first message. Docs don't show a `sessionId` option — the SDK generates its own. This works but means PPM's UUID might differ from SDK's internal session_id.

### 2. Tool results via `getSessionMessages()` (workaround)

**PPM does:** After detecting pending tools, calls `getSessionMessages()` to fetch tool_result blocks from session history.

**Docs say:** `UserMessage` is yielded in the `for await` loop after each tool execution.

**Issue:** PPM may not be receiving UserMessage events properly. The `for await` loop should yield these naturally. Possible SDK version issue or the `as any` cast hiding them.

### 3. `allowDangerouslySkipPermissions` (undocumented)

Not in official docs. PPM passes `allowDangerouslySkipPermissions: true` alongside `permissionMode: "bypassPermissions"`. May be a legacy/internal option.

### 4. `settings` override (undocumented structure)

PPM passes `settings: { permissions: { allow: [], deny: [] } }`. Docs show permission rules via `allowedTools`/`disallowedTools` options or filesystem `.claude/settings.json`. Direct `settings` object structure not documented.

### 5. `as any` cast on options

Options are cast as `any` which bypasses TypeScript type checking. Some options used (`sessionId`, `settings`, `allowDangerouslySkipPermissions`) may be undocumented or internal APIs.

---

## Unresolved Questions

1. Why doesn't PPM receive `UserMessage` (tool results) in the stream directly? Is this a SDK version issue or intentional?
2. Is `sessionId` option documented anywhere? Docs only show `resume` for existing sessions.
3. Should PPM switch to `permissionMode: "acceptEdits"` instead of `bypassPermissions` for better safety?
4. What SDK version is PPM using? V2 preview features available?
