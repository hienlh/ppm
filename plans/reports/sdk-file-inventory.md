# SDK Integration File Inventory

## Files Scout Report

### Generated: 2026-03-15

---

## Core SDK Integration (8 files, 1739 LOC)

### 1. Provider Implementation
- **`src/providers/claude-agent-sdk.ts`** (512 lines)
  - ClaudeAgentSdkProvider class
  - query() integration with async generators
  - Session management (create, resume, list, delete)
  - Event transformation (text, tool_use, tool_result, approval_request, usage, error)
  - Tool approval callback (canUseTool)
  - Message history loading (getSessionMessages)
  - Abort/cancel support (query.close())
  - Usage tracking (rate_limit_event, result cost)

### 2. WebSocket Handler
- **`src/server/ws/chat.ts`** (146 lines)
  - chatWebSocket handler for Bun.serve()
  - open(): Session lifecycle, projectPath backfilling, keepalive ping
  - message(): Route message/cancel/approval_response to provider
  - close(): Cleanup, abort, ping interval clear
  - WS protocol: client messages (message, cancel, approval_response)
  - WS protocol: server events (text, tool_use, tool_result, approval_request, usage, error, done)

### 3. Chat Service
- **`src/services/chat.service.ts`** (111 lines)
  - ChatService class for provider abstraction
  - sendMessage(): Route to provider async generator
  - listSessions(): Support dir-filtered listing (SDK provider only)
  - createSession(): Provider-agnostic session creation
  - deleteSession(): Provider cleanup
  - getMessages(): Load message history
  - getSession(): Lookup by sessionId across providers

### 4. React Hook
- **`src/web/hooks/use-chat.ts`** (424 lines)
  - useChat() hook for chat state management
  - WebSocket integration (useWebSocket)
  - Message accumulation state
  - Approval request handling (pendingApproval)
  - Usage info tracking
  - handleMessage(): Event handler for all WS events
  - sendMessage(): User message handler with message queueing
  - respondToApproval(): Approval response with answer merging
  - cancelStreaming(): Request abort
  - refreshUsage(): On-demand usage fetch
  - Message history loading on session change
  - Usage info caching

### 5. HTTP Routes
- **`src/server/routes/chat.ts`** (154 lines)
  - GET /chat/slash-items — Skills discovery
  - GET /chat/usage — Rate-limit fetching (ccburn)
  - GET /chat/providers — Provider registry listing
  - GET /chat/sessions — Session list (project-filtered)
  - GET /chat/sessions/:id/messages — Message history
  - POST /chat/sessions — Create session
  - DELETE /chat/sessions/:id — Delete session
  - POST /chat/upload — File upload
  - GET /chat/uploads/:filename — File serving

### 6. Type Definitions
- **`src/types/chat.ts`** (93 lines)
  - ChatEvent union: text | tool_use | tool_result | approval_request | usage | error | done
  - UsageInfo interface: cost, rate limits, reset times, detailed buckets
  - Session interface: id, providerId, title, projectName, projectPath, createdAt
  - SessionConfig interface: providerId, projectName, projectPath, title
  - SessionInfo interface: id, providerId, title, projectName, createdAt, updatedAt
  - AIProvider interface: (re-exports from provider.interface)
  - LimitBucket interface: utilization, budgetPace, resetsAt, resetsInMinutes, resetsInHours, windowHours, status
  - ToolApprovalHandler type

### 7. Provider Registry
- **`src/providers/registry.ts`** (46 lines)
  - ProviderRegistry class
  - Register ClaudeAgentSdkProvider (default)
  - Register ClaudeCodeCliProvider (fallback)
  - Register MockProvider (testing)
  - list(), get(), getDefault() methods

### 8. Provider Interface
- **`src/providers/provider.interface.ts`** (15 lines)
  - AIProvider interface definition
  - Session, SessionConfig, SessionInfo types
  - ChatEvent, ChatMessage types
  - resolveApproval() optional method
  - onToolApproval() optional method

---

## Supporting Services (2 files, 299 LOC)

