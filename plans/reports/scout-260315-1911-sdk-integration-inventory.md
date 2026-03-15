# Claude Agent SDK Integration Inventory

**Date:** 2026-03-15  
**Codebase:** PPM (Project & Process Manager)  
**Scope:** Complete audit of @anthropic-ai/claude-agent-sdk integration

---

## Executive Summary

PPM implements comprehensive Claude Agent SDK integration across backend, frontend, and CLI. The system features:
- **Real streaming** multi-turn chat via WebSocket with SDK query sessions
- **Tool approval workflow** using AskUserQuestion with request/response pattern
- **Multi-provider architecture** (SDK default, CLI fallback, mock for testing)
- **Rate-limit tracking** via ccburn tool for usage visualization
- **Skills & commands** discovery from ~/.claude and ./.claude directories
- **Session persistence** managed by SDK (~/.claude/projects/)
- **Error handling** for aborts, tool results, and approval timeouts

---

## Core Implementation Files

### 1. Provider: Claude Agent SDK (`src/providers/claude-agent-sdk.ts`)
**Lines:** 512 | **Responsibility:** SDK integration layer, session management, streaming

#### Key Features:

**SDK Query Options (lines 209-235):**
```typescript
query({
  prompt: message,
  options: {
    sessionId: isFirstMessage ? sessionId : undefined,  // First msg creates session
    resume: isFirstMessage ? undefined : sessionId,      // Subsequent msgs resume
    cwd: meta.projectPath,                               // Skills context
    env: { ...process.env, ANTHROPIC_*: "" },           // Override .env vars
    settings: { permissions: { allow: [], deny: [] } }, // Bypass project restrictions
    allowedTools: [
      "Read", "Write", "Edit", "Bash", "Glob", "Grep",
      "WebSearch", "WebFetch", "AskUserQuestion",
    ],
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
    canUseTool,        // Custom approval callback
    includePartialMessages: true,
  }
})
```

**Event Processing (lines 244-392):**
- `partial` / `stream_event`: Text delta streaming (lines 282-310)
- `assistant`: Full message parsing, tool_use detection (lines 313-337)
- `tool_use`: Yields tool block with name/input (lines 325-332)
- `tool_result`: Fetched from session history via getSessionMessages (lines 256-277)
- `rate_limit_event`: Extracts five_hour/seven_day utilization (lines 340-355)
- `result`: Final message with total_cost_usd (lines 357-391)

**Tool Approval Callback (lines 171-204):**
- Only fires for `AskUserQuestion` (bypassPermissions auto-approves other tools)
- Creates promise-based approval: yields `approval_request` event → waits for FE response
- Merges user answers into tool input via `updatedInput`
- Supports reject via "User skipped the question"

**Session Management:**
- `createSession()` (lines 42-55): Creates UUID, tracks in activeSessions Map
- `resumeSession()` (lines 57-88): Loads from SDK via listSessions or creates fallback
- `ensureProjectPath()` (lines 124-129): Backfills projectPath for skills support
- `listSessionsByDir()` (lines 94-113): Filters by project directory (used by chat routes)

**Message History (lines 425-450):**
- `getMessages()`: Fetches from SDK via getSessionMessages
- Merges tool_result-only messages into preceding assistant message
- Parses content blocks into ChatEvent array

**Abort Support (lines 416-423):**
- `abortQuery()`: Calls close() on active query object
- Tracked in activeQueries Map for lookup

**Usage Tracking (lines 339-355, 411-414):**
- Captures rate_limit_event utilization percentages
- Caches in latestUsage (shared across sessions)
- Returns via `getUsage()`

---

### 2. WebSocket Chat Handler (`src/server/ws/chat.ts`)
**Lines:** 146 | **Responsibility:** Real-time message streaming, approvals, session lifecycle

#### Protocol:

**Client → Server Messages:**
- `{ type: "message", content: string }` — Send user message
- `{ type: "cancel" }` — Request abort
- `{ type: "approval_response", requestId, approved, data }` — Answer AskUserQuestion

