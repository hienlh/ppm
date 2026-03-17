# Scout Report: Claude Session Connection & Disconnection Logic

**Date:** 2026-03-16 | **Time:** 15:23

## Executive Summary

Located **13 files** directly responsible for Claude Agent SDK session connection, disconnection, resumption, and state management across PPM backend and frontend. Files organized by responsibility domain (BE WebSocket, SDK Provider, Chat Service, FE Hooks, Types).

## Files by Responsibility

### Backend WebSocket Handler
- **`/Users/hienlh/Projects/ppm/src/server/ws/chat.ts`** — Core WS handler for chat
  - `open()`: Tracks active sessions, starts keepalive ping (15s), resolves project path
  - `close()`: Cleanup on disconnect — clears ping, aborts query, removes from activeSessions map
  - `message()`: Routes "message"/"cancel"/"approval_response" types; resumes sessions on demand
  - **Active sessions map:** Keyed by sessionId, stores ws ref, providerId, projectPath, AbortController, ping interval

### Claude Agent SDK Provider
- **`/Users/hienlh/Projects/ppm/src/providers/claude-agent-sdk.ts`** — SDK integration & session lifecycle
  - `createSession()`: New UUID, initializes meta object, stores in activeSessions map
  - `resumeSession()`: Loads from SDK if exists, falls back to local meta creation
  - `deleteSession()`: Removes from activeSessions & messageCount maps
  - `ensureProjectPath()`: Backfill projectPath on resumed sessions (called by WS handler)
  - `sendMessage()`: Main generator — handles query execution, tool approvals, error handling
  - `abortQuery()`: Force-closes active query object for cancellation
  - **Session mapping:** Persists PPM UUID → SDK sessionId mapping in `~/.ppm/session-map.json` for resumption after server restart
  - **Active queries map:** Tracks running queries for abort support

### Chat Service
- **`/Users/hienlh/Projects/ppm/src/services/chat.service.ts`** — Provider abstraction layer
  - `createSession()`: Delegates to provider
  - `resumeSession()`: Delegates to provider
  - `deleteSession()`: Delegates to provider
  - `sendMessage()`: Delegates to provider, yields ChatEvents
  - `getSession()`: Lookup session across all providers (used by WS handler)

### Frontend WebSocket Client
- **`/Users/hienlh/Projects/ppm/src/web/lib/ws-client.ts`** — Low-level WebSocket management
  - `connect()`: Opens WS, sets up onopen/onmessage/onclose/onerror handlers
  - `disconnect()`: Sets `intentionalClose = true`, clears handlers, closes socket
  - `onclose` handler: Auto-reconnects if NOT intentional close via exponential backoff
  - **Reconnection logic:** Exponential backoff (1s → 30s max), resets attempts on successful open
  - **Handler management:** Multiple handlers per connection via `onMessage()` subscription

### Frontend Chat Hook
- **`/Users/hienlh/Projects/ppm/src/web/hooks/use-chat.ts`** — Chat state & message handling
  - `useWebSocket()` integration for session-scoped WS management
  - `handleMessage()`: Routes incoming events (text, tool_use, tool_result, approval_request, usage, error, done)
  - **Streaming state:** Uses refs to track content, events, isStreaming flag
  - **Message queuing:** Queues user messages during streaming, flushes after stream ends
  - **Reconnect callback:** `reconnect()` resets isConnected, calls `wsReconnect()`
  - **Session change handling:** Loads message history, resets state on sessionId change

### Frontend WebSocket Hook
- **`/Users/hienlh/Projects/ppm/src/web/hooks/use-websocket.ts`** — React hook wrapper for WsClient
  - Manages WsClient instance lifecycle (create on mount, disconnect on unmount)
  - Exposes `connect()`, `disconnect()`, `send()` callbacks
  - Auto-reconnects on mount if `autoConnect = true`

### Type Definitions
- **`/Users/hienlh/Projects/ppm/src/types/chat.ts`** — Chat domain types
  - `Session`: id, providerId, title, projectName/Path, createdAt
  - `ChatEvent`: Union type for all event kinds (text, tool_use, tool_result, approval_request, usage, error, done)
  - `ChatMessage`: Message history structure (id, role, content, events[], timestamp)

