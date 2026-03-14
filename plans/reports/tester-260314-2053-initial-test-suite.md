# Tester Report — Initial Test Suite

**Date:** 2026-03-14
**Runner:** bun test v1.3.6

---

## Test Results Overview

| Metric | Value |
|--------|-------|
| Total tests | 106 |
| Passed | 106 |
| Failed | 0 |
| Skipped | 0 |
| Execution time | 3.65s |
| expect() calls | 157 |
| Files | 7 |

All tests pass.

---

## Files Created

**Setup**
- `tests/setup.ts` — shared helpers: `createTempDir`, `cleanupDir`, `createTempGitRepo`, `buildTestApp`

**Unit tests** (`tests/unit/services/`)
- `config-service.test.ts` — 18 tests
- `project-service.test.ts` — 17 tests
- `file-service.test.ts` — 22 tests
- `git-service.test.ts` — 14 tests

**Integration tests** (`tests/integration/api/`)
- `projects-api.test.ts` — 10 tests (incl. auth middleware)
- `files-api.test.ts` — 18 tests (incl. security/traversal)
- `git-api.test.ts` — 10 tests

---

## Coverage Areas

| Service | Happy path | Error/edge | Security |
|---------|-----------|------------|----------|
| ConfigService | load/save/get/set, env var fallback | missing file fallback | - |
| ProjectService | list/add/remove/resolve/scan | dup add, not-found remove, CWD resolve | - |
| FileService | tree/read/write/create/delete/rename | missing file, outside-project | `../` traversal (5 cases) |
| GitService | status/branches/graphData/stage/unstage/commit | - | - |
| Projects API | GET/POST/DELETE | 400/404 errors, dup add | 401 auth (3 cases) |
| Files API | all 6 endpoints | missing params, nonexistent paths | `../` traversal (2 cases) |
| Git API | status/branches/stage/commit/graph | unregistered project (500) | - |

---

## Issues Found & Fixed During Implementation

1. **`ConfigService.load(missingPath)` falls through to CWD `ppm.yaml`** — project root has a real `ppm.yaml` with `port: 5555`. Tests that pass a nonexistent path unintentionally loaded it. Fixed by always writing a real yaml file before calling `load()`.

2. **Global `configService` singleton in git routes** — `src/server/routes/git.ts` imports the global singleton, bypassing the injected config in `buildTestApp`. Fixed by mutating `configService.config.projects` directly in `beforeEach`/`afterEach`.

---

## Build Status

No build step required for tests. TypeScript resolves via Bun's native TS support. No type errors encountered during test execution.

---

## Recommendations

1. **Git service error paths** — no tests for invalid repo path (non-git dir). GitService throws from simple-git; worth adding negative cases.
2. **GitService.diff / fileDiff** — not covered. Low priority but used by git API routes.
3. **Auth middleware edge cases** — malformed `Authorization` header (no `Bearer ` prefix) not tested beyond the happy-path 401.
4. **`createGitRoutes()` uses global `configService`** — consider refactoring to accept injected service for better testability.

---

## Unresolved Questions

- Coverage report (`bun test --coverage`) not generated — Bun 1.3.6 coverage flags were not confirmed available. Run `bun test --coverage` to get line/branch metrics if needed.