**Server → Client Events:**
- `{ type: "text", content: string }` — Streaming text delta
- `{ type: "tool_use", tool, input, toolUseId }` — Tool execution
- `{ type: "tool_result", output, isError, toolUseId }` — Tool result
- `{ type: "approval_request", requestId, tool, input }` — Need user input
- `{ type: "usage", usage }` — Rate limit / cost info
- `{ type: "error", message }` — Error event
- `{ type: "done", sessionId }` — Stream complete

#### Lifecycle:

**open() (lines 25-52):**
- Resolves projectPath from projectName
- Backfills session.projectPath for skills
- Starts 15s keepalive ping (WebSocket idle timeout protection)
- Sends `connected` event to FE

**message() (lines 54-124):**
- `type: "message"`: Resume provider session → backfill projectPath → iterate chatService.sendMessage()
  - AbortController cancels stream if WS closes
- `type: "cancel"`: Calls provider.abortQuery() (SDK query.close())
- `type: "approval_response"`: Routes to provider.resolveApproval()

**close() (lines 126-145):**
- Clears keepalive ping
- Aborts AbortController to break for-await loop
- Calls provider.abortQuery() to stop SDK work

---

### 3. Chat Service (`src/services/chat.service.ts`)
**Lines:** 111 | **Responsibility:** Provider abstraction, session routing

#### Key Methods:

**sendMessage() (lines 69-80):**
- Routes to provider.sendMessage(sessionId, message)
- Yields ChatEvent stream directly

**listSessions() (lines 32-58):**
- Supports `dir` parameter for directory-filtered listing
- SDK provider implements `listSessionsByDir()` for project filtering
- Aggregates across all providers if providerId not specified

**getSession() (lines 82-98):**
- Lookup across all providers for WS handler
- Handles SDK's internal storage format (meta + sdk object)

---

### 4. Frontend Chat Hook (`src/web/hooks/use-chat.ts`)
**Lines:** 424 | **Responsibility:** React state management, approval UI, streaming integration

#### State Management:

```typescript
messages: ChatMessage[]
isStreaming: boolean
pendingApproval: { requestId, tool, input } | null
usageInfo: { totalCostUsd?, queryCostUsd?, fiveHour?, sevenDay?, ...limits }
isConnected: boolean
```

#### Event Handling (lines 41-227):

- **text**: Accumulates streaming text, updates last assistant message
- **tool_use**: Appends to assistant message events
- **tool_result**: Appends result block (shows tool output)
- **approval_request**: Sets pendingApproval state (triggers UI modal)
- **usage**: Merges usage info (accumulates totalCostUsd)
- **error**: Converts to system message with error event
- **done**: Finalizes assistant message, flushes queued message

#### Message Queueing:

- If user sends while streaming: queues in pendingMessageRef
- On stream done: auto-flushes queued message

#### Approval Flow:

```typescript
respondToApproval(requestId, approved, data):
  1. Send { type: "approval_response", requestId, approved, data } via WS
  2. Merge answers into AskUserQuestion tool_use event.input.answers
  3. Force re-render messages
  4. Clear pendingApproval
```

#### Usage Fetching:

- On session change: GET `/chat/usage?providerId=...` (cached rate limits)
- On demand: refreshUsage() (adds _t param for cache-bust)

---

### 5. HTTP Chat Routes (`src/server/routes/chat.ts`)
**Lines:** 154 | **Responsibility:** REST API for sessions, uploads, usage

#### Endpoints:

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/chat/slash-items` | List available skills & commands |
| GET | `/chat/usage` | Fetch rate-limit info via ccburn |
| GET | `/chat/providers` | List registered providers |
| GET | `/chat/sessions` | List sessions (optionally filtered by project) |
| GET | `/chat/sessions/:id/messages` | Load message history |
| POST | `/chat/sessions` | Create new session with projectPath |
| DELETE | `/chat/sessions/:id` | Delete session |
| POST | `/chat/upload` | Upload files (returns tmpdir paths) |
| GET | `/chat/uploads/:filename` | Serve uploaded files |

#### Rate Limits Integration:

```typescript
GET /chat/usage:
  Calls fetchClaudeUsage() via ccburn
  Returns: { fiveHour, sevenDay, session?, weekly?, weeklyOpus?, weeklySonnet? }
