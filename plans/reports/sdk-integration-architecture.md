# Claude Agent SDK Integration Architecture

## System Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                    Frontend (React)                              │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │  Chat Components & useChat Hook                          │  │
│  │  - Message rendering                                     │  │
│  │  - Approval modal (AskUserQuestion)                      │  │
│  │  - Usage badge (rate limits)                             │  │
│  │  - Stream state management                               │  │
│  └──────────────────────────────────────────────────────────┘  │
└─────────────────────┬───────────────────────────────────────────┘
                      │ WebSocket
                      │ /ws/project/{name}/chat/{sessionId}
                      │
┌─────────────────────▼───────────────────────────────────────────┐
│                    Backend (Hono + Bun)                          │
│                                                                  │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │  WS Chat Handler (src/server/ws/chat.ts)                │  │
│  │  - Session lifecycle (open/close)                        │  │
│  │  - Message routing                                       │  │
│  │  - Approval response handling                            │  │
│  │  - Keepalive ping (15s)                                  │  │
│  └────────────┬─────────────────────────────┬───────────────┘  │
│               │                             │                  │
│  ┌────────────▼─────────────────┐  ┌────────▼─────────────────┐│
│  │  Chat Service               │  │  Provider Registry        ││
│  │  (src/services/chat.service)│  │  (src/providers/registry) ││
│  │                             │  │                           ││
│  │  - Message routing          │  │  - ClaudeAgentSdk        ││
│  │  - Session management       │  │  - ClaudeCodeCli         ││
│  │  - Provider abstraction      │  │  - MockProvider          ││
│  └────────────┬────────────────┘  └───────────────────────────┘│
│               │                                                 │
│  ┌────────────▼──────────────────────────────────────────────┐ │
│  │  ClaudeAgentSdkProvider (src/providers/claude-agent-sdk)  │ │
│  │                                                           │ │
│  │  Core Methods:                                           │ │
│  │  • query() — Async generator for streaming              │ │
│  │  • sessionId/resume — Multi-turn session management      │ │
│  │  • canUseTool() — Approval callback for AskUserQuestion │ │
│  │  • getSessionMessages() — Message history loading       │ │
│  │  • getSessionMessages() — Tool result extraction        │ │
│  │  • abortQuery() — Stream cancellation via query.close() │ │
│  │                                                           │ │
│  │  Event Handling:                                         │ │
│  │  • text (partial/stream_event) → ChatEvent stream        │ │
│  │  • tool_use → Auto-execution by SDK                      │ │
│  │  • tool_result → Fetched from session history            │ │
│  │  • rate_limit_event → Usage/cost tracking                │ │
│  │  • approval_request → Pause & wait for FE response       │ │
│  │  • error → Non-abort errors only                         │ │
│  │  • done → Stream completion                              │ │
│  └────────────┬──────────────────────────────────────────────┘ │
│               │                                                 │
│  ┌────────────▼──────────────────────────────────────────────┐ │
│  │  HTTP Routes (src/server/routes/chat.ts)                │ │
│  │                                                          │ │
│  │  • GET /chat/sessions             (list + filter)       │ │
│  │  • GET /chat/sessions/:id/messages (history)            │ │
│  │  • POST /chat/sessions            (create + projectPath)│ │
│  │  • DELETE /chat/sessions/:id      (cleanup)             │ │
│  │  • GET /chat/slash-items          (skills discovery)    │ │
│  │  • GET /chat/usage                (rate limits)         │ │
│  └───────────────────────────────────────────────────────────┘ │
└──────────────────┬──────────────────────────────────────────────┘
                   │
        ┌──────────┼──────────┬──────────────┐
        │          │          │              │
┌───────▼──┐ ┌─────▼──┐ ┌────▼────┐ ┌──────▼─────┐
│   SDK    │ │ ccburn │ │ Project │ │  ~/.claude │
│  query() │ │(usage) │ │  .cwd   │ │  (skills)  │
└──────────┘ └────────┘ └─────────┘ └────────────┘
```

---

## Message Flow: Single Query

```
1. User Types Message
   User → Chat Input
            │
            ▼
2. Send via WebSocket
   useChat.sendMessage(content)
   → WS send({ type: "message", content })
            │
            ▼
3. Backend Receives
   chatWebSocket.message()
   → resumeSession(sessionId)      [reload from disk]
   → ensureProjectPath(projectPath)  [enable skills]
   → chatService.sendMessage(providerId, sessionId, content)
            │
            ▼