### 9. Skills & Commands Discovery
- **`src/services/slash-items.service.ts`** (185 lines)
  - SlashItem interface: type (skill|command), name, description, scope
  - listSlashItems(projectPath): Scan ~/.claude and ./.claude
  - collectSkills(): Parse SKILL.md + loose .md files
  - collectCommands(): Parse commands/*.md files
  - parseFrontmatter(): YAML frontmatter extraction
  - walkDir(): Recursive directory traversal
  - Project overrides user items by name

### 10. Rate-Limit Fetcher
- **`src/services/claude-usage.service.ts`** (114 lines)
  - fetchClaudeUsage(): Spawn ccburn --json CLI
  - ClaudeUsage interface: session, weekly, weeklyOpus, weeklySonnet
  - LimitBucket parsing
  - 30-second cache with TTL
  - getCcburnPath(): Binary resolution (node_modules/.bin/ccburn)

---

## Testing (6 files, 573 LOC)

### Unit Tests
- **`tests/unit/providers/claude-agent-sdk.test.ts`** (340 lines)
  - Mock SDK query() function
  - Test cases:
    - Partial message streaming (text deltas)
    - Tool_use event parsing
    - Empty response handling (always yields done)
    - Error events (non-abort)
    - Abort behavior (calls close(), no error)
    - sessionId vs resume logic (first msg creates, subsequent resumes)
    - Abort cancellation (mid-stream)
    - Abort error suppression (checks "abort" in message)
    - Abort no-op when no active query
    - Active query cleanup after stream

- **`tests/unit/providers/mock-provider.test.ts`**
  - Mock provider testing

- **`tests/unit/services/chat-service.test.ts`**
  - Chat service routing

### Integration Tests
- **`tests/integration/claude-agent-sdk-integration.test.ts`** (233 lines)
  - Real SDK calls (not mocked)
  - Test cases:
    - query() returns init + assistant + result
    - listSessions() returns metadata
    - getSessionMessages() returns transcript
    - Multi-turn conversation (resume maintains context)
    - Auto-resume non-existent session
    - Session deletion
  - Temp directory isolation

- **`tests/integration/ws-chat-project-path.test.ts`**
  - WebSocket projectPath backfilling

- **`tests/integration/api/chat-routes.test.ts`**
  - HTTP endpoint testing
  - Sessions, messages, usage endpoints

---

## Frontend Components (4 files interact with useChat)

### Chat UI Components
- **`src/web/components/chat/chat-tab.tsx`**
  - Chat interface tab
  - Uses: useChat hook
  - Displays: message list, input, approval modal

- **`src/web/components/chat/message-list.tsx`**
  - Message rendering
  - Tool use cards (Bash, Read, etc.)
  - Tool result display
  - Streaming animation

- **`src/web/components/chat/message-input.tsx`**
  - User input field
  - Send button
  - Slash command picker

- **`src/web/components/chat/slash-command-picker.tsx`**
  - Slash command autocomplete
  - Skills discovery integration
  - Uses: /chat/slash-items endpoint

---

## Configuration & Setup

### Entry Points
- **`src/index.ts`** (60 lines)
  - CLI program setup
  - Command definitions

- **`src/server/index.ts`**
  - Server initialization
  - Hono routes registration
  - WebSocket handler registration

---

## Data Flow Integration Points

### Request Path: User Message → SDK Query
```
FE: useChat.sendMessage(content)
  ↓
WS: chatWebSocket.message({ type: "message", content })
  ↓
Backend: chatService.sendMessage(providerId, sessionId, content)
  ↓
Provider: ClaudeAgentSdkProvider.sendMessage()
  ↓ (async generator)
SDK: query({ prompt, options: { resume, cwd, canUseTool, ... } })
```

### Response Path: SDK Event → Frontend
```
SDK: yields partial/assistant/rate_limit_event/result
  ↓
Provider: transforms to ChatEvent
  ↓
WS: sends JSON to client
  ↓
FE: useChat.handleMessage()
  ↓
React: setMessages() updates UI
```

### Approval Path: User Answer → SDK Continuation
```
FE: respondToApproval(requestId, approved, data)
  ↓
WS: send({ type: "approval_response", ... })
  ↓
Backend: provider.resolveApproval(requestId, ..., data)
  ↓
Provider: resolves pendingApprovals[requestId] promise
  ↓
SDK: canUseTool() returns { behavior: "allow", updatedInput }
  ↓
SDK: continues query execution with answers
```

---

## Dependency Map

```
Frontend
├── useChat (hooks/use-chat.ts)
│   ├── useWebSocket (hooks/use-websocket.ts)
│   ├── fetch: /chat/sessions/:id/messages
│   └── fetch: /chat/usage
│
└── Chat Components
    ├── message-list.tsx
    ├── message-input.tsx
    ├── slash-command-picker.tsx
    └── fetch: /chat/slash-items

Backend
├── chatWebSocket (server/ws/chat.ts)
│   ├── chatService (services/chat.service.ts)
│   │   └── ClaudeAgentSdkProvider (providers/claude-agent-sdk.ts)
│   │       ├── query() from @anthropic-ai/claude-agent-sdk
│   │       ├── listSessions() from SDK
│   │       ├── getSessionMessages() from SDK
│   │       └── fetchClaudeUsage() from claude-usage.service.ts
│   │
│   └── providerRegistry (providers/registry.ts)
│       ├── ClaudeAgentSdkProvider
│       ├── ClaudeCodeCliProvider
│       └── MockProvider
│
└── chatRoutes (server/routes/chat.ts)
    ├── chatService
    ├── providerRegistry
    ├── listSlashItems() from slash-items.service.ts
    ├── fetchClaudeUsage() from claude-usage.service.ts
    └── file upload/serving

Services
├── chat.service.ts
│   └── AIProvider interface (types/chat.ts)
│
├── slash-items.service.ts
│   └── listSlashItems(projectPath)
│
└── claude-usage.service.ts
    └── fetchClaudeUsage() → ccburn CLI
```

---

## Summary Table

| Category | Files | Lines | Purpose |
|----------|-------|-------|---------|
| **Provider** | 1 | 512 | SDK query, events, sessions |
| **WebSocket** | 1 | 146 | Real-time streaming protocol |
| **Service** | 1 | 111 | Provider routing |
| **Hook** | 1 | 424 | React state & streaming |
| **Routes** | 1 | 154 | HTTP REST API |
| **Types** | 1 | 93 | Type definitions |
| **Registry** | 1 | 46 | Provider factory |
| **Interface** | 1 | 15 | AIProvider contract |
| **Subtotal: Core** | **8** | **1501** | **SDK integration** |
| | | | |
| **Skills** | 1 | 185 | Slash commands discovery |
| **Usage** | 1 | 114 | Rate limits fetcher |
| **Subtotal: Services** | **2** | **299** | **Supporting** |
| | | | |
| **Unit Tests** | 1 | 340 | Provider unit tests |
| **Integration** | 2 | 233 | Real SDK tests |
| **Subtotal: Tests** | **3** | **573** | **Coverage** |
| | | | |
| **Components** | 4 | ~500 | Chat UI (approx) |
| **TOTAL** | **~20** | **~2873** | **Full stack** |

---

## Exposed Endpoints

### WebSocket
```
WS /ws/project/{projectName}/chat/{sessionId}
  ← { type: "message", content }
  ← { type: "cancel" }
  ← { type: "approval_response", requestId, approved, data }
  
  → { type: "text", content }
  → { type: "tool_use", tool, input, toolUseId }
  → { type: "tool_result", output, isError, toolUseId }
  → { type: "approval_request", requestId, tool, input }
  → { type: "usage", usage }
  → { type: "error", message }
  → { type: "done", sessionId }
  → { type: "connected", sessionId }
  → { type: "ping" } (keepalive)
```

### HTTP REST
```
GET  /chat/slash-items                        → SlashItem[]
GET  /chat/usage                              → UsageInfo
GET  /chat/providers                          → ProviderInfo[]
GET  /chat/sessions                           → SessionInfo[] (optional: providerId, dir)
GET  /chat/sessions/:id/messages              → ChatMessage[] (providerId query param)
POST /chat/sessions                           → Session (body: { providerId?, title? })
DELETE /chat/sessions/:id                     → { deleted } (providerId query param)
POST /chat/upload                             → { path, name, type, size }[]
GET  /chat/uploads/:filename                  → File
```

---

## Key Concepts

### Session Management
- **Create:** `query({ options: { sessionId: uuid } })`
- **Resume:** `query({ options: { resume: sessionId } })`
- **Persistence:** SDK manages ~/.claude/projects/<cwd>/<sessionId>/
- **Lookup:** `listSessions()`, `getSessionMessages()`

### Event Streaming
- Provider yields AsyncIterable<ChatEvent>
- WS forwards JSON to client in real-time
- Frontend accumulates into messages array
- Always ends with `{ type: "done", sessionId }`

### Tool Execution
- SDK auto-executes tools (Bash, Read, Write, etc.)
- Provider fetches tool_result blocks via getSessionMessages()
- Results displayed as tool cards with output
- AskUserQuestion pauses query, waits for user approval

### Approval Workflow
- canUseTool() callback intercepts AskUserQuestion
- Yields `approval_request` event to FE
- Awaits promise: pendingApprovals[requestId]
- FE sends `approval_response` with answers
- Provider resumes, passes answers to SDK

### Rate Limits
- SDK yields `rate_limit_event` (utilization %)
- Final message includes `total_cost_usd`
- ccburn CLI fetches detailed limits from Anthropic
- Displayed in usage badge

---

## Unresolved Questions

1. **Approval Timeout:** No timeout implemented. If FE disconnects during approval, provider awaits infinitely.
2. **Tool Retry:** No built-in retry logic for failed tool executions.
3. **Session Cleanup:** Sessions deleted from memory only; SDK disk storage never cleaned up.
4. **MCP Servers:** No support for MCP protocol servers (not exposed in SDK options).
5. **Subagents:** No Task tool or subagent spawning support.
6. **Streaming Export:** No mechanism to export/save streams to file.

