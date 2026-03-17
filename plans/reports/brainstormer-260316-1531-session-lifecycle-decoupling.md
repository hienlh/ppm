# Brainstorm: Decouple Claude Session Lifecycle from FE WebSocket

## Problem Statement

FE WebSocket disconnect (tab close, network blip, navigation) immediately kills the active Claude query on BE. FE auto-reconnect is useless because Claude work is already aborted. User loses in-progress AI responses.

## Requirements

1. BE owns Claude session lifecycle -- FE cannot terminate sessions
2. BE continues receiving Claude events even if FE disconnects
3. FE auto-reconnects and catches up on missed events
4. BE disconnects from Claude only after configurable timeout with no FE client

## Evaluated Approaches

### Approach 1: "Don't Kill on Disconnect" (Minimal, ~50 LOC)
- Remove abort calls from `close()` handler, keep session alive
- FE refetches full history on reconnect via REST API
- **Pro**: Trivial to implement
- **Con**: Events during disconnect lost from stream view; visual jump on reconnect; approvals still timeout at 60s

### Approach 2: "Event Buffer + Reconnect Replay" (Balanced, ~150-200 LOC)
- Memory buffer per session, replay on reconnect
- Extended approval timeouts, multi-tab broadcast
- **Pro**: Seamless reconnect; covers network blips and intentional disconnect
- **Con**: Buffer management complexity; replay ordering edge cases

### Approach 3: "Full Session State Machine" (Comprehensive, ~500+ LOC)
- Disk-backed event log, formal state machine, multi-device support
- Survives server restarts
- **Pro**: Production-grade resilience
- **Con**: YAGNI for personal IDE tool; duplicates SDK's own persistence; state machine bugs

## Recommended Solution: Simplified Approach 2 ("Sink Pattern")

Pragmatic variant: ~100 lines BE changes, minimal FE changes.

### Core Design

1. **No real buffer** -- wrap `ws.send()` in helper that silently drops if no client connected. SDK session history (`getSessionMessages()`) is the source of truth.

2. **On FE reconnect**: refetch messages via REST, then receive live events going forward. No cursor tracking, no replay logic.

3. **Approval handling**: Extend timeout to 5 min. On reconnect, re-send pending `approval_request` to new WS.

4. **Cleanup timer**: 5 min default (configurable in `ppm.yaml`). On timeout with no client, abort Claude query. On next FE connect, resume via SDK.

### BE Changes (`src/server/ws/chat.ts`)

- `activeSessions` entry gains: `ws: WS | null`, `cleanupTimer`, `pendingApprovalEvent`
- `close()`: Set `ws = null`, start 5-min timer. NO abort calls.
- `open()`: If session exists, replace `ws`, clear timer. Send `{ type: "status", streaming, pendingApproval }`. If pending approval, re-send it.
- `message()` loop: Use `safeSend(sessionId, event)` helper that checks `ws !== null`.

### FE Changes

- `use-websocket.ts`: No change needed (reconnect logic already works).
- `use-chat.ts`: On `connected` event, call `refetchMessages()`. Handle new `status` event to set `isStreaming` correctly on reconnect.

### Multi-Tab Support
- Broadcast events to all connected WS for same session
- Last-writer-wins for approvals (simple, no coordination)
- Requires `activeSessions` to track array of WS connections per session

### Edge Cases

| Edge Case | Handling |
|-----------|----------|
| Server restart during streaming | SDK query dies. FE reconnects, resumes via `resumeSession()`. User re-sends message. |
| Very long Claude response (30+ min) | Timeout only starts on FE disconnect, not on response duration. |
| Approval with no FE | 5-min extended timeout. Re-sent on reconnect. Auto-deny if timeout. |
| Multiple tabs | Both receive events. Both can send. |
| FE reconnects mid-stream | Refetch history + live stream continues. Small visual jump. |

## Implementation Considerations

- **Memory**: No buffer means no memory concern. One WS + timer per session.
- **Testing**: Key test: disconnect FE mid-stream, verify Claude keeps running, reconnect and verify history available.
- **Config**: Add `session_cleanup_timeout_ms` to `ppm.yaml` AI config section.

## Success Metrics

1. Claude query survives FE disconnect (network blip, tab close)
2. FE reconnect shows full conversation history including events during disconnect
3. Approval requests survive brief disconnects (< 5 min)
4. No memory leaks from orphaned sessions (cleanup timer works)
5. Existing functionality (cancel button, multi-session) unaffected

## Risks

- **Risk**: `ws.send()` after close throws -- mitigated by null-check helper
- **Risk**: Orphaned Claude queries burning API budget -- mitigated by cleanup timer
- **Risk**: Race condition between reconnect and cleanup timer -- mitigated by clearing timer in `open()`
- **Risk**: SDK `query()` iterator behavior when no one consumes events -- needs testing (may backpressure)

## Unresolved Questions

1. Should cleanup timeout be per-session or global config?
2. Should BE send `{ type: "status" }` on WS connect so FE knows streaming state immediately?
3. Should FE disconnect WS on navigating away from chat view, or keep alive?
4. Is 5-min cleanup timeout appropriate given long-running Claude queries?

## Next Steps

- Validate SDK `query()` iterator behavior when events are not consumed (backpressure risk)
- Implement BE changes in `chat.ts`
- Add `status` event type to WS protocol
- Update FE `use-chat.ts` reconnect flow
