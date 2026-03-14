---
title: "Project-scoped API routes + per-project tab storage"
description: "Refactor all APIs under /api/project/:projectName/... and store tabs per-project"
status: pending
priority: P1
effort: 6h
branch: v2-fresh-start
tags: [refactor, api, tabs, project-scope]
created: 2026-03-15
---

# Project-Scoped API Refactor

## Overview

Two changes: (1) move all API routes under `/api/project/:projectName/...` prefix, (2) persist tabs per-project in Zustand so switching projects restores different tab sets.

## Current State Analysis

### Backend Route Structure
| Module | Current Mount | Project Param |
|--------|--------------|---------------|
| `chat.ts` | `/api/chat/...` | body/query (`projectName`, `dir`) |
| `git.ts` | `/api/git/...` | mixed: URL param (`:project`) for GET, body (`project`) for POST |
| `files.ts` | `/api/files/...` | URL param (`:project`) |
| `projects.ts` | `/api/projects` | N/A (lists all) |
| terminal WS | `/ws/terminal/:id?project=` | query param |
| chat WS | `/ws/chat/:sessionId` | none |

### Frontend API Calls (all files)
- `api-client.ts` -- generic fetch wrapper, no project prefix
- `chat-tab.tsx` -- `/api/chat/sessions` POST
- `session-picker.tsx` -- `/api/chat/sessions` GET, DELETE
- `use-chat.ts` -- `/api/chat/sessions/:id/messages` GET, `/ws/chat/:id` WS
- `git-graph.tsx` -- `/api/git/graph/:project`, `/api/git/*` POST with body.project
- `git-status-panel.tsx` -- `/api/git/status/:project`, POST with body.project
- `file-store.ts` -- `/api/files/tree/:project`
- `code-editor.tsx` -- `/api/files/read/:project`, `/api/files/write/:project`
- `file-actions.tsx` -- `/api/files/create/:project`, etc.
- `diff-viewer.tsx` -- `/api/files/compare/:project`, `/api/git/file-diff/:project`
- `use-terminal.ts` -- `/ws/terminal/:id?project=`

### Tab Store
- Single global `ppm-tabs` key in localStorage
- No project awareness; all tabs shared across projects

---

## Target Architecture

### New URL Pattern
```
/api/project/:projectName/chat/...
/api/project/:projectName/git/...
/api/project/:projectName/files/...
/ws/project/:projectName/terminal/:id
/ws/project/:projectName/chat/:sessionId
```

`/api/projects` and `/api/auth/*` and `/api/health` stay global (no project scope).

### Key Design Decisions

1. **Hono middleware extracts `:projectName`** -- single `projectRouter` sub-app with middleware that resolves project path once, sets it on context. All child routes read from context instead of calling `resolveProjectPath` themselves.
2. **Git POST routes drop `project` from body** -- project comes from URL; body only carries action-specific data.
3. **Chat routes get project from URL** -- no more `dir` query or `projectName` body field.
4. **Tab store keyed by project name** -- `ppm-tabs-{projectName}` in localStorage. On project switch, store swaps persisted state.
5. **ApiClient gets `projectUrl(name)` helper** -- returns `/api/project/${encodeURIComponent(name)}` prefix; all feature calls use it.

---

## Phases

- [Phase 1: Backend project-scoped router](./phase-01-backend-project-router.md) -- 2h
- [Phase 2: Frontend API client + calls](./phase-02-frontend-api-migration.md) -- 2h
- [Phase 3: Per-project tab storage](./phase-03-per-project-tabs.md) -- 1.5h
- [Phase 4: WebSocket URL migration](./phase-04-websocket-migration.md) -- 0.5h

## Dependencies
- Phase 2 depends on Phase 1 (new routes must exist)
- Phase 3 is independent (can parallel with Phase 2)
- Phase 4 depends on Phase 1 (WS upgrade paths change in server index)

## Risk Assessment
- **Breaking change**: All frontend API calls change. No backward compat needed since this is a fresh v2 branch.
- **Chat sessions are currently global**: After refactor, sessions filter by project via URL. Existing sessions in storage may lack project association -- migration not needed since v2-fresh-start has no prod data.
- **Terminal WS path change**: Must update both foreground and daemon `Bun.serve()` blocks in `src/server/index.ts`.
