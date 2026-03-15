# Claude Agent SDK Integration Scout Report
**Date:** March 15, 2026  
**Project:** PPM (Project & Process Manager)  
**Status:** Complete Inventory  

---

## Quick Reference: All SDK-Related Files

### Absolute Paths to Read in Full

#### Core Implementation (Read First)
1. `/Users/hienlh/Projects/ppm/src/providers/claude-agent-sdk.ts` (512 LOC)
   - Main SDK integration, query execution, event transformation
   
2. `/Users/hienlh/Projects/ppm/src/server/ws/chat.ts` (146 LOC)
   - WebSocket protocol handler, real-time streaming

3. `/Users/hienlh/Projects/ppm/src/web/hooks/use-chat.ts` (424 LOC)
   - React state management, message accumulation, approval UI

#### Supporting Files (Read Second)
4. `/Users/hienlh/Projects/ppm/src/services/chat.service.ts` (111 LOC)
   - Provider abstraction, session routing

5. `/Users/hienlh/Projects/ppm/src/server/routes/chat.ts` (154 LOC)
   - HTTP REST endpoints for sessions, usage, skills

6. `/Users/hienlh/Projects/ppm/src/types/chat.ts` (93 LOC)
   - Type definitions: ChatEvent, UsageInfo, Session

7. `/Users/hienlh/Projects/ppm/src/providers/registry.ts` (46 LOC)
   - Provider factory registration

8. `/Users/hienlh/Projects/ppm/src/services/slash-items.service.ts` (185 LOC)
   - Skills & commands discovery

#### Test Files (Understand Behavior)
9. `/Users/hienlh/Projects/ppm/tests/unit/providers/claude-agent-sdk.test.ts` (340 LOC)
   - Unit tests: streaming, tools, abort, sessions

10. `/Users/hienlh/Projects/ppm/tests/integration/claude-agent-sdk-integration.test.ts` (233 LOC)
    - Integration tests: real SDK calls, multi-turn

---

## What's Implemented

### SDK Features Used
✅ `query()` — Async generator for streaming responses  
✅ `sessionId` — Create new session  
✅ `resume` — Continue existing session  
✅ `cwd` — Set working directory for tools (skills support)  
✅ `env` — Override environment variables (prevent .env poisoning)  
✅ `settings` — Bypass project restrictions  
✅ `allowedTools` — Whitelist permitted tools  
✅ `permissionMode: "bypassPermissions"` — Skip tool approval UI  
✅ `canUseTool()` — Custom approval callback for AskUserQuestion  
✅ `includePartialMessages: true` — Stream text deltas  
✅ `listSessions()` — Enumerate available sessions  
✅ `getSessionMessages()` — Load conversation history  
✅ Tool auto-execution — Bash, Read, Write, Edit, Glob, Grep, WebSearch, WebFetch  
✅ `rate_limit_event` — Five-hour and seven-day utilization tracking  
✅ `total_cost_usd` — Per-query cost tracking  

### Streaming Architecture
✅ Real-time text deltas via `partial` and `stream_event` events  
✅ Tool execution with internal SDK execution  
✅ Tool result extraction via `getSessionMessages()` call  
✅ Message accumulation in React with refs (streamingContentRef)  
✅ Message finalization on `done` event  
✅ Multi-message queueing (send while streaming)  
✅ WebSocket 15s keepalive ping (idle timeout protection)  

### Approval Workflow
✅ `canUseTool()` callback intercepts AskUserQuestion  
✅ `approval_request` event yielded to frontend  
✅ Provider pauses, awaits `approval_response` from WS  
✅ Answer merging into tool input (`updatedInput`)  
✅ Approval rejection support ("User skipped the question")  

### Session Persistence
✅ SDK manages `~/.claude/projects/<cwd>/<sessionId>/`  
✅ Automatic context loading on resume  
✅ Multi-turn conversations preserve context  
✅ Message history retrieval via `getSessionMessages()`  

### Usage Tracking
✅ Rate-limit utilization (five_hour, seven_day as 0–1)  
✅ Query cost in USD (total_cost_usd)  
✅ Detailed rate limit buckets (session, weekly, weeklyOpus, weeklySonnet)  
✅ Reset times (fiveHourResetsAt, sevenDayResetsAt)  
✅ ccburn CLI integration for current usage fetch  
✅ 30-second cache with TTL  

