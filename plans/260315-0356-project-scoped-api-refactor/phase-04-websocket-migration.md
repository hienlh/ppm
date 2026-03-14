---
phase: 4
title: "WebSocket URL migration"
status: pending
effort: 0.5h
depends_on: [1]
---

# Phase 4: WebSocket URL Migration

## Context
- [plan.md](./plan.md)
- [phase-01](./phase-01-backend-project-router.md) -- backend WS path changes
- `src/web/hooks/use-terminal.ts` -- terminal WS connection
- `src/web/hooks/use-chat.ts` -- chat WS connection (via use-websocket)

## Overview
Update frontend WS URLs to match new `/ws/project/:projectName/...` paths.

## Related Code Files

### Files to modify
- `src/web/hooks/use-terminal.ts` -- WS URL construction
- `src/web/hooks/use-chat.ts` -- WS URL passed to `useWebSocket`

## Implementation Steps

### 1. Update use-terminal.ts
Before:
```ts
const url = `${protocol}//${host}/ws/terminal/${sid}${projectParam ? `?project=${encodeURIComponent(projectParam)}` : ""}`;
```
After:
```ts
const url = `${protocol}//${host}/ws/project/${encodeURIComponent(options.projectName!)}/terminal/${sid}`;
```
- Remove `?project=` query param -- project is in path
- `projectName` is now required (not optional) in `UseTerminalOptions`

### 2. Update use-chat.ts
Before:
```ts
url: sessionId ? `/ws/chat/${sessionId}` : "",
```
After:
```ts
url: sessionId && projectName ? `/ws/project/${encodeURIComponent(projectName)}/chat/${sessionId}` : "",
```
- `projectName` param was added in Phase 2

### 3. Ensure backend parses new WS paths
Already handled in Phase 1, step 6. Verify:
- `/ws/project/:projectName/terminal/:id` extracts both projectName and id
- `/ws/project/:projectName/chat/:sessionId` extracts both

## Todo List
- [ ] Update `use-terminal.ts` WS URL
- [ ] Make `projectName` required in `UseTerminalOptions`
- [ ] Update `use-chat.ts` WS URL
- [ ] Verify both WS connections work end-to-end

## Success Criteria
- Terminal WS connects at `/ws/project/:projectName/terminal/:id`
- Chat WS connects at `/ws/project/:projectName/chat/:sessionId`
- No query params for project identification
- Both foreground and daemon server blocks handle new paths
