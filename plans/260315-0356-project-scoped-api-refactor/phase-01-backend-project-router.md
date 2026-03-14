---
phase: 1
title: "Backend project-scoped router"
status: completed
effort: 2h
---

# Phase 1: Backend Project-Scoped Router

## Context
- [plan.md](./plan.md)
- `src/server/index.ts` -- main app, route mounting, WS upgrade
- `src/server/routes/chat.ts`, `git.ts`, `files.ts`
- `src/server/helpers/resolve-project.ts`
- `src/server/ws/terminal.ts`, `chat.ts`

## Overview
Create a Hono sub-router mounted at `/api/project/:projectName` with middleware that resolves the project path. Remount chat, git, files routes under it. Remove per-route `resolveProjectPath` calls.

## Architecture

```
app.route("/api/project/:projectName", projectScopedRouter)
  -> middleware: resolve projectName, set c.set("projectPath", path)
  -> projectScopedRouter.route("/chat", chatRoutes)
  -> projectScopedRouter.route("/git", gitRoutes)
  -> projectScopedRouter.route("/files", fileRoutes)
```

## Related Code Files

### Files to modify
- `src/server/index.ts` -- new mount point, update WS upgrade paths
- `src/server/routes/chat.ts` -- read projectPath from context, remove dir/projectName from query/body
- `src/server/routes/git.ts` -- read projectPath from context, remove `:project` param from each route, remove `project` from POST bodies
- `src/server/routes/files.ts` -- read projectPath from context, remove `:project` param from each route

### Files to create
- `src/server/routes/project-scoped.ts` -- the sub-router with middleware

### Files unchanged
- `src/server/routes/projects.ts` -- stays at `/api/projects` (global)
- `src/server/routes/static.ts` -- unchanged
- `src/server/middleware/auth.ts` -- unchanged

## Implementation Steps

### 1. Create project-scoped router (`src/server/routes/project-scoped.ts`)
```ts
import { Hono } from "hono";
import { resolveProjectPath } from "../helpers/resolve-project.ts";
import { chatRoutes } from "./chat.ts";
import { gitRoutes } from "./git.ts";
import { fileRoutes } from "./files.ts";

type Env = { Variables: { projectPath: string; projectName: string } };

export const projectScopedRouter = new Hono<Env>();

// Middleware: resolve project name to path
projectScopedRouter.use("*", async (c, next) => {
  const name = c.req.param("projectName");
  if (!name) return c.json({ ok: false, error: "Missing project name" }, 400);
  const projectPath = resolveProjectPath(name);
  c.set("projectPath", projectPath);
  c.set("projectName", name);
  await next();
});

projectScopedRouter.route("/chat", chatRoutes);
projectScopedRouter.route("/git", gitRoutes);
projectScopedRouter.route("/files", fileRoutes);
```

### 2. Update `src/server/index.ts`
- Replace separate route mounts:
  ```diff
  - app.route("/api/files", fileRoutes);
  - app.route("/api/chat", chatRoutes);
  - app.route("/api/git", gitRoutes);
  + app.route("/api/project/:projectName", projectScopedRouter);
  ```
- Keep: `app.route("/api/projects", projectRoutes)`
- Update WS upgrade paths (see Phase 4, but do now for consistency):
  ```diff
  - if (url.pathname.startsWith("/ws/terminal/"))
  + if (url.pathname.startsWith("/ws/project/"))
  ```
  Parse: `/ws/project/:projectName/terminal/:id` and `/ws/project/:projectName/chat/:sessionId`

### 3. Refactor `src/server/routes/git.ts`
- Remove `resolveProjectPath` import
- GET routes: remove `/:project` param segment; read `c.get("projectPath")` from context
  - `/status/:project` -> `/status`
  - `/diff/:project` -> `/diff`
  - `/diff-stat/:project` -> `/diff-stat`
  - `/file-diff/:project` -> `/file-diff`
  - `/graph/:project` -> `/graph`
  - `/branches/:project` -> `/branches`
  - `/pr-url/:project` -> `/pr-url`
- POST routes: remove `project` from `c.req.json()` destructuring; use `c.get("projectPath")`
  - `/stage`, `/unstage`, `/commit`, `/push`, `/pull`, `/branch/create`, `/checkout`, `/branch/delete`, `/merge`, `/cherry-pick`, `/revert`, `/tag`

### 4. Refactor `src/server/routes/files.ts`
- Remove `resolveProjectPath` import
- All routes: remove `/:project` param; use `c.get("projectPath")`
  - `/tree/:project` -> `/tree`
  - `/read/:project` -> `/read`
  - `/write/:project` -> `/write`
  - `/create/:project` -> `/create`
  - `/delete/:project` -> `/delete`
  - `/compare/:project` -> `/compare`
  - `/rename/:project` -> `/rename`
  - `/move/:project` -> `/move`

### 5. Refactor `src/server/routes/chat.ts`
- Remove `dir` query param from sessions list; project comes from URL context
- Remove `projectName` from POST body on session creation; use `c.get("projectName")`
- Keep `/providers` endpoint -- move to project-scoped or keep global. Decision: keep project-scoped since providers may vary per project in future.
- Sessions list: filter by `c.get("projectName")` instead of `dir` query

### 6. Update WS handlers in `src/server/index.ts`
- Terminal WS: `/ws/project/:projectName/terminal/:id`
  - Parse projectName from URL, pass to ws.data
  - Remove `?project=` query param
- Chat WS: `/ws/project/:projectName/chat/:sessionId`
  - Parse projectName from URL, pass to ws.data

### 7. Update daemon `Bun.serve()` block (bottom of index.ts)
- Same WS path changes as foreground server

## Todo List
- [x] Create `src/server/routes/project-scoped.ts`
- [x] Update `src/server/index.ts` mounting
- [x] Refactor `git.ts` routes (17 endpoints)
- [x] Refactor `files.ts` routes (8 endpoints)
- [x] Refactor `chat.ts` routes (4 endpoints)
- [x] Update WS upgrade paths (foreground + daemon)
- [x] Verify compile with `bun build`

## Success Criteria
- All routes respond at new paths
- No `resolveProjectPath` calls in individual route files (only in middleware)
- Git POST routes no longer require `project` in body
- WS connections work at new paths
