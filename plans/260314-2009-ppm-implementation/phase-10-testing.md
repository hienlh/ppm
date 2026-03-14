# Phase 10: Testing

**Owner:** tester
**Priority:** Medium
**Depends on:** Runs continuously after each phase completes
**Effort:** Medium

## Overview

Unit tests for services, integration tests for API + WebSocket, basic E2E smoke tests.

## Test Framework

- **Runner:** `bun test` (built-in, Jest-compatible)
- **HTTP testing:** Hono test client (`app.request()`)
- **WS testing:** Native WebSocket client in Bun

## Test Structure
```
tests/
├── setup.ts                      # Global setup (test config, temp dirs)
├── unit/
│   ├── services/
│   │   ├── config.service.test.ts
│   │   ├── project.service.test.ts
│   │   ├── file.service.test.ts
│   │   ├── git.service.test.ts
│   │   └── chat.service.test.ts
│   ├── providers/
│   │   └── claude-agent-sdk.test.ts
│   └── cli/
│       └── project-resolver.test.ts
├── integration/
│   ├── api/
│   │   ├── projects.test.ts
│   │   ├── files.test.ts
│   │   └── git.test.ts
│   └── ws/
│       ├── terminal.test.ts
│       └── chat.test.ts
└── e2e/
    └── smoke.test.ts             # Full flow: init → start → use → stop
```

## Test Strategy Per Phase

### Phase 2 Tests (Backend Core)
- Config service: load, save, get, set, defaults
- Project service: add, remove, list, resolve from CWD
- Auth middleware: valid token passes, invalid rejects, disabled skips
- Server starts and responds to health check

### Phase 4 Tests (File Explorer)
- File service: CRUD operations, tree generation
- Security: path traversal blocked, .git access blocked
- API: file routes return correct data

### Phase 5 Tests (Terminal)
- Terminal service: create, write, resize, kill
- WS: connect, receive data, send keystrokes (integration)

### Phase 6 Tests (Git)
- Git service: status, stage, commit, branch ops (use temp git repo)
- Graph data: lane allocation returns valid layout
- API: git routes work correctly

### Phase 7 Tests (AI Chat)
- Provider registry: register, get, list
- Chat service: create session, send message (mock provider)
- WS: chat protocol messages correct format
- Tool approval flow (mock)

### Phase 8 Tests (CLI)
- Project resolver: CWD detection, -p flag, error on not found
- CLI commands: test output format (capture stdout)

## Test Utilities

```typescript
// tests/setup.ts
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';

// Create temp git repo for testing
export function createTestRepo(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'ppm-test-'));
  execSync('git init', { cwd: dir });
  execSync('git commit --allow-empty -m "init"', { cwd: dir });
  return dir;
}

// Create test config
export function createTestConfig(overrides?: Partial<PpmConfig>): PpmConfig {
  return { port: 0, host: '127.0.0.1', auth: { enabled: false }, projects: [], ...overrides };
}

// Create test Hono app
export function createTestApp(): Hono {
  // Wire up routes with test config
}
```

## Mock Strategy

- **Git operations:** Use real temp git repos (no mocking git)
- **AI Provider:** Mock provider implementing AIProvider interface (no real API calls)
- **File system:** Use temp directories (real FS, no mocking)
- **WebSocket:** Use real WS connections to test server

## Coverage Target

- Services: 80%+
- API routes: 70%+
- CLI commands: 60%+
- Frontend: Manual testing (no unit tests for UI initially)

## Success Criteria

- [ ] `bun test` runs all tests
- [ ] No tests use fake data/mocks that mask real behavior
- [ ] Git tests use real temp repos
- [ ] API tests use real HTTP requests
- [ ] WS tests verify protocol correctness
- [ ] All tests pass before merge
