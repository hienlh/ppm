# Tests

Run with `bun test` (all) or `bun test tests/integration/` (integration only).

## Windows note: run via Docker

On some Windows machines the host Bun segfaults on `bun test` / `bunx tsc`. Run inside a Linux Bun container instead:

```powershell
docker run --rm -v "C:\Users\PC\ppm:/app" -v /app/node_modules -w /app oven/bun:1.2 `
  sh -c 'bun install --silent && bun test tests/unit/services/scheduler-runner.test.ts'
```

- `-v /app/node_modules` (anonymous volume) keeps the host's Windows `node_modules` intact.
- Typecheck the same way: `bunx tsc --noEmit` inside the container (`npx tsc` on the host is a prank package — never trust it).
- Pipe output to a file under the mount when it's long; PowerShell truncates large stdout.

## Conventions

- Unit tests: `tests/unit/**` — services use `openTestDb()` + `setDb()` from `db.service.ts` for an isolated in-memory SQLite.
- Integration tests: `tests/integration/**` — Hono routes are exercised via `router.request(path, init)`, no live server.
- Mock modules with `mock.module()` BEFORE importing the module under test (see `scheduler-runner.test.ts`).
- Never hit the live Claude SDK in tests — mock `chatService`.
