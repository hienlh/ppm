---
name: PPM test conventions and gotchas
description: Key patterns, pitfalls, and setup details for writing tests in the PPM project
type: project
---

## Test runner: `bun test` (Jest-compatible API from `bun:test`)

## Test structure
- `tests/setup.ts` — shared helpers: `createTempDir`, `cleanupDir`, `createTempGitRepo`, `buildTestApp`
- `tests/unit/services/` — unit tests for ConfigService, ProjectService, FileService, GitService
- `tests/integration/api/` — integration tests using `app.request()` (no real server needed)

## Critical gotchas

### ppm.yaml in CWD
The project root has a real `ppm.yaml` with `port: 5555`. `ConfigService.load(missingPath)` falls through to `LOCAL_CONFIG = "ppm.yaml"` in CWD when the given path doesn't exist. Always write an actual file before calling `load()` to avoid picking up this real config.

### Global configService in git routes
`src/server/routes/git.ts` imports and uses the global `configService` singleton (not injected). Integration tests for git API must mutate `configService.config.projects` directly to register the test repo. Restore to `[]` in `afterEach`.

### ConfigService.load() fallback behavior
Candidates checked in order: explicit path → PPM_CONFIG env → LOCAL_CONFIG (ppm.yaml) → HOME_CONFIG (~/.ppm/config.yaml). A missing explicit path does NOT stop the fallback chain.

### buildTestApp in setup.ts
Overrides `configService.save = () => {}` (no-op) to prevent tests writing to disk. Injects config directly by mutating private fields via `as unknown as`.

### Real git repos for git tests
`createTempGitRepo()` uses `Bun.spawn` with git env vars (author name/email) to create a real repo with an initial commit. No mocks for git operations.

**Why:** Tests must use real implementations — no fakes/mocks that diverge from production behavior.
**How to apply:** Always use `createTempGitRepo` for anything touching GitService or git API routes.
