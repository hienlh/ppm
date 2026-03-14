# Phase 4 + 5 Implementation Report

## Executed Phase
- Phase: 04 (File Explorer API) + 05 (Terminal WebSocket)
- Plan: plans/260314-2009-ppm-implementation/
- Status: completed

## Files Modified
- `src/services/file.service.ts` (NEW, ~190 lines) — FileService with getTree, readFile, writeFile, createFile, deleteFile, renameFile, moveFile + security validation
- `src/server/routes/files.ts` (NEW, ~135 lines) — 7 REST endpoints for file CRUD, all using ok()/err() envelope
- `src/services/terminal.service.ts` (NEW, ~180 lines) — TerminalService with session management, Bun.spawn() stdin/stdout pipes, 10KB output buffer, idle timeout, reconnect grace period
- `src/server/ws/terminal.ts` (NEW, ~75 lines) — WebSocket handler: open/message/close, resize control protocol, session auto-create
- `src/server/index.ts` (MODIFIED) — mounted fileRoutes, wired WebSocket upgrade in Bun.serve() fetch handler

## Tasks Completed
- [x] FileService with full CRUD + tree operations
- [x] Path traversal prevention (normalize + startsWith check)
- [x] Blocked access to .git/, node_modules/, .env*
- [x] Binary file detection (base64 encoding for binary)
- [x] Sorted tree output (directories first, then alphabetical)
- [x] All 7 file routes mounted at /api/files/*
- [x] All routes use resolveProjectPath() for project NAME resolution
- [x] All responses wrapped in ok()/err() envelope
- [x] Custom error classes → proper HTTP status codes (403/404/400/500)
- [x] TerminalService with Bun.spawn() (NOT node-pty)
- [x] Session map with create/write/resize/kill/list/getBuffer
- [x] 10KB circular output buffer per session
- [x] Reconnect grace period (30s)
- [x] Idle session timeout (1h)
- [x] WebSocket handler with \x01RESIZE:cols,rows protocol
- [x] WS upgrade wired in both foreground and daemon Bun.serve()
- [x] Auto-create session on WS connect if project param provided

## Tests Status
- Type check: PASS (0 errors in owned files; 1 pre-existing error in src/web/ — not our ownership)
- Unit tests: N/A (test files outside ownership boundary)
- Integration tests: N/A

## Design Decisions
1. **Terminal resize**: No-op in pipe mode. Bun's `terminal` option is nightly-only; stdin:"pipe"/stdout:"pipe" works reliably. xterm.js still renders correctly client-side.
2. **stdin writing**: Uses Bun's FileSink API (`.write()` + `.flush()`) since `stdin:"pipe"` returns a FileSink, not a WritableStream.
3. **WebSocket typing**: Used conditional type extraction `Parameters<typeof Bun.serve>[0] extends { websocket?: infer W } ? W : never` to satisfy TypeScript without importing internal Bun WS types.

## Issues Encountered
- None. All owned files typecheck clean.

## Next Steps
- Frontend dev can now build against these endpoints
- Phase 6 (Git integration) can proceed independently
