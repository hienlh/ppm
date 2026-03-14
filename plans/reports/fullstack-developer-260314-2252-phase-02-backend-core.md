# Phase 2: Backend Core — Implementation Report

## Status: COMPLETED

## Files Created/Modified

| File | Action | Lines |
|------|--------|-------|
| `src/services/config.service.ts` | Created | 89 |
| `src/services/project.service.ts` | Created | 84 |
| `src/server/index.ts` | Replaced | 82 |
| `src/server/middleware/auth.ts` | Created | 27 |
| `src/server/routes/projects.ts` | Created | 36 |
| `src/server/routes/static.ts` | Created | 24 |
| `src/server/helpers/resolve-project.ts` | Created | 19 |
| `src/cli/commands/init.ts` | Replaced | 52 |
| `src/cli/commands/start.ts` | Created | 3 |
| `src/cli/commands/stop.ts` | Replaced | 32 |
| `src/cli/commands/open.ts` | Replaced | 17 |
| `src/cli/utils/project-resolver.ts` | Created | 27 |
| `src/index.ts` | Replaced | 46 |

## Tasks Completed

- [x] Config Service — load/save ppm.yaml, search order, auto-generate token
- [x] Project Service — CRUD (list, add, remove), resolve, scanForGitRepos
- [x] Hono Server — auth middleware, project routes, static SPA fallback, WS-ready
- [x] Auth Middleware — Bearer token check, skip when disabled, 401 envelope
- [x] Auth Check Route — `GET /api/auth/check`
- [x] Project Routes — GET list, POST add, DELETE remove (all envelope-wrapped)
- [x] Static Route — serve dist/web/ with SPA fallback
- [x] Resolve Project Helper — name-first lookup, path fallback with validation
- [x] CLI init — scan .git repos, register projects, create config
- [x] CLI start — foreground + daemon mode (-d flag, PID file)
- [x] CLI stop — read PID file, kill process
- [x] CLI open — platform-aware browser open
- [x] CLI project resolver — CWD auto-detect + -p flag

## V1 Lessons Applied

1. API envelope: all responses wrapped in `{ok, data}` using helpers from `src/types/api.ts`
2. Project resolution: `resolveProjectPath()` does name-first lookup, path fallback
3. No node-pty anywhere — `Bun.spawn()` used for daemon mode
4. Config auto-generates auth token on first run if empty

## Tests Status

- Typecheck: PASS (0 backend errors; 8 frontend errors in src/web/ owned by Phase 3)
- CLI `--help`: PASS
- Server health endpoint: PASS — `{ok: true, data: {status: "running"}}`
- Auth middleware: PASS — 401 without token, 200 with valid token
- Auth check route: PASS — `{ok: true, data: true}`
- Projects endpoint: PASS — `{ok: true, data: []}`

## Issues

None blocking. Frontend type errors are expected (Phase 3 hasn't created those components yet).
