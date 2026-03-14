# Phase 10: Testing

**Owner:** tester
**Priority:** High
**Depends on:** Runs continuously after each phase completes
**Effort:** Large

## Overview

Comprehensive unit + integration tests for both backend services AND frontend logic. E2E smoke tests for full flow.

## Test Framework

- **Runner:** `bun test` (built-in, Jest-compatible)
- **HTTP testing:** Hono test client (`app.request()`)
- **WS testing:** Native WebSocket client in Bun
- **Frontend logic testing:** `bun test` for store/lib/hook logic (no DOM needed for pure logic)

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
│   │   ├── terminal.service.test.ts
│   │   └── chat.service.test.ts
│   ├── providers/
│   │   ├── claude-agent-sdk.test.ts
│   │   └── registry.test.ts
│   ├── cli/
│   │   └── project-resolver.test.ts
│   ├── server/
│   │   ├── resolve-project.test.ts
│   │   └── auth-middleware.test.ts
│   └── web/
│       ├── stores/
│       │   ├── tab.store.test.ts
│       │   ├── project.store.test.ts
│       │   └── settings.store.test.ts
│       ├── lib/
│       │   ├── api-client.test.ts
│       │   ├── ws-client.test.ts
│       │   └── git-graph-layout.test.ts
│       └── hooks/
│           └── use-websocket.test.ts
├── integration/
│   ├── api/
│   │   ├── auth.test.ts
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

**Config Service:**
- [ ] Loads config from `./ppm.yaml` when present
- [ ] Falls back to `~/.ppm/config.yaml` when no local config
- [ ] Creates default config with generated auth token on first run
- [ ] `get('port')` returns configured port
- [ ] `set('port', 9090)` persists change to file
- [ ] Invalid YAML file → throws descriptive error

**Project Service:**
- [ ] `add("/path/to/repo", "myrepo")` adds project to config
- [ ] `add` with duplicate name → throws error
- [ ] `remove("myrepo")` removes project from config
- [ ] `list()` returns all registered projects
- [ ] `resolve("myrepo")` returns project by name
- [ ] `resolve` from CWD → auto-detects project when CWD is inside registered project path
- [ ] `resolve("nonexistent")` → throws "Project not found" error
- [ ] `scanForGitRepos(dir)` finds `.git` directories recursively

**Auth Middleware:**
- [ ] Valid Bearer token → passes, sets context
- [ ] Missing Authorization header → 401 `{ ok: false, error: "Unauthorized" }`
- [ ] Invalid token → 401
- [ ] `auth.enabled: false` in config → all requests pass without token
- [ ] Token from config matches what's checked

**Server:**
- [ ] Server starts on configured port
- [ ] `GET /api/health` returns 200
- [ ] SPA fallback: `GET /nonexistent` returns `index.html` (not 404)
- [ ] API 404: `GET /api/nonexistent` returns 404 JSON

**Resolve Project Helper:**
- [ ] `resolveProjectPath("ppm")` → returns path from config
- [ ] `resolveProjectPath("/absolute/path")` → validates path is within registered project
- [ ] `resolveProjectPath("../escape")` → throws (path traversal)

### Phase 3 Tests (Frontend Logic)

**Tab Store:**
- [ ] `openTab({type: 'terminal', title: 'Terminal'})` adds tab and returns id
- [ ] `openTab` with duplicate type+metadata → returns existing tab id (no duplicate)
- [ ] `closeTab(id)` removes tab from list
- [ ] `closeTab` on last tab → activeTabId becomes null
- [ ] `setActiveTab(id)` updates activeTabId
- [ ] `updateTab(id, {title: 'new'})` updates tab properties
- [ ] Closing active tab → activates previous tab (not first, not null)

**API Client:**
- [ ] `get<T>('/api/projects')` unwraps `{ok: true, data: [...]}` → returns `[...]`
- [ ] Server returns `{ok: false, error: "Not found"}` → throws Error with "Not found" message
- [ ] Server returns HTTP 500 → throws Error
- [ ] Bearer token header sent on every request when token is set
- [ ] No Authorization header when token is null/undefined