- **`/Users/hienlh/Projects/ppm/src/types/api.ts`** — API message types
  - `ChatWsClientMessage`: message, cancel, approval_response
  - `ChatWsServerMessage`: text, tool_use, tool_result, approval_request, usage, done, error

### Session & Event Logging
- **`/Users/hienlh/Projects/ppm/src/services/session-log.service.ts`** — Session event audit trail
  - `logSessionEvent()`: Appends to ~/.ppm/sessions/{sessionId}.log
  - `getSessionLog()`: Reads session logs (last N lines)
  - Events logged: USER, TEXT, TOOL_USE, TOOL_RESULT, ERROR, DONE, INFO

### Server Setup
- **`/Users/hienlh/Projects/ppm/src/server/index.ts`** — App bootstrap
  - Registers `chatWebSocket` handler for `/ws/project/:projectName/chat/:sessionId` routes
  - Registers `terminalWebSocket` handler (separate system)

### Supporting Services
- **`/Users/hienlh/Projects/ppm/src/services/chat.service.ts`** — Aggregates provider operations (already listed above)

## Key Connection/Disconnection Flows

### New Session Connection
1. FE calls `chatService.createSession()` → generates UUID, stores meta
2. FE opens WS at `/ws/project/{projectName}/chat/{sessionId}`
3. BE `open()`: Looks up session, starts ping, sends "connected" event
4. FE receives "connected", sets isConnected = true

### Session Resumption (After Server Restart)
1. FE stores sessionId in state
2. FE opens WS at same URL with existing sessionId
3. BE `open()`: Finds session in meta map (or creates placeholder if missing)
4. On first message: BE calls `resumeSession()` → SDK looks up by mapped sessionId
5. SDK loads session from ~/.claude/projects/{sessionId}/ or ~/.ppm/session-map.json mapping

### Disconnection & Cleanup
1. FE intentionally calls `disconnect()` → sets intentionalClose = true
2. WS onclose fires → notifies BE handler
3. BE `close()`: Clears ping interval, aborts pending query, removes from activeSessions map
4. Query object is closed, SDK stops working

### Unintentional Disconnection (Network Issue)
1. WS unexpectedly closes
2. FE `onclose`: `intentionalClose = false` → schedules reconnect
3. Exponential backoff: 1s, 2s, 4s, 8s, ... up to 30s
4. On reconnect: Opens new WS, BE `open()` creates new handler entry
5. Message history preserved in SDK session files

### Message Send & Abort
1. FE `sendMessage()` → sends {type: "message", content} over WS
2. BE receives → calls `sendMessage()` generator on provider
3. Provider yields events (text, tool_use, tool_result, etc.) as async iterator
4. BE streams each event to FE
5. FE cancels: Sends {type: "cancel"} → BE calls `abortQuery()` → SDK closes query object

## Session State Locations

| Storage | Purpose | Lifetime |
|---------|---------|----------|
| BE activeSessions map (chat.ts) | Active WS connections | Until WS close |
| SDK provider activeSessions map | Session metadata in memory | Until deleteSession or restart |
| ~/.ppm/session-map.json | PPM UUID → SDK sessionId mapping | Persistent across restarts |
| ~/.claude/projects/{sessionId}/ | Full session history (messages, context) | Persistent (SDK owns) |
| ~/.ppm/sessions/{sessionId}.log | Audit trail of events | Persistent |

## Key Implementation Details

### Keepalive Ping
- Interval: 15 seconds (prevents proxy/firewall timeout)
- Sent via `ws.ping()` or JSON {type: "ping"} fallback
- Cleared on close

### Session Mapping Persistence
- Maps PPM's random UUID to SDK's sessionId
- Saved to `~/.ppm/session-map.json` during first message after SDK init
- Allows resume after server restart without losing context

### Approval Request Handling
- canUseTool callback pauses SDK execution
- Yields approval_request event to FE
- Creates pending promise, auto-denies after 60s timeout
- FE sends approval_response → resolves promise → SDK continues

### Tool Result Retrieval
- SDK doesn't yield tool_result events directly
- BE fetches from session history via `getSessionMessages()` after tools execute
- Merged into message stream for FE

## Unresolved Questions

None at this time. All connection/disconnection logic paths are clearly defined.

