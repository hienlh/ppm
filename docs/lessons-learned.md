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

### Windows: SDK query() hangs — executable: "node" fix

**Problem**: On Windows + Bun, SDK `query()` yields zero events — appears to hang forever.

**Root cause**: SDK detects Bun runtime and spawns `child_process.spawn("bun", ["cli.js", ...])`. On Windows, `child_process.spawn("bun")` fails with ENOENT (can't resolve `bun` binary). The error is swallowed internally → no events → looks like a hang.

**Fix**: Pass `executable: "node"` in SDK query options. Forces SDK to spawn `node cli.js` instead of `bun cli.js`. Node is always in PATH on Windows.

**File**: `src/providers/claude-agent-sdk.ts` — `queryOptions` in `sendMessage()`

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
