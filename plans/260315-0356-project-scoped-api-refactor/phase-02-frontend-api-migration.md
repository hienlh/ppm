---
phase: 2
title: "Frontend API client + calls migration"
status: pending
effort: 2h
depends_on: [1]
---

# Phase 2: Frontend API Client + Calls Migration

## Context
- [plan.md](./plan.md)
- [phase-01](./phase-01-backend-project-router.md)
- `src/web/lib/api-client.ts`
- All frontend components calling `/api/...`

## Overview
Add project-scoped URL helper to ApiClient. Update all frontend API calls to use `/api/project/:projectName/...` pattern. Remove `project` from POST bodies for git operations.

## Key Insight
Most components already have access to `projectName` via `useProjectStore` or props. The migration is mechanical: prefix every API path with `/api/project/${projectName}`.

## Related Code Files

### Files to modify
- `src/web/lib/api-client.ts` -- add `projectUrl()` helper
- `src/web/components/chat/chat-tab.tsx` -- session creation URL
- `src/web/components/chat/session-picker.tsx` -- session list/delete URLs
- `src/web/hooks/use-chat.ts` -- message history URL
- `src/web/components/git/git-graph.tsx` -- all git API calls (~12 calls)
- `src/web/components/git/git-status-panel.tsx` -- status, stage, unstage, commit, push, pull
- `src/web/stores/file-store.ts` -- file tree URL
- `src/web/components/editor/code-editor.tsx` -- read/write URLs
- `src/web/components/explorer/file-actions.tsx` -- create/rename/delete URLs
- `src/web/components/editor/diff-viewer.tsx` -- compare/diff URLs

## Implementation Steps

### 1. Add helper to `api-client.ts`
```ts
/** Build project-scoped API path prefix */
export function projectUrl(projectName: string): string {
  return `/api/project/${encodeURIComponent(projectName)}`;
}
```

### 2. Update git-graph.tsx
Before:
```ts
`/api/git/graph/${encodeURIComponent(projectName)}?max=200`
gitAction("/api/git/checkout", { project: projectName, ref });
```
After:
```ts
`${projectUrl(projectName)}/git/graph?max=200`
gitAction(`${projectUrl(projectName)}/git/checkout`, { ref });
```
- Remove `project` field from all `gitAction` call bodies
- Update all GET URLs: `/api/git/status/:project` -> `${projectUrl(name)}/git/status`

### 3. Update git-status-panel.tsx
Same pattern:
- GET `/api/git/status/${name}` -> `${projectUrl(name)}/git/status`
- POST bodies: remove `project: projectName` field from stage/unstage/commit/push/pull

### 4. Update file-related components
- `file-store.ts`: `/api/files/tree/${name}` -> `${projectUrl(name)}/files/tree`
- `code-editor.tsx`: `/api/files/read/${name}?path=` -> `${projectUrl(name)}/files/read?path=`
- `file-actions.tsx`: same pattern for create/rename/delete
- `diff-viewer.tsx`: same pattern for compare/file-diff/diff

### 5. Update chat components
- `chat-tab.tsx`: `/api/chat/sessions` -> `${projectUrl(name)}/chat/sessions`
  - Remove `projectName` from POST body
- `session-picker.tsx`: same prefix, remove `?dir=` query
- `use-chat.ts`: `/api/chat/sessions/:id/messages` -> `${projectUrl(name)}/chat/sessions/:id/messages`
  - Need to pass projectName into `useChat` hook (add param)

### 6. Update use-chat.ts signature
```ts
export function useChat(
  sessionId: string | null,
  providerId: string,
  projectName: string,  // NEW
): UseChatReturn
```
- History fetch: `${projectUrl(projectName)}/chat/sessions/${sessionId}/messages?providerId=${providerId}`
- WS URL change handled in Phase 4

## Todo List
- [ ] Add `projectUrl()` to api-client.ts
- [ ] Update git-graph.tsx (~15 call sites)
- [ ] Update git-status-panel.tsx (~6 call sites)
- [ ] Update file-store.ts (1 call)
- [ ] Update code-editor.tsx (2 calls)
- [ ] Update file-actions.tsx (3 calls)
- [ ] Update diff-viewer.tsx (4 calls)
- [ ] Update chat-tab.tsx (1 call)
- [ ] Update session-picker.tsx (2 calls)
- [ ] Update use-chat.ts (1 call + signature)
- [ ] Verify compile

## Success Criteria
- All API calls use `/api/project/:projectName/...` prefix
- No `project` field in git POST bodies
- No `dir` query param in chat session list
- TypeScript compiles clean
