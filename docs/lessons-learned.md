# Lessons Learned

Knowledge and gotchas discovered during PPM development.

---

## Claude Agent SDK

### .env poisoning via project cwd

**Problem**: SDK spawns a CLI process in the project's `cwd`. The CLI auto-loads `.env` via dotenv. If the project has `ANTHROPIC_API_KEY=dummy` or `ANTHROPIC_BASE_URL=http://localhost:...`, the CLI uses those instead of the user's subscription → "Invalid API key" or empty responses with no tool execution.

**Symptoms**:
- Model returns empty response, no text or tool_use events
- `result.subtype === "error_during_execution"`
- Text response: "Invalid API key · Fix external API key"
- `totalCostUsd: 0` in usage

**Fix**: Neutralize `ANTHROPIC_*` env vars by setting them to empty string (not deleting — dotenv won't override existing vars):
```ts
env: {
  ...process.env,
  ANTHROPIC_API_KEY: "",
  ANTHROPIC_BASE_URL: "",
  ANTHROPIC_AUTH_TOKEN: "",
},
```

**File**: `src/providers/claude-agent-sdk.ts`

---

### Project-local Claude settings restrict tools

**Problem**: Projects may have `.claude/settings.local.json` with restrictive `permissions.allow` lists (e.g., only `Bash(python:*)`, `Bash(ls:*)`). Even with `permissionMode: "bypassPermissions"`, the SDK CLI still reads these and restricts available tools.

**Fix**: Override with explicit empty settings and no setting sources:
```ts
settings: { permissions: { allow: [], deny: [] } },
settingSources: [],
```

---

### Windows: SDK query() hangs — direct CLI fallback

**Problem**: On Windows, Bun subprocess stdin pipe buffering prevents SDK `query()` from working. Data written to stdin stays in buffer, never reaches the CLI child process → async iterator yields zero events → hangs forever.

**Root cause**: Python SDK had identical issue (#208), fixed with `asyncio.StreamWriter.drain()`. TypeScript SDK lacks this fix.

**Workaround**: Bypass SDK on Windows — spawn `claude -p --verbose --output-format stream-json` directly. CLI stream-json output uses same event types as SDK (`system/init`, `assistant`, `result`, `rate_limit_event`), so existing event handling works unchanged.

**Caveat**: CLI stream-json doesn't emit per-token `stream_event` deltas. Provider synthesizes them by chunking `assistant` message text into ~30-char pieces as synthetic `content_block_delta` events.

**Tracking**:
- Python SDK #208 (FIXED): stdin drain fix
- TS SDK #44 (OPEN): query() yields zero events
- TS SDK #64 (OPEN): bash tool hangs on empty output

**File**: `src/providers/claude-agent-sdk.ts` — `queryDirectCli()` method

---

## WebSocket Chat Architecture

### Event flow: SDK → Provider → WS → Frontend

1. SDK emits: `system` → `stream_event`* → `assistant` → `rate_limit_event` → `user` (tool_result) → `result`
2. Provider extracts text from `stream_event.event.delta.text` and tool_use from `assistant.message.content`
3. Provider yields: `text`, `tool_use`, `tool_result`, `usage`, `done`
4. WS handler sends JSON to frontend

Key: `stream_event` contains raw API events (`content_block_delta` with `text_delta`). The `assistant` event contains the full message with all content blocks.

### tool_result lives in `user` events

SDK returns tool results as `user` type messages (not `assistant`). Provider fetches them via `getSessionMessages()` after detecting `pendingToolCount > 0`.