4. Provider Executes
   ClaudeAgentSdkProvider.sendMessage()
   → query({
       prompt: content,
       options: {
         resume: sessionId,          [use existing context]
         cwd: projectPath,           [skills cwd]
         canUseTool: (toolName) => {},
         includePartialMessages: true,
       }
     })
            │
            ▼
5. SDK Processes
   SDK async generator yields:
   • partial/stream_event (text deltas)
   • assistant (full message with tool_use blocks)
   • rate_limit_event (five_hour/seven_day)
   • result (final message + total_cost_usd)
            │
            ▼
6. Provider Transforms
   ClaudeAgentSdkProvider event loop:
   for await (const msg of q) {
     if (msg.type === "partial" || "stream_event")
       yield { type: "text", content: delta }
     if (msg.type === "assistant" && toolUse)
       yield { type: "tool_use", tool, input, toolUseId }
     if (toolResultPending)
       [fetch via getSessionMessages()]
       yield { type: "tool_result", output, isError }
     if (msg.type === "rate_limit_event")
       yield { type: "usage", usage: { fiveHour, sevenDay } }
     if (msg.type === "result")
       yield { type: "usage", usage: { totalCostUsd } }
       break;
   }
   yield { type: "done", sessionId }
            │
            ▼
7. WS Server Forwards
   chatWebSocket.message()
   → for await (const event of chatService.sendMessage(...))
       ws.send(JSON.stringify(event))
            │
            ▼
8. Frontend Receives Events
   useChat.handleMessage()
   for each event:
   • text → accumulate in streamingContentRef
   • tool_use → append to streamingEventsRef
   • tool_result → append to streamingEventsRef
   • usage → merge into usageInfo state
   • done → finalize message, clear refs
            │
            ▼
9. React Renders
   setMessages() updates display:
   → Last assistant message updated with accumulated text
   → Tool events rendered as tool cards
   → Usage badge updated
```

---

## Message Flow: Tool Execution + Tool Results

```
1. Claude Decides to Use Tool
   SDK yields: { type: "assistant", message: { content: [
     { type: "tool_use", id: "123", name: "Read", input: { path: "..." } }
   ]}}
            │
            ▼
2. Provider Extracts & Yields
   yield { type: "tool_use", toolUseId: "123", tool: "Read", input: {...} }
            │
            ▼
3. SDK Executes Tool Internally
   SDK runs: tools["Read"](input) with cwd = projectPath
   Tool returns output or error
   SDK adds tool_result block to session history
            │
            ▼
4. SDK Yields Next Events
   SDK yields: partial/stream_event (while processing)
   SDK yields: assistant/result (once tool done)
            │
            ▼
5. Provider Detects Tool Results
   pendingToolCount > 0 && (type === "assistant" || "result")
   → getSessionMessages(sessionId)
   → Find last user message (contains tool_result blocks)
   → Extract tool_result.content/output/is_error
            │
            ▼
6. Provider Yields Tool Result Events
   for each tool_result block:
   yield { type: "tool_result", toolUseId, output, isError }
            │
            ▼
7. WS Forwards to FE
   { type: "tool_result", output: "...", isError: false }
            │
            ▼
8. Frontend Renders
   setMessages() appends tool_result event
   → ToolCard component displays output below tool_use
```

---

## Message Flow: Approval (AskUserQuestion)

```
1. SDK Calls Approval Callback
   SDK needs user input for AskUserQuestion
   → canUseTool("AskUserQuestion", {
       questions: [
         { question: "...", options: [...] },
         ...
       ]
     })
            │
            ▼
2. Provider Pauses & Creates Request
   requestId = crypto.randomUUID()
   pendingApprovals[requestId] = new Promise((resolve) => {...})
   yield { type: "approval_request", requestId, tool: "AskUserQuestion", input }
   → PROVIDER PAUSES HERE (awaits promise)
            │
            ▼
3. WS Forwards Request to FE
   { type: "approval_request", requestId: "abc123", input: { questions: [...] } }
            │
            ▼
4. Frontend Shows Modal
   useChat.handleMessage()
   setPendingApproval({ requestId, tool, input })
   → Renders AskUserQuestion modal with questions
   → User selects answers
            │
            ▼
5. User Submits
   useChat.respondToApproval(requestId, true, answers)
   → WS send({ type: "approval_response", requestId, approved: true, data: answers })
            │
            ▼
