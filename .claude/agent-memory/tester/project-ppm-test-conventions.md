---
name: PPM test conventions and gotchas
description: Key patterns, pitfalls, and setup details for writing tests in the PPM project
type: project
---

## Test runner: `bun test` (Jest-compatible API from `bun:test`)

## Test structure
- `tests/test-setup.ts` — isolates PPM_HOME to temp dir, creates in-memory DB, disables auth
- `tests/unit/` — unit tests for services, routes, utilities
- `tests/integration/` — integration tests using `app.request()` or real git operations
- Test files use `.test.ts` suffix and live colocated with or in `__tests__` subdirs

## Critical gotchas

### ppm.yaml in CWD
The project root has a real `ppm.yaml` with `port: 5555`. `ConfigService.load(missingPath)` falls through to `LOCAL_CONFIG = "ppm.yaml"` in CWD when the given path doesn't exist. Always write an actual file before calling `load()` to avoid picking up this real config.

### Global configService in git routes
`src/server/routes/git.ts` imports and uses the global `configService` singleton (not injected). Integration tests for git API must mutate `configService.config.projects` directly to register the test repo. Restore to `[]` in `afterEach`.

### ConfigService.load() behavior
Config is stored in SQLite (`~/.ppm/ppm.db`). If an explicit YAML path is given via `-c` flag, it is imported into SQLite first. Legacy YAML files (`config.yaml`) are auto-migrated to SQLite on first load via `migrateYamlIfNeeded()`.

### buildTestApp in setup.ts
Overrides `configService.save = () => {}` (no-op) to prevent tests writing to disk. Injects config directly by mutating private fields via `as unknown as`.

### Real git repos for git tests
Use `Bun.spawn` with git env vars (author name/email) to create real repos. Capture stdout with `stdout: "pipe"` and read via `new Response(proc.stdout).text()`. No mocks for git operations.

**Why:** Tests must use real implementations — no fakes/mocks that diverge from production behavior.
**How to apply:** For git operations, always spawn real `git` commands; for unit tests of parsers, use sample data but validate against real git output.

## Bun.spawn patterns for tests

**For subprocess output capture:**
```ts
const proc = Bun.spawn(["git", "log", ...], {
  cwd,
  env,
  stdout: "pipe",
  stderr: "pipe",
});
const stdout = await new Response(proc.stdout).text();
const exitCode = await proc.exited;
```

**For git commands with author info:**
```ts
const env = {
  GIT_AUTHOR_NAME: "Test Author",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "Test Committer",
  GIT_COMMITTER_EMAIL: "committer@example.com",
};
```