**WS Client:**
- [ ] Connects to WebSocket URL
- [ ] Auto-reconnects on close with exponential backoff (1s, 2s, 4s)
- [ ] Max reconnect delay caps at 30s
- [ ] `send()` queues messages if not connected, sends on reconnect
- [ ] `onMessage` callback fires for incoming messages
- [ ] `disconnect()` stops reconnect attempts

**Git Graph Layout:**
- [ ] Single branch → all commits in lane 0
- [ ] Two branches → merge commit connects lanes correctly
- [ ] Lane reuse: closed branch lane gets reused by next branch
- [ ] Empty commits list → returns empty layout

### Phase 4 Tests (File Explorer)

**File Service:**
- [ ] `getTree(projectPath)` returns nested FileNode structure
- [ ] `getTree` excludes `.git/`, `node_modules/`
- [ ] `readFile(path)` returns content as string
- [ ] `readFile` for binary file → returns base64 with encoding flag
- [ ] `writeFile(path, content)` creates/updates file
- [ ] `createFile(path, 'file')` creates empty file
- [ ] `createFile(path, 'directory')` creates directory
- [ ] `deleteFile(path)` removes file
- [ ] `renameFile(old, new)` renames file
- [ ] Path traversal: `readFile("../../etc/passwd")` → throws error
- [ ] Access `.git/config` → throws error
- [ ] Access `.env` → throws error

**File API Integration:**
- [ ] `GET /api/files/tree/myproject` returns file tree (project resolved by name)
- [ ] `GET /api/files/read?path=src/index.ts` returns file content
- [ ] `PUT /api/files/write` with `{path, content}` writes file
- [ ] `DELETE /api/files/delete` with `{path}` removes file
- [ ] Invalid project name → 404
- [ ] Path outside project → 403

### Phase 5 Tests (Terminal)

**Terminal Service:**
- [ ] `create({projectPath})` spawns shell process and returns session
- [ ] `get(id)` returns existing session
- [ ] `get(nonexistent)` returns undefined
- [ ] `write(id, "ls\n")` sends input to PTY
- [ ] `onData(id, handler)` receives shell output
- [ ] `kill(id)` terminates process and removes session
- [ ] `list()` returns all active sessions
- [ ] Output buffer: last 10KB of output stored per session

**Terminal WS Integration:**
- [ ] Connect to `/ws/terminal/:id` → creates new PTY if not exists
- [ ] Send keystroke via WS → appears in PTY
- [ ] PTY output → arrives via WS message
- [ ] Send resize control message → PTY resizes (if supported)
- [ ] Disconnect WS → PTY stays alive for 30s
- [ ] Reconnect within 30s → receives buffered output
- [ ] Reconnect after timeout → session dead, returns error
- [ ] Multiple WS clients to same session → both receive output

### Phase 6 Tests (Git)

**Git Service (using real temp repos):**
- [ ] `status(path)` → returns modified/staged/untracked files
- [ ] `stage(path, ["file.txt"])` → file appears in staged list
- [ ] `unstage(path, ["file.txt"])` → file moves back to unstaged
- [ ] `commit(path, "msg")` → creates commit, returns hash
- [ ] `commit` with nothing staged → throws error
- [ ] `branches(path)` → returns branch list with current marked
- [ ] `createBranch(path, "feature")` → branch exists
- [ ] `checkout(path, "feature")` → current branch changes
- [ ] `deleteBranch(path, "feature")` → branch removed
- [ ] `deleteBranch` on current branch → throws error
- [ ] `graphData(path)` → returns commits with parents, refs, branch info
- [ ] `graphData` uses simple-git `.log()` (not manual parse) → no garbled data on multi-line commit messages
- [ ] `diff(path)` → returns unified diff string
- [ ] `fileDiff(path, "file.txt")` → returns diff for specific file
- [ ] `getCreatePrUrl(path, "feature")` → returns GitHub PR URL from remote