```

---

## Type Definitions

### ChatEvent Union (`src/types/chat.ts`)

```typescript
type ChatEvent =
  | { type: "text"; content: string }
  | { type: "tool_use"; tool: string; input: unknown; toolUseId?: string }
  | { type: "tool_result"; output: string; isError?: boolean; toolUseId?: string }
  | { type: "approval_request"; requestId: string; tool: string; input: unknown }
  | { type: "usage"; usage: UsageInfo }
  | { type: "error"; message: string }
  | { type: "done"; sessionId: string }
```

### UsageInfo (`src/types/chat.ts`)

```typescript
interface UsageInfo {
  totalCostUsd?: number          // Cumulative cost across session
  queryCostUsd?: number          // Cost of last query only
  fiveHour?: number              // 0–1 utilization
  sevenDay?: number              // 0–1 utilization
  fiveHourResetsAt?: string      // ISO timestamp
  sevenDayResetsAt?: string      // ISO timestamp
  session?: LimitBucket          // Detailed rate limit info
  weekly?: LimitBucket
  weeklyOpus?: LimitBucket
  weeklySonnet?: LimitBucket
}
```

### Session Types (`src/types/chat.ts`)

```typescript
interface Session {
  id: string
  providerId: string
  title: string
  projectName?: string
  projectPath?: string           // Set by WS handler for skills support
  createdAt: string
}
```

---

## Provider Registry (`src/providers/registry.ts`)

**Order & Defaults:**
1. `ClaudeAgentSdkProvider` (default) — Real SDK, full capabilities
2. `ClaudeCodeCliProvider` — Fallback, spawns claude CLI
3. `MockProvider` — Testing only

**Provider Interface:**
```typescript
interface AIProvider {
  id: string
  name: string
  createSession(config: SessionConfig): Promise<Session>
  resumeSession(sessionId: string): Promise<Session>
  listSessions(): Promise<SessionInfo[]>
  deleteSession(sessionId: string): Promise<void>
  sendMessage(sessionId: string, message: string): AsyncIterable<ChatEvent>
  resolveApproval?(requestId: string, approved: boolean, data?: unknown): void
}
```

---

## Skills & Commands Discovery (`src/services/slash-items.service.ts`)

**Sources (merged, project overrides user):**
1. User-global: `~/.claude/commands/` and `~/.claude/skills/`
2. Project-local: `./.claude/commands/` and `./.claude/skills/`

**File Parsing:**
- Commands: `.md` files with frontmatter (name, description, argument-hint)
- Skills: `SKILL.md` files (strict) or loose `.md` files (relaxed)

**Directory Structure Example:**
```
~/.claude/
├── skills/
│   ├── research/SKILL.md
│   └── debug/SKILL.md
└── commands/
    └── devops/deploy.md