6. Backend Routes Response
   chatWebSocket.message()
   if (type === "approval_response")
     provider.resolveApproval(requestId, approved, data)
            │
            ▼
7. Provider Resumes
   pendingApprovals[requestId].resolve({ approved, data })
   → Promise resolves in canUseTool()
   → canUseTool returns:
       { behavior: "allow", updatedInput: {
         ...input,
         answers: data
       }}
            │
            ▼
8. SDK Continues Execution
   SDK passes updatedInput (with answers) to tool
   Tool executes with user answers
   SDK yields: assistant/tool_use/result
            │
            ▼
9. Frontend Re-renders
   setMessages() re-renders with answers merged into tool_use.input
   → Shows selected answers in ToolCard
```

---

## Multi-turn Conversation

```
Turn 1:
┌──────────────────────────────────────────────┐
│ Message: "My favorite color is purple"       │
│ Options: { sessionId: "uuid-1", prompt }     │
└──────────────┬───────────────────────────────┘
               ▼
SDK Session Created: ~/.claude/projects/<cwd>/uuid-1/
                 ├── current.md (conversation state)
                 └── messages.json (turn history)
               ▼
Claude: "Got it! Purple is a nice color."
               ▼
Session stored on disk with message history

Turn 2:
┌──────────────────────────────────────────────┐
│ Message: "What's my favorite color?"         │
│ Options: { resume: "uuid-1", prompt }        │
└──────────────┬───────────────────────────────┘
               ▼
SDK Resumes Session: Loads ~/.claude/projects/<cwd>/uuid-1/
               ├── Reads conversation history
               └── Sends to Claude as context
               ▼
Claude: "Your favorite color is purple." [from context]
               ▼
Session updated with new turn

Turn N:
Same pattern — SDK maintains context across turns via disk storage
```

---

## Event Type Mapping

```
SDK Raw Event              Provider Transformation         WS Sent to FE
───────────────────────────────────────────────────────────────────────
partial/stream_event       → { type: "text", content }     ✓
  .event.delta.text           (text delta only)

assistant                  → { type: "text", ... }         ✓
  .message.content            (each text block)
  (text blocks)

assistant                  → { type: "tool_use", ... }     ✓
  .message.content            (each tool_use block)
  (tool_use blocks)

[post-tool execution]      → { type: "tool_result", ... }  ✓
getSessionMessages()          (from session history)
  (tool_result blocks)

rate_limit_event           → { type: "usage", ... }        ✓
  .rate_limit_info            (five_hour, sevenDay %)

result                     → { type: "usage", ... }        ✓
  .total_cost_usd             (cost only, no %)

result                     → { type: "done", sessionId }   ✓
  (end of stream)

[canUseTool called]        → { type: "approval_request" }  ✓
  AskUserQuestion            (pause provider, wait FE)

[non-abort error]          → { type: "error", message }    ✓

[abort via close()]        → (no event, stream ends)       ✓ (done)
```

---

## State Machine: useChat Message Accumulation

```
Initial: messages = []

User sends "Hello"
  ↓ sendMessage()
  → setMessages([{ id: "user-...", role: "user", content: "Hello" }])
  → streamingContentRef = ""
  → isStreaming = true
  → WS send({ type: "message", content: "Hello" })

WS receives: { type: "text", content: "Hi" }
  ↓ handleMessage("text")
  → streamingContentRef = "Hi"
  → setMessages([..., { role: "assistant", content: "Hi", events: [...] }])

WS receives: { type: "text", content: " there" }
  ↓ handleMessage("text")
  → streamingContentRef = "Hi there"
  → setMessages([..., { role: "assistant", content: "Hi there", events: [...] }])

WS receives: { type: "done", sessionId }
  ↓ handleMessage("done")
  → finalContent = "Hi there"
  → setMessages([..., { id: "final-...", role: "assistant", content: "Hi there" }])
  → streamingContentRef = ""
  → isStreaming = false

[If user sent "Help" while streaming, now:]
  → pendingMessageRef = "Help"
  ↓ (done handler detects queued message)
  → setMessages([..., { id: "user-...", role: "user", content: "Help" }])
  → streamingContentRef = ""
  → isStreaming = true
  → WS send({ type: "message", content: "Help" })
  [cycle repeats]
```

---

## Error Handling Paths

```
Query Succeeds:
  query() → SDK events → provider yields → WS sends → FE displays
                                                        ✓ Success