**Git API Integration:**
- [ ] `GET /api/git/status/myproject` → status JSON (project resolved by name)
- [ ] `POST /api/git/commit` with `{project: "myproject", message: "test"}` → creates commit
- [ ] `GET /api/git/graph/myproject?max=50` → returns graph data with ≤50 commits
- [ ] All git routes resolve project by NAME, not path

### Phase 7 Tests (AI Chat)

**Provider Registry:**
- [ ] `register(provider)` adds provider
- [ ] `get("claude")` returns Claude provider
- [ ] `get("nonexistent")` returns undefined
- [ ] `list()` returns all provider infos
- [ ] `getDefault()` returns first registered provider

**Chat Service (mock provider):**
- [ ] `createSession("mock", config)` → returns session with id
- [ ] `sendMessage("mock", sessionId, "hello")` → yields ChatEvent stream
- [ ] `listSessions()` → returns session list
- [ ] `deleteSession("mock", sessionId)` → session removed from list

**Chat WS Integration:**
- [ ] Connect to `/ws/chat/:sessionId` → WS opens
- [ ] Send `{type: "message", content: "hello"}` → receives streamed response events
- [ ] Receive `{type: "approval_request"}` → send `{type: "approval_response", approved: true}` → tool executes
- [ ] Approval denied → AI receives denial message
- [ ] `{type: "done"}` received at end of response
- [ ] Error in provider → `{type: "error", message: "..."}` sent via WS

**Chat REST API:**
- [ ] `GET /api/chat/sessions` → list of all sessions
- [ ] `GET /api/chat/sessions/:id/messages` → message history for session
- [ ] Reconnect flow: disconnect WS → GET messages via REST → reconnect WS → no messages lost

### Phase 8 Tests (CLI)

**Project Resolver:**
- [ ] `-p myproject` flag → resolves to correct project
- [ ] No flag, CWD inside project → auto-detects
- [ ] No flag, CWD not in any project → throws descriptive error

**CLI Commands (capture stdout):**
- [ ] `ppm projects list` → outputs table with project names and paths
- [ ] `ppm projects add /tmp/repo --name test` → adds project
- [ ] `ppm git status -p myproject` → outputs colored status
- [ ] `ppm git commit -p myproject -m "test"` → commits and prints hash
- [ ] `ppm chat list -p myproject` → outputs session table

### Phase 9 Tests (Build)
- [ ] `bun run build` completes without errors
- [ ] Built binary serves frontend at `http://localhost:<port>/`
- [ ] Built binary serves API at `/api/*`
- [ ] PWA manifest accessible at expected path

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

// Create test Hono app with test config
export function createTestApp(config?: Partial<PpmConfig>): Hono {
  // Wire up routes with test config, return app instance
}

// Wait for WS message matching predicate
export async function waitForWsMessage(ws: WebSocket, predicate: (msg: any) => boolean, timeout = 5000): Promise<any> {
  // Returns first message matching predicate, throws on timeout
}
```

## Mock Strategy

- **Git operations:** Use real temp git repos (no mocking git)
- **AI Provider:** Mock provider implementing AIProvider interface (no real API calls)
- **File system:** Use temp directories (real FS, no mocking)
- **WebSocket:** Use real WS connections to test server
- **Auth:** Test with both `auth.enabled: true` (with token) and `auth.enabled: false`

## Coverage Target

- Services: 80%+
- API routes: 80%+
- CLI commands: 70%+
- Frontend stores/lib/hooks: 80%+
- Frontend components: Manual testing (visual verification)

## Success Criteria

- [ ] `bun test` runs all tests (unit + integration)
- [ ] No tests use fake data/mocks that mask real behavior
- [ ] Git tests use real temp repos with real git operations
- [ ] API tests use real HTTP requests via Hono test client
- [ ] WS tests verify full protocol correctness (connect, send, receive, reconnect)
- [ ] Frontend store tests verify state transitions and edge cases
- [ ] API client tests verify envelope unwrapping and error handling
- [ ] All tests pass before merge — failing tests block PR
- [ ] Test output includes file/line for failures (easy to locate)