```

**Exposed via:** `/chat/slash-items` endpoint (used by command palette UI)

---

## Usage Rate-Limits (`src/services/claude-usage.service.ts`)

**Fetcher:** `fetchClaudeUsage()` — Spawns `ccburn --json` CLI

**Cache:**
- TTL: 30 seconds
- Parsed limits: session, weekly, weeklyOpus, weeklySonnet
- Each bucket: { utilization, budgetPace, resetsAt, resetsInMinutes, resetsInHours, windowHours, status }

**Exposed via:** `/chat/usage` endpoint (frontend polls on connect & demand)

---

## Test Coverage

### Unit Tests

**`tests/unit/providers/claude-agent-sdk.test.ts`** (340 lines)
- Mock SDK query() function
- Tests: text streaming, tool_use events, error handling, abort, sessionId vs resume
- Validates approval callback (not directly tested, awaits FE response)

**Key Test Cases:**
- ✅ Partial message streaming (text deltas)
- ✅ Tool_use event parsing
- ✅ Empty response handling (always yields done)
- ✅ Error events (non-abort errors)
- ✅ Abort behavior (closes query, no error event)
- ✅ sessionId vs resume logic (first msg creates, subsequent resume)

### Integration Tests

**`tests/integration/claude-agent-sdk-integration.test.ts`** (233 lines)
- Real SDK calls (not mocked)
- Tests: message streaming, multi-turn context, session resume, listSessions, getSessionMessages
- Creates temp directory to avoid polluting real SDK sessions

**Key Test Cases:**
- ✅ Query returns init + assistant + result
- ✅ Resume continues context across turns
- ✅ listSessions() returns session metadata
- ✅ getSessionMessages() returns transcript
- ✅ Multi-turn conversations preserve context

**`tests/integration/ws-chat-project-path.test.ts`**
- Tests: projectPath backfilling for skills support

**`tests/integration/api/chat-routes.test.ts`**
- Tests: HTTP endpoints (sessions, messages, usage)

---

## Data Flow Examples

### 1. Single-turn Query

```
User → FE Chat Input
  ↓
sendMessage() → WS "message" event
  ↓
WS handler → resumeSession() → backfill projectPath
  ↓
chatService.sendMessage() → SDK query() with resume
  ↓
SDK yields: partial → text → assistant → result
  ↓
Provider yields: text → tool_use → usage → done
  ↓
WS streams: { type: "text", ... } → { type: "done", ... }
  ↓
FE useChat → setMessages() → accumulates message
```

### 2. Tool Execution Flow

```
SDK yields: assistant (with tool_use block)
  ↓
Provider parses tool_use → yields { type: "tool_use", tool, input, toolUseId }
  ↓
SDK executes tool internally (Bash, Read, etc.) with cwd
  ↓
SDK yields: partial/stream_event (while tool runs)
  ↓
When tool finishes: SDK yields assistant/result again
  ↓
Provider fetches getSessionMessages() → extracts tool_result blocks
  ↓
Provider yields: { type: "tool_result", output, isError, toolUseId }
  ↓
FE displays tool output alongside assistant message
```

### 3. Approval (AskUserQuestion)

```
User prompt includes question for Claude
  ↓
SDK calls canUseTool("AskUserQuestion", { questions: [...] })
  ↓
Provider creates requestId, yields: { type: "approval_request", requestId, input }
  ↓
Provider pauses: awaits pendingApprovals[requestId].resolve()
  ↓
FE shows modal with questions, user provides answers
  ↓
FE sends: { type: "approval_response", requestId, approved: true, data: answers }
  ↓
WS handler calls provider.resolveApproval(requestId, true, answers)
  ↓
Provider resumes: resolves promise → returns { behavior: "allow", updatedInput }
  ↓
SDK continues with answers merged into tool input
  ↓
SDK returns: assistant (with tool_use), then tool executes
```

### 4. Multi-turn Conversation

```
Turn 1:
  query({ sessionId, prompt: "Remember: color=purple" })
  → SDK stores in ~/.claude/projects/
  
Turn 2:
  query({ resume: sessionId, prompt: "What color?" })
  → SDK loads history from disk
  → Passes as context to Claude
  → Claude responds: "purple"