SDK Error (non-abort):
  query() throws or yields error
  → Provider catches in try/catch
  → yield { type: "error", message: "..." }
  → yield { type: "done", sessionId }
  → WS sends both
  → FE displays error as system message
  [Request was user's fault or SDK bug, not client-side abort]

Abort (user cancels):
  user clicks "Stop"
  → FE: send({ type: "cancel" })
  → WS: provider.abortQuery() → query.close()
  → SDK stops iterating (may throw "aborted" error)
  → Provider catch block skips error yield (checks for "abort" in message)
  → Provider yields { type: "done", sessionId } only
  → FE sees done, no error
  [Clean cancellation]

WS Connection Drops:
  chatWebSocket.close()
  → abortController.abort()
  → for-await loop breaks
  → provider.abortQuery() called
  → SDK query.close()
  [Stream stops cleanly]

Approval Timeout:
  FE loses connection while waiting for approval_response
  → Provider awaits infinitely (no timeout implemented)
  → SDK query paused
  → User reconnects → must re-send approval_response
  [Known limitation: should add timeout]
```

---

## File Organization

```
src/
├── providers/
│   ├── claude-agent-sdk.ts    [Main SDK integration]
│   ├── provider.interface.ts  [AIProvider contract]
│   ├── registry.ts            [Provider registry]
│   ├── mock-provider.ts       [Testing]
│   └── claude-code-cli.ts     [Fallback]
│
├── server/
│   ├── ws/
│   │   └── chat.ts            [WS handler]
│   ├── routes/
│   │   └── chat.ts            [HTTP endpoints]
│   └── index.ts               [Server setup]
│
├── services/
│   ├── chat.service.ts        [Provider router]
│   ├── slash-items.service.ts [Skills discovery]
│   ├── claude-usage.service.ts [Rate limits]
│   └── config.service.ts      [Config mgmt]
│
├── web/
│   ├── hooks/
│   │   ├── use-chat.ts        [Chat state + streaming]
│   │   ├── use-websocket.ts   [WS client]
│   │   └── ...
│   ├── components/
│   │   └── chat/
│   │       ├── chat-tab.tsx
│   │       ├── message-list.tsx
│   │       ├── message-input.tsx
│   │       ├── slash-command-picker.tsx
│   │       └── ...
│   └── ...
│
└── types/
    └── chat.ts                [ChatEvent, UsageInfo, Session]

tests/
├── unit/
│   └── providers/
│       └── claude-agent-sdk.test.ts
└── integration/
    ├── claude-agent-sdk-integration.test.ts
    ├── ws-chat-project-path.test.ts
    └── api/
        └── chat-routes.test.ts
```

---

## Key Integration Points

### 1. SDK Entry Point
**File:** `src/providers/claude-agent-sdk.ts:209`
```typescript
const q = query({
  prompt: message,
  options: { sessionId, resume, cwd, env, settings, canUseTool, ... }
})
```

### 2. Tool Approval Callback
**File:** `src/providers/claude-agent-sdk.ts:171`
```typescript
const canUseTool = async (toolName, input) => {
  if (toolName !== "AskUserQuestion") return { behavior: "allow" }
  // Create approval request, yield to FE, await response
  return { behavior: "allow", updatedInput: {...input, answers} }
}
```

### 3. WS Protocol Gateway
**File:** `src/server/ws/chat.ts:54`
```typescript
message(ws, msg): message|cancel|approval_response → provider actions
```

### 4. Frontend State Sync
**File:** `src/web/hooks/use-chat.ts:41`
```typescript
handleMessage(event): ChatWsServerMessage → React state updates
```

### 5. Session Persistence
**File:** `src/providers/claude-agent-sdk.ts:209`
```typescript
SDK manages: ~/.claude/projects/<cwd>/<sessionId>/
PPM reads via: listSessions(), getSessionMessages()
```

---

## Summary

| Layer | Component | Responsibility |
|-------|-----------|-----------------|
| **Frontend** | useChat Hook | React state, message accumulation, approval UI |
| **WebSocket** | chatWebSocket | Real-time event streaming, session lifecycle |
| **Backend** | ClaudeAgentSdkProvider | SDK query execution, event transformation |
| **Services** | chatService | Provider routing, session management |
| **HTTP** | chat routes | REST API for sessions, uploads, usage |
| **Persistence** | SDK | ~/.claude/projects/<cwd>/<sessionId>/ |
| **Tools** | SDK allowedTools | Bash, Read, Write, Edit, Glob, Grep, WebSearch, WebFetch, AskUserQuestion |