### Multi-Provider Architecture
✅ Provider interface abstraction (AIProvider)  
✅ ClaudeAgentSdkProvider (default, full SDK)  
✅ ClaudeCodeCliProvider (fallback, CLI-based)  
✅ MockProvider (testing only)  
✅ Provider registry with default selection  

### Skills & Commands
✅ Discover from `~/.claude/` (user-global)  
✅ Discover from `./.claude/` (project-local)  
✅ Parse YAML frontmatter for metadata  
✅ Project overrides user items  
✅ Exposed via `/chat/slash-items` endpoint  

### Error Handling
✅ Non-abort errors yielded as ChatEvent  
✅ Abort errors suppressed (checked via "abort" in message)  
✅ Always yield final `done` event  
✅ WS connection drop cleanup  

---

## What's NOT Implemented

❌ MCP Protocol servers (Protocol Designer, GitHub, Jira, etc.)  
❌ Custom tools beyond SDK's built-ins  
❌ Subagent spawning (no Task tool)  
❌ Tool retry logic  
❌ Approval timeout (infinite wait)  
❌ Session disk cleanup (memory only)  
❌ WebSocket message compression  
❌ Streaming export/file saving  
❌ Streaming to specific working directory override  
❌ Hooks for custom message pre/post processing  

---

## How Messages Flow

### User → SDK → Frontend
```
User types in chat
  ↓ (useChat.sendMessage)
  ↓
WS sends { type: "message", content }
  ↓
WS handler: resumeSession → backfill projectPath
  ↓
Provider: query({ resume: sessionId, prompt: content, ... })
  ↓
SDK yields: partial/stream_event (text delta)
  ↓
Provider yields: { type: "text", content: delta }
  ↓
WS sends JSON
  ↓
Frontend: accumulate in streamingContentRef
  ↓
React: setMessages() updates UI in real-time
```

### Tool Execution
```
Claude decides to use Read tool
  ↓
SDK yields: { type: "assistant", message: { content: [
  { type: "tool_use", name: "Read", input: { path } }
  ]}}
  ↓
Provider yields: { type: "tool_use", tool: "Read", ... }
  ↓
SDK executes tool internally with cwd=projectPath
  ↓
SDK yields: partial (while processing), then assistant/result
  ↓
Provider detects pendingToolCount > 0
  ↓
Provider: getSessionMessages() → extract tool_result blocks
  ↓
Provider yields: { type: "tool_result", output, isError }
  ↓
Frontend: appends to events, renders ToolCard with output
```

### Approval (AskUserQuestion)
```
SDK needs user input for AskUserQuestion
  ↓
canUseTool("AskUserQuestion", { questions: [...] })
  ↓
Provider creates requestId, yields approval_request
  ↓
Provider awaits: pendingApprovals[requestId].resolve()
  ↓ [PAUSED]
Frontend shows modal
  ↓
User selects answers, clicks submit
  ↓
respondToApproval(requestId, true, answers)
  ↓
WS sends: { type: "approval_response", requestId, approved, data }
  ↓
Provider: resolveApproval() → resolve promise
  ↓
canUseTool returns: { behavior: "allow", updatedInput: {..., answers} }
  ↓
SDK continues with answers in tool input
  ↓
SDK yields assistant/tool_use (executed with answers)
```

---

## SDK Query Options Explained

```typescript
query({
  prompt: "User message",
  options: {
    sessionId: isFirstMessage ? sessionId : undefined,
    // ^ First message creates new session (stored in ~/.claude/projects/)
    
    resume: isFirstMessage ? undefined : sessionId,
    // ^ Subsequent messages resume session (reloads history from disk)
    
    cwd: meta.projectPath,
    // ^ Working directory for tool execution (enables /read, /write, etc.)
    
    env: {
      ...process.env,
      ANTHROPIC_API_KEY: "",      // Prevent .env poisoning
      ANTHROPIC_BASE_URL: "",     // Force subscription, not project keys
      ANTHROPIC_AUTH_TOKEN: "",
    },
    
    settings: { permissions: { allow: [], deny: [] } },
    settingSources: [],
    // ^ Bypass project-local .claude/settings.local.json restrictions
    
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
    // ^ Auto-approve all tools except AskUserQuestion
    
    allowedTools: [
      "Read", "Write", "Edit", "Bash", "Glob", "Grep",
      "WebSearch", "WebFetch", "AskUserQuestion",
    ],
    // ^ Only these tools are allowed
    
    canUseTool: async (toolName, input) => {
      // ^ Custom callback for tool approval (AskUserQuestion only)
      if (toolName !== "AskUserQuestion") return { behavior: "allow" }
      // For AskUserQuestion: yield request → await → return decision
    },
    
    includePartialMessages: true,
    // ^ Stream text deltas instead of waiting for full message
  }
})
```