```

---

## Configuration & Environment

### SDK Option Overrides

**Neutralize Project .env:**
```typescript
env: {
  ...process.env,
  ANTHROPIC_API_KEY: "",      // Prevent .env poisoning
  ANTHROPIC_BASE_URL: "",
  ANTHROPIC_AUTH_TOKEN: "",
}
```
*Reason:* Projects with ANTHROPIC_API_KEY in .env break SDK (uses project keys instead of subscription). Provider neutralizes to force subscription usage.

**Bypass Project Settings:**
```typescript
settings: { permissions: { allow: [], deny: [] } },
settingSources: [],
permissionMode: "bypassPermissions",
allowDangerouslySkipPermissions: true
```
*Reason:* Projects' .claude/settings.local.json can restrict tools. PPM bypasses to ensure full SDK capabilities.

**Allowed Tools (Whitelist):**
```typescript
allowedTools: [
  "Read", "Write", "Edit", "Bash", "Glob", "Grep",
  "WebSearch", "WebFetch", "AskUserQuestion",
]
```
*Reason:* Only these tools supported; others auto-rejected.

### Session Persistence

- Managed entirely by SDK: `~/.claude/projects/<cwd>/<sessionId>/`
- PPM never saves sessions to disk (SDK owns persistence)
- Resume via sessionId: SDK reloads history from disk

---

## Known Limitations & Gotchas

1. **Tool Results Fetching**: Tool_result blocks only appear after tool executes. Provider must call getSessionMessages() to retrieve them from session history (lines 256-277). Raw SDK events don't expose tool results directly.

2. **Partial Message Type**: Provider handles both `partial` (legacy type) and `stream_event` (current). Text deltas computed by comparing lastPartialText (lines 240, 303-307).

3. **Approval Pause**: When canUseTool() awaits approval, entire SDK query pauses. Long-running tools can't return results until FE sends approval_response. No timeout implemented—infinite wait if FE disconnects.

4. **Session Auto-Resume**: If session doesn't exist, resumeSession() creates a fallback entry instead of erroring. This means sendMessage() always succeeds, even for invalid sessionIds (lines 147-149).

5. **Message Merging**: Tool_result-only messages are merged into preceding assistant message (lines 430-440). This loses transaction boundaries but improves UI UX.

6. **Cost Tracking**: total_cost_usd only populated in result event. Partial messages don't include cost—cost only known at stream end.

---

## Summary Statistics

| File | Lines | Purpose |
|------|-------|---------|
| src/providers/claude-agent-sdk.ts | 512 | SDK provider impl |
| src/server/ws/chat.ts | 146 | WS protocol handler |
| src/services/chat.service.ts | 111 | Provider router |
| src/web/hooks/use-chat.ts | 424 | React state mgmt |
| src/server/routes/chat.ts | 154 | HTTP endpoints |
| src/services/slash-items.service.ts | 185 | Skills discovery |
| src/services/claude-usage.service.ts | 114 | Rate-limit fetcher |
| src/types/chat.ts | 93 | Type definitions |
| **Total** | **1739** | **Core SDK integration** |

---

## Features Implemented

✅ Real-time streaming via query() with async generator  
✅ Multi-turn via sessionId (first) + resume (subsequent)  
✅ Tool execution with Bash, Read, Write, Edit, Glob, Grep, WebSearch, WebFetch  
✅ Tool approval via AskUserQuestion + approval_request/response pattern  
✅ Rate-limit tracking (five_hour, seven_day utilization)  
✅ Cost tracking (total_cost_usd per query)  
✅ Session persistence via SDK (~/.claude/projects/)  
✅ Project directory filtering for multi-project UX  
✅ Skills & commands discovery from ~/.claude and ./.claude  
✅ WebSocket real-time streaming with keepalive ping  
✅ Message history loading via getSessionMessages()  
✅ Abort support via query.close()  
✅ Error handling (yields error event on non-abort errors)  
✅ Multi-provider abstraction (SDK default, CLI fallback, mock for tests)  

---

## NOT Implemented

❌ MCP servers (Protocol Designer, GitHub, etc.) — Not exposed in SDK options  
❌ Custom tools beyond SDK's built-ins  
❌ Subagent spawning / Task delegation (no Task tool calls)  
❌ Approval timeout (waits indefinitely)  
❌ Session deletion from disk (only in-memory cleanup)  
❌ Streaming to file / export  
❌ WebSocket message compression  
❌ Tool retry logic  
❌ Rate-limit preemption (only displays limits)

