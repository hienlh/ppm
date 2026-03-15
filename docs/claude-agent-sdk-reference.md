# Claude Agent SDK — Comprehensive Reference

> Tổng hợp từ [platform.claude.com/docs/en/agent-sdk](https://platform.claude.com/docs/en/agent-sdk/overview.md).
> Last updated: 2026-03-15.

---

## Table of Contents

- [1. Overview](#1-overview)
- [2. Installation & Setup](#2-installation--setup)
- [3. Core API — `query()`](#3-core-api--query)
- [4. Agent Loop](#4-agent-loop)
- [5. Message Types](#5-message-types)
- [6. Permissions](#6-permissions)
- [7. Hooks](#7-hooks)
- [8. Sessions](#8-sessions)
- [9. Subagents](#9-subagents)
- [10. MCP (Model Context Protocol)](#10-mcp-model-context-protocol)
- [11. Custom Tools](#11-custom-tools)
- [12. Streaming](#12-streaming)
- [13. User Input & Approvals](#13-user-input--approvals)
- [14. System Prompts & CLAUDE.md](#14-system-prompts--claudemd)
- [15. Skills, Slash Commands & Plugins](#15-skills-slash-commands--plugins)
- [16. File Checkpointing](#16-file-checkpointing)
- [17. Cost Tracking](#17-cost-tracking)
- [18. Hosting & Secure Deployment](#18-hosting--secure-deployment)
- [19. TypeScript V2 Preview](#19-typescript-v2-preview)
- [20. PPM Integration Notes](#20-ppm-integration-notes)

---

## 1. Overview

**Claude Agent SDK** (renamed from Claude Code SDK) gives programmatic access to the same tools, agent loop, and context management that power Claude Code.

- **Languages**: TypeScript (`@anthropic-ai/claude-agent-sdk`) & Python (`claude-agent-sdk`)
- **Built-in tools**: Read, Write, Edit, Bash, Glob, Grep, WebSearch, WebFetch, AskUserQuestion, Agent, Skill, TodoWrite, ToolSearch
- **Auth**: `ANTHROPIC_API_KEY` env var; also supports Bedrock (`CLAUDE_CODE_USE_BEDROCK=1`), Vertex AI (`CLAUDE_CODE_USE_VERTEX=1`), Azure (`CLAUDE_CODE_USE_FOUNDRY=1`)

```typescript
import { query } from "@anthropic-ai/claude-agent-sdk";

for await (const message of query({
  prompt: "Find and fix the bug in auth.py",
  options: { allowedTools: ["Read", "Edit", "Bash"] }
})) {
  console.log(message);
}
```

**Source**: [overview.md](https://platform.claude.com/docs/en/agent-sdk/overview.md)

---

## 2. Installation & Setup

```bash
npm install @anthropic-ai/claude-agent-sdk
```

Requirements: Node.js 18+, Claude Code CLI installed globally.

```bash
export ANTHROPIC_API_KEY=your-api-key
```

**Source**: [quickstart.md](https://platform.claude.com/docs/en/agent-sdk/quickstart.md)

---

## 3. Core API — `query()`

```typescript
function query({
  prompt,   // string | AsyncIterable<SDKUserMessage>
  options   // Options
}): Query;  // extends AsyncGenerator<SDKMessage, void>
```

### Key Options (TypeScript)

| Option | Type | Description |
|--------|------|-------------|
| `allowedTools` | `string[]` | Pre-approved tools |
| `disallowedTools` | `string[]` | Blocked tools (overrides everything) |
| `permissionMode` | `string` | `"default"` / `"acceptEdits"` / `"bypassPermissions"` / `"dontAsk"` / `"plan"` |
| `systemPrompt` | `string \| object` | Custom or preset (`{ preset: "claude_code", append: "..." }`) |
| `settingSources` | `string[]` | `["user", "project", "local"]` to load CLAUDE.md, skills, hooks |
| `mcpServers` | `object` | MCP server configurations |
| `agents` | `object` | Subagent definitions |
| `hooks` | `object` | Hook callbacks per event |
| `canUseTool` | `function` | Approval callback |
| `maxTurns` | `number` | Max tool-use round trips |
| `maxBudgetUsd` | `number` | Max cost before stopping |
| `effort` | `string` | `"low"` / `"medium"` / `"high"` / `"max"` |
| `model` | `string` | Model ID override |
| `resume` | `string` | Session ID to resume |
| `continue` | `boolean` | Resume most recent session |
| `forkSession` | `boolean` | Fork from resumed session |
| `cwd` | `string` | Working directory |
| `plugins` | `array` | Plugin paths |
| `enableFileCheckpointing` | `boolean` | Track file changes |
| `includePartialMessages` | `boolean` | Stream text/tool deltas |
| `persistSession` | `boolean` | Save session to disk (default: true) |

### Query Object Methods

| Method | Description |
|--------|-------------|
| `[Symbol.asyncIterator]()` | Iterate messages |
| `setPermissionMode(mode)` | Change mode mid-session |
| `rewindFiles(checkpointId)` | Restore files to checkpoint |
| `close()` | Abort the query |

**Source**: [typescript.md](https://platform.claude.com/docs/en/agent-sdk/typescript.md)

---

## 4. Agent Loop

```
Prompt → Claude Evaluates → Tool Calls → Execute → Results → Repeat → Final Answer
```

1. **Receive prompt** → SDK yields `SystemMessage` (subtype `init`)
2. **Evaluate & respond** → SDK yields `AssistantMessage` (text + tool_use blocks)
3. **Execute tools** → SDK runs tools, yields `UserMessage` with results
4. **Repeat** (steps 2-3 = 1 turn)
5. **Return result** → SDK yields final `AssistantMessage` + `ResultMessage`

### Controls

| Control | Effect |
|---------|--------|
| `maxTurns` | Cap tool-use round trips |
| `maxBudgetUsd` | Cap spend |
| `effort` | Reasoning depth (`low`→`max`) |
| Hooks | Intercept/block/modify tools |

### Context Window

- Accumulates across turns (system prompt + tool defs + history)
- **Auto-compaction** when nearing limit → `SystemMessage` with `compact_boundary`
- CLAUDE.md content persists after compaction (re-injected each request)
- Subagents start fresh (only final result returns to parent)

**Source**: [agent-loop.md](https://platform.claude.com/docs/en/agent-sdk/agent-loop.md)

---

## 5. Message Types

| Type | Description |
|------|-------------|
| `SystemMessage` | Session lifecycle: `init`, `compact_boundary` |
| `AssistantMessage` | Claude's response (text + tool_use blocks) |
| `UserMessage` | Tool results, user inputs |
| `StreamEvent` | Raw streaming deltas (when `includePartialMessages: true`) |
| `ResultMessage` | Final message: `result`, `total_cost_usd`, `usage`, `session_id` |

### ResultMessage Subtypes

| Subtype | Meaning |
|---------|---------|
| `success` | Task completed, `result` field available |
| `error_max_turns` | Hit maxTurns limit |
| `error_max_budget_usd` | Hit budget limit |
| `error_during_execution` | API failure or cancellation |

**Source**: [agent-loop.md](https://platform.claude.com/docs/en/agent-sdk/agent-loop.md)

---

## 6. Permissions

### Evaluation Order

```
Hooks → Deny rules → Permission mode → Allow rules → canUseTool callback
```

- **Deny always wins** (even in `bypassPermissions`)

### Permission Modes

| Mode | Behavior |
|------|----------|
| `default` | Unmatched tools → `canUseTool` callback |
| `dontAsk` (TS only) | Deny anything not pre-approved |
| `acceptEdits` | Auto-approve file edits (Edit, Write, mkdir, rm, mv, cp) |
| `bypassPermissions` | All tools run without prompts (**propagates to subagents**) |
| `plan` | No tool execution, planning only |

### Allow/Deny Rules

```typescript
{
  allowedTools: ["Read", "Glob", "Grep"],        // Auto-approved
  disallowedTools: ["Bash"],                       // Always blocked
  permissionMode: "dontAsk"                        // Deny everything else
}
```

**Source**: [permissions.md](https://platform.claude.com/docs/en/agent-sdk/permissions.md)

---

## 7. Hooks

Callback functions that run at key execution points.

### Available Events

| Event | Description |
|-------|-------------|
| `PreToolUse` | Before tool executes (can block/modify) |
| `PostToolUse` | After tool result |
| `PostToolUseFailure` | After tool error |
| `UserPromptSubmit` | On prompt submission |
| `Stop` | On execution stop |
| `SubagentStart` / `SubagentStop` | Subagent lifecycle |
| `PreCompact` | Before context compaction |
| `PermissionRequest` | Permission dialog would show |
| `Notification` | Agent status messages |
| `SessionStart` / `SessionEnd` | TS only |

### Hook Structure

```typescript
hooks: {
  PreToolUse: [{
    matcher: "Write|Edit",    // Regex on tool name
    hooks: [myCallback],      // Callback array
    timeout: 60               // Seconds
  }]
}
```

### Callback Signature

```typescript
const myHook: HookCallback = async (input, toolUseID, { signal }) => {
  // Return {} to allow
  // Return { hookSpecificOutput: { permissionDecision: "deny", ... } } to block
  // Return { hookSpecificOutput: { updatedInput: {...} permissionDecision: "allow" } } to modify
  // Return { systemMessage: "..." } to inject context
  return {};
};
```

### Key Patterns

- **Block dangerous ops**: check `tool_input.file_path` for sensitive paths
- **Modify input**: return `updatedInput` + `permissionDecision: "allow"`
- **Auto-approve read-only**: return `permissionDecision: "allow"` for Read/Glob/Grep
- **Async side-effects**: return `{ async: true }` for logging/webhooks

**Source**: [hooks.md](https://platform.claude.com/docs/en/agent-sdk/hooks.md)

---

## 8. Sessions

### Approaches

| Scenario | Approach |
|----------|----------|
| Single prompt | One `query()` call |
| Multi-turn, same process | `continue: true` (TS) |
| Resume specific session | Pass `resume: sessionId` |
| Try alternative approach | `forkSession: true` |
| No disk persistence (TS) | `persistSession: false` |

### Capture Session ID

```typescript
for await (const message of query({ prompt: "..." })) {
  if (message.type === "result") {
    sessionId = message.session_id;
  }
}
```

### Resume

```typescript
for await (const message of query({
  prompt: "Follow-up question",
  options: { resume: sessionId }
})) { ... }
```

### Fork

```typescript
for await (const message of query({
  prompt: "Try different approach",
  options: { resume: sessionId, forkSession: true }
})) { ... }
```

Sessions stored at `~/.claude/projects/<encoded-cwd>/<session-id>.jsonl`.

**Source**: [sessions.md](https://platform.claude.com/docs/en/agent-sdk/sessions.md)

---

## 9. Subagents

Separate agent instances for isolated subtasks.

### Definition

```typescript
agents: {
  "code-reviewer": {
    description: "Expert code reviewer.",      // When to use
    prompt: "You are a code review specialist...",
    tools: ["Read", "Grep", "Glob"],           // Restricted toolset
    model: "sonnet"                            // Optional model override
  }
}
```

**Require `Agent` in `allowedTools`** for subagent invocation.

### Key Properties

- **Context isolation**: fresh conversation, only final message returns to parent
- **Parallelization**: multiple subagents can run concurrently
- **No nesting**: subagents cannot spawn their own subagents
- **Inherit**: project CLAUDE.md, tool definitions; NOT parent conversation or system prompt
- **Resumable**: capture `agentId` from messages, pass in subsequent resume

### Invocation

- **Automatic**: Claude matches task to description
- **Explicit**: `"Use the code-reviewer agent to check auth module"`

**Source**: [subagents.md](https://platform.claude.com/docs/en/agent-sdk/subagents.md)

---

## 10. MCP (Model Context Protocol)

Connect external tools via MCP servers.

### Transport Types

| Type | Config |
|------|--------|
| **stdio** | `{ command: "npx", args: [...], env: {...} }` |
| **HTTP/SSE** | `{ type: "http"/"sse", url: "https://...", headers: {...} }` |
| **SDK MCP** | In-process via `createSdkMcpServer()` |

### Tool Naming

Pattern: `mcp__<server-name>__<tool-name>`

```typescript
mcpServers: {
  github: {
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-github"],
    env: { GITHUB_TOKEN: process.env.GITHUB_TOKEN }
  }
},
allowedTools: ["mcp__github__list_issues"]  // or "mcp__github__*"
```

### Tool Search

Auto-enabled when MCP tools exceed 10% of context. Config via `ENABLE_TOOL_SEARCH` env var.

### Config File

`.mcp.json` at project root auto-loaded by SDK.

**Source**: [mcp.md](https://platform.claude.com/docs/en/agent-sdk/mcp.md)

---

## 11. Custom Tools

Build in-process MCP tools via `createSdkMcpServer()` + `tool()`.

```typescript
import { query, tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

const server = createSdkMcpServer({
  name: "my-tools",
  version: "1.0.0",
  tools: [
    tool(
      "get_weather",
      "Get temperature for coordinates",
      {
        latitude: z.number(),
        longitude: z.number()
      },
      async (args) => {
        const data = await fetch(`https://api.open-meteo.com/...`).then(r => r.json());
        return { content: [{ type: "text", text: `${data.current.temperature_2m}°F` }] };
      }
    )
  ]
});

// Requires streaming input mode (AsyncGenerator)
async function* messages() {
  yield { type: "user", message: { role: "user", content: "Weather in SF?" } };
}

for await (const msg of query({
  prompt: messages(),
  options: {
    mcpServers: { "my-tools": server },
    allowedTools: ["mcp__my-tools__get_weather"]
  }
})) { ... }
```

**Important**: Custom MCP tools require streaming input mode (async generator).

**Source**: [custom-tools.md](https://platform.claude.com/docs/en/agent-sdk/custom-tools.md)

---

## 12. Streaming

### Input Modes

| Mode | Description | Use case |
|------|-------------|----------|
| **Streaming** (recommended) | AsyncGenerator, persistent session | Interactive apps, image uploads, hooks |
| **Single Message** | String prompt | One-shot tasks, stateless lambdas |

### Output Streaming

Enable with `includePartialMessages: true`.

```typescript
for await (const message of query({
  prompt: "...",
  options: { includePartialMessages: true }
})) {
  if (message.type === "stream_event") {
    const event = message.event;
    if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
      process.stdout.write(event.delta.text);
    }
  }
}
```

### Stream Event Types

`message_start` → `content_block_start` → `content_block_delta` (text/tool chunks) → `content_block_stop` → `message_delta` → `message_stop`

**Sources**: [streaming-vs-single-mode.md](https://platform.claude.com/docs/en/agent-sdk/streaming-vs-single-mode.md), [streaming-output.md](https://platform.claude.com/docs/en/agent-sdk/streaming-output.md)

---

## 13. User Input & Approvals

### canUseTool Callback

```typescript
canUseTool: async (toolName, input) => {
  if (toolName === "AskUserQuestion") {
    // Handle clarifying questions
    return {
      behavior: "allow",
      updatedInput: { questions: input.questions, answers: { ... } }
    };
  }
  // Tool approval
  return { behavior: "allow", updatedInput: input };
  // or: { behavior: "deny", message: "Reason" }
}
```

### Responses

| Response | Effect |
|----------|--------|
| `{ behavior: "allow", updatedInput }` | Execute tool (can modify input) |
| `{ behavior: "deny", message }` | Block tool, Claude sees message |

### AskUserQuestion

- Claude generates questions with `options[]` (2-4 choices each)
- Return answers as `{ "question text": "selected label" }`
- Supports `multiSelect` (join labels with `", "`)
- Optional `previewFormat: "html"` or `"markdown"` for visual previews (TS)

**Source**: [user-input.md](https://platform.claude.com/docs/en/agent-sdk/user-input.md)

---

## 14. System Prompts & CLAUDE.md

### 4 Approaches

| Method | Persistence | Built-in tools |
|--------|-------------|----------------|
| **CLAUDE.md** | Per-project file | Preserved |
| **Output Styles** | Saved files | Preserved |
| **systemPrompt + append** | Session only | Preserved |
| **Custom systemPrompt** | Session only | **Lost** (unless included) |

### Default Behavior

SDK uses **minimal system prompt** by default. For full Claude Code behavior:

```typescript
systemPrompt: { type: "preset", preset: "claude_code" }
```

### CLAUDE.md

Loaded when `settingSources` includes `"project"` or `"user"`:

| Level | Location |
|-------|----------|
| Project root | `<cwd>/CLAUDE.md` or `<cwd>/.claude/CLAUDE.md` |
| Project rules | `<cwd>/.claude/rules/*.md` |
| Parent dirs | `CLAUDE.md` in dirs above cwd |
| User | `~/.claude/CLAUDE.md` |

**Source**: [modifying-system-prompts.md](https://platform.claude.com/docs/en/agent-sdk/modifying-system-prompts.md)

---

## 15. Skills, Slash Commands & Plugins

### Skills

Markdown files (`.claude/skills/<name>/SKILL.md`) auto-discovered when `settingSources` enabled.

```typescript
{
  settingSources: ["user", "project"],
  allowedTools: ["Skill", "Read", "Write", "Bash"]
}
```

- Model-invoked autonomously based on description
- No programmatic API — filesystem artifacts only

### Slash Commands

- Built-in: `/compact`, `/clear`, `/help`
- Custom: `.claude/commands/*.md` (legacy) or `.claude/skills/<name>/SKILL.md` (recommended)
- Support arguments (`$1`, `$2`, `$ARGUMENTS`), bash execution (`!`backtick``), file references (`@file`)

### Plugins

Load from local paths:

```typescript
plugins: [
  { type: "local", path: "./my-plugin" }
]
```

Plugin structure: `.claude-plugin/plugin.json` + `skills/`, `agents/`, `hooks/`, `.mcp.json`

Namespaced: `plugin-name:skill-name`

**Sources**: [skills.md](https://platform.claude.com/docs/en/agent-sdk/skills.md), [slash-commands.md](https://platform.claude.com/docs/en/agent-sdk/slash-commands.md), [plugins.md](https://platform.claude.com/docs/en/agent-sdk/plugins.md)

---

## 16. File Checkpointing

Track & rewind file changes (Write, Edit, NotebookEdit tools only).

### Enable

```typescript
{
  enableFileCheckpointing: true,
  permissionMode: "acceptEdits",
  extraArgs: { "replay-user-messages": null }  // Required for checkpoint UUIDs
}
```

### Capture Checkpoint

```typescript
for await (const message of response) {
  if (message.type === "user" && message.uuid) {
    checkpointId = message.uuid;  // First user message = restore point
  }
}
```

### Rewind

```typescript
const rewindQuery = query({
  prompt: "",
  options: { ...opts, resume: sessionId }
});
for await (const msg of rewindQuery) {
  await rewindQuery.rewindFiles(checkpointId);
  break;
}
```

**Limitations**: Bash changes not tracked; same session only; file content only.

**Source**: [file-checkpointing.md](https://platform.claude.com/docs/en/agent-sdk/file-checkpointing.md)

---

## 17. Cost Tracking

### Total Cost

```typescript
if (message.type === "result") {
  console.log(`Cost: $${message.total_cost_usd}`);
}
```

### Per-Model Breakdown (TS only)

```typescript
for (const [model, usage] of Object.entries(message.modelUsage)) {
  console.log(`${model}: $${usage.costUSD}, in=${usage.inputTokens}, out=${usage.outputTokens}`);
}
```

### Deduplication

Parallel tool calls share same `message.message.id` → deduplicate by ID.

### Cache Tokens

- `cache_creation_input_tokens`: higher rate (new cache entries)
- `cache_read_input_tokens`: reduced rate (cache hits)

**Source**: [cost-tracking.md](https://platform.claude.com/docs/en/agent-sdk/cost-tracking.md)

---

## 18. Hosting & Secure Deployment

### Deployment Patterns

| Pattern | Description |
|---------|-------------|
| **Ephemeral** | New container per task, destroy when done |
| **Long-Running** | Persistent container, multiple Claude processes |
| **Hybrid** | Ephemeral + hydrated from DB/session resume |
| **Single Container** | Multiple agents in one container |

### Requirements

- Node.js 18+ / Python 3.10+
- Claude Code CLI installed
- ~1 GiB RAM, 5 GiB disk, 1 CPU
- Outbound HTTPS to `api.anthropic.com`

### Sandbox Providers

Modal, Cloudflare Sandboxes, Daytona, E2B, Fly Machines, Vercel Sandbox

### Security

- **Isolation**: Containers (Docker), gVisor, VMs (Firecracker)
- **Credential management**: Proxy pattern (inject creds outside agent boundary)
- **Network**: `--network none` + Unix socket proxy for allowlisted domains
- **Filesystem**: Read-only mounts, tmpfs for writable areas

**Sources**: [hosting.md](https://platform.claude.com/docs/en/agent-sdk/hosting.md), [secure-deployment.md](https://platform.claude.com/docs/en/agent-sdk/secure-deployment.md)

---

## 19. TypeScript V2 Preview

> ⚠️ **Unstable** — APIs may change.

Simplified interface: `createSession()` → `send()` / `stream()`.

```typescript
import { unstable_v2_createSession } from "@anthropic-ai/claude-agent-sdk";

await using session = unstable_v2_createSession({ model: "claude-opus-4-6" });

await session.send("Hello!");
for await (const msg of session.stream()) {
  if (msg.type === "assistant") {
    console.log(msg.message.content.filter(b => b.type === "text").map(b => b.text).join(""));
  }
}

// Multi-turn: just call send() again
await session.send("Follow up question");
for await (const msg of session.stream()) { ... }
```

Also: `unstable_v2_prompt()` for one-shot, `unstable_v2_resumeSession()` for resume.

**Source**: [typescript-v2-preview.md](https://platform.claude.com/docs/en/agent-sdk/typescript-v2-preview.md)

---

## 20. PPM Integration Notes

PPM uses `@anthropic-ai/claude-agent-sdk` in `src/providers/claude-agent-sdk.ts`.

### Current Usage

- `query()` V1 API with streaming input (AsyncGenerator)
- `canUseTool` callback for tool approvals + AskUserQuestion → WebSocket events to frontend
- `listSessions()` / `getSessionMessages()` for session management
- Sessions persisted by SDK at `~/.claude/projects/`

### Key Considerations

| Area | Recommendation |
|------|---------------|
| **System prompt** | SDK default is minimal; use `{ preset: "claude_code" }` if full behavior needed |
| **Settings sources** | Set `settingSources: ["project"]` to load project CLAUDE.md, skills, hooks |
| **Custom tools** | Use `createSdkMcpServer()` + `tool()` for PPM-specific tools (file tree, git, etc.) |
| **Streaming output** | `includePartialMessages: true` for real-time chat UI |
| **File checkpointing** | Enable for undo/redo in editor; track Write/Edit changes |
| **Cost tracking** | Read `total_cost_usd` from ResultMessage for usage dashboard |
| **Session resume** | Capture `session_id` for chat history persistence across restarts |
| **Subagents** | Define specialized agents (reviewer, tester) via `agents` param |
| **V2 Preview** | Monitor for stable release; `send()`/`stream()` pattern cleaner for chat UIs |
| **SDK .env poisoning** | Provider must neutralize `ANTHROPIC_API_KEY` from project `.env` files (see `docs/lessons-learned.md`) |

### Gotchas

1. **Custom MCP tools require streaming input** (async generator, not string prompt)
2. **`allowedTools` does NOT constrain `bypassPermissions`** — use `disallowedTools` to block specific tools
3. **Subagents cannot nest** — no `Agent` in subagent's `tools` array
4. **`dontAsk` mode is TypeScript-only** — Python uses `disallowedTools` instead
5. **Tool name was renamed** from `"Task"` to `"Agent"` in v2.1.63 — check both for compatibility
6. **Session files are local** — can't resume across hosts without moving `.jsonl` files

---

## Quick Links

| Doc | URL |
|-----|-----|
| Overview | https://platform.claude.com/docs/en/agent-sdk/overview.md |
| Quickstart | https://platform.claude.com/docs/en/agent-sdk/quickstart.md |
| TypeScript Reference | https://platform.claude.com/docs/en/agent-sdk/typescript.md |
| Python Reference | https://platform.claude.com/docs/en/agent-sdk/python.md |
| Agent Loop | https://platform.claude.com/docs/en/agent-sdk/agent-loop.md |
| Permissions | https://platform.claude.com/docs/en/agent-sdk/permissions.md |
| Hooks | https://platform.claude.com/docs/en/agent-sdk/hooks.md |
| Sessions | https://platform.claude.com/docs/en/agent-sdk/sessions.md |
| Subagents | https://platform.claude.com/docs/en/agent-sdk/subagents.md |
| MCP | https://platform.claude.com/docs/en/agent-sdk/mcp.md |
| Custom Tools | https://platform.claude.com/docs/en/agent-sdk/custom-tools.md |
| Streaming Input | https://platform.claude.com/docs/en/agent-sdk/streaming-vs-single-mode.md |
| Streaming Output | https://platform.claude.com/docs/en/agent-sdk/streaming-output.md |
| User Input | https://platform.claude.com/docs/en/agent-sdk/user-input.md |
| System Prompts | https://platform.claude.com/docs/en/agent-sdk/modifying-system-prompts.md |
| Skills | https://platform.claude.com/docs/en/agent-sdk/skills.md |
| Slash Commands | https://platform.claude.com/docs/en/agent-sdk/slash-commands.md |
| Plugins | https://platform.claude.com/docs/en/agent-sdk/plugins.md |
| Claude Code Features | https://platform.claude.com/docs/en/agent-sdk/claude-code-features.md |
| File Checkpointing | https://platform.claude.com/docs/en/agent-sdk/file-checkpointing.md |
| Cost Tracking | https://platform.claude.com/docs/en/agent-sdk/cost-tracking.md |
| Hosting | https://platform.claude.com/docs/en/agent-sdk/hosting.md |
| Secure Deployment | https://platform.claude.com/docs/en/agent-sdk/secure-deployment.md |
| TS V2 Preview | https://platform.claude.com/docs/en/agent-sdk/typescript-v2-preview.md |
| Example Agents | https://github.com/anthropics/claude-agent-sdk-demos |
| TS Changelog | https://github.com/anthropics/claude-agent-sdk-typescript/blob/main/CHANGELOG.md |
| Python Changelog | https://github.com/anthropics/claude-agent-sdk-python/blob/main/CHANGELOG.md |