---

## Report Files Generated

This scout created three detailed reports in `/Users/hienlh/Projects/ppm/plans/reports/`:

1. **scout-260315-1911-sdk-integration-inventory.md** (1000+ lines)
   - Comprehensive inventory of all SDK features
   - Detailed breakdown of each file
   - Data flow examples
   - Configuration options
   - Known limitations

2. **sdk-integration-architecture.md** (500+ lines)
   - System overview diagram
   - Message flow walkthroughs
   - Event type mapping
   - State machine documentation
   - File organization
   - Error handling paths

3. **sdk-file-inventory.md** (300+ lines)
   - File-by-file breakdown
   - Line counts
   - Dependency map
   - Exposed endpoints
   - Key concepts summary
   - Unresolved questions

---

## Key Takeaways

### Architecture Strengths
1. **Real-time streaming** via async generators + WebSocket
2. **Multi-provider abstraction** for pluggable backends
3. **Stateless sessions** (SDK owns persistence on disk)
4. **Approval workflow** that pauses SDK, resumes on user input
5. **Rate-limit tracking** without blocking queries

### Critical Files for Modification
- **src/providers/claude-agent-sdk.ts** — SDK query configuration, event handling
- **src/server/ws/chat.ts** — Protocol, message routing
- **src/web/hooks/use-chat.ts** — State management, React integration
- **src/server/routes/chat.ts** — HTTP endpoints, session CRUD

### Integration Points
- SDK entry: `query({ options: { sessionId/resume, cwd, canUseTool, ... } })`
- Event transform: Provider event loop → ChatEvent union
- WS protocol: JSON serialization of ChatEvent
- Frontend: useChat hook + React setMessages()

### Known Gaps
1. Approval timeout (infinite wait if FE disconnects)
2. No tool retry mechanism
3. No MCP server support
4. No subagent spawning

---

## Next Steps to Extend SDK

If you need to extend SDK usage:

1. **Add new tools:** Extend `allowedTools` array (line 226 in provider)
2. **Add tool approval:** Modify `canUseTool()` callback logic
3. **Add custom events:** Extend ChatEvent union in types/chat.ts
4. **Add MCP servers:** Use SDK options (not currently exposed)
5. **Add subagents:** Implement Task tool execution pattern
6. **Add streaming export:** Modify message finalization in useChat

---

## Files Summary Table

| File | Path | LOC | Purpose |
|------|------|-----|---------|
| Provider | src/providers/claude-agent-sdk.ts | 512 | SDK execution, events |
| WebSocket | src/server/ws/chat.ts | 146 | Real-time protocol |
| Chat Hook | src/web/hooks/use-chat.ts | 424 | React state mgmt |
| Chat Service | src/services/chat.service.ts | 111 | Provider routing |
| HTTP Routes | src/server/routes/chat.ts | 154 | REST endpoints |
| Type Defs | src/types/chat.ts | 93 | Type definitions |
| Registry | src/providers/registry.ts | 46 | Provider factory |
| Skills | src/services/slash-items.service.ts | 185 | Skills discovery |
| Unit Tests | tests/unit/providers/claude-agent-sdk.test.ts | 340 | Mocked tests |
| Integration | tests/integration/claude-agent-sdk-integration.test.ts | 233 | Real SDK tests |

**Total Core: 1,739 LOC across 10 files**

---

## Unresolved Questions

1. Should approval requests have a timeout? Currently infinite wait.
2. Are there any plans to support MCP protocol servers?
3. Should sessions be automatically cleaned from disk after deletion?
4. Is tool retry logic needed for transient failures?
5. Should streaming responses be exportable to file?

