# PPM System Architecture

This file holds the cross-cutting picture: the layer map, the protocols every feature speaks, auth,
deployment and the error/security posture. Subsystem detail lives beside it:

| Document | Covers |
|---|---|
| [AI Chat & Providers](architecture/ai-chat-and-providers.md) | Provider adapters, AI configuration, the persistent chat streaming session |
| [Extension System](architecture/extensions.md) | Manifest, lifecycle, RPC, worker isolation, contribution registry, dev workflow |
| [Data & Storage](architecture/data-and-storage.md) | SQLite schema and access, database viewer, MCP server management, group-chat model |
| [Workspace & UI](architecture/workspace-and-ui.md) | Workspace switching, editor, terminal, git, file service, OS File Explorer, tab-host windows and Document PiP |
| [Integrations](architecture/integrations.md) | PPMBot Telegram coordinator, Jira watcher auto-debug |

## High-Level Architecture

```
┌──────────────────────────────────────────────────────────────────────┐
│                         User Devices                                  │
│  ┌─────────────────┐  ┌──────────────┐  ┌──────────────────────────┐ │
│  │   Desktop/Tab   │  │  Mobile/iPad │  │  Terminal (CLI mode)     │ │
│  │  Web Browser    │  │  Web Browser │  │  STDIN → ppm chat        │ │
│  └────────┬────────┘  └──────┬───────┘  └────────────┬─────────────┘ │
│           │                   │                        │                │
│           └───────────────────┼────────────────────────┘                │
│                               │ HTTP/WebSocket                          │
├──────────────────────────────┼────────────────────────────────────────┤
│                     PPM Server (Bun)                                    │
│  ┌────────────────────────────────────────────────────────────────┐   │
│  │           Hono HTTP Framework (default port 3210)              │   │
│  ├────────────────────────────────────────────────────────────────┤   │
│  │  Routes (src/server/routes/)                                   │   │
│  │  ┌──────────────────┐  ┌──────────────────┐  ┌──────────────┐  │   │
│  │  │ /api/projects    │  │ /api/project/:n/ │  │ /api/db/*    │  │   │
│  │  │ (CRUD projects)  │  │ (scoped routes)  │  │ (connections)│  │   │
│  │  └──────────────────┘  └──────────────────┘  └──────────────┘  │   │
│  ├────────────────────────────────────────────────────────────────┤   │
│  │  Services (src/services/)                                      │   │
│  │  ┌───────────────────────────────────────────────────────────┐│   │
│  │  │ ChatService │ GitService │ FileService │ TerminalService ││   │
│  │  │ (streaming  │ (simple-   │ (read/write │ (PTY/shell)     ││   │
│  │  │  messages)  │  git)      │  files)     │ (Bun.spawn)     ││   │
│  │  │ TableCache  │ DbService  │ DatabaseAdapterRegistry         ││   │
│  │  │ (metadata)  │ (SQLite)   │ (SQLite, PostgreSQL adapters)   ││   │
│  │  └───────────────────────────────────────────────────────────┘│   │
│  ├────────────────────────────────────────────────────────────────┤   │
│  │  Providers (src/providers/)                                    │   │
│  │  ┌──────────────────────────────────────────────────────────┐ │   │
│  │  │ ProviderRegistry (routes to active AI provider)         │ │   │
│  │  │ ┌───────────────────────┬──────────────────────────┐   │ │   │
│  │  │ │ claude-agent-sdk      │ mock-provider (test)    │   │ │   │
│  │  │ │ @anthropic/SDK (prim) │ Returns canned resp.   │   │ │   │
│  │  │ └───────────────────────┴──────────────────────────┘   │ │   │
│  │  └──────────────────────────────────────────────────────────┘ │   │
│  └────────────────────────────────────────────────────────────────┘   │
│                                                                        │
│  Config & State (src/services/)                                       │
│  ┌──────────────────┐  ┌──────────────────┐  ┌─────────────────┐    │
│  │ SQLite DB        │  │ Git Repos        │  │ Session Storage │    │
│  │ (config, projs)  │  │ (local disk)     │  │ (SQLite + SDK)  │    │
│  │ (session map)    │  │                  │  │ (session_map,   │    │
│  │ (push subs,      │  │ Connections:     │  │  session_logs,  │    │
│  │  usage, logs)    │  │ • SQLite files   │  │  usage_history) │    │
│  │ (connections)    │  │ • PostgreSQL svr │  │  (connections)  │    │
│  │ (table metadata) │  │   via connStr    │  │                 │    │
│  └──────────────────┘  └──────────────────┘  └─────────────────┘    │
└──────────────────────────────────────────────────────────────────────┘
        ↓↑
   ┌────────────────────────────────────────────────┐
   │  Filesystem Access (Local Only)                │
   │  • Project directories (git repos)             │
   │  • File read/write operations                  │
   │  • SQLite database (~/.ppm/ppm.db)              │
   │  • Config database (~/.ppm/ppm.db)                │
   └────────────────────────────────────────────────┘
```

## Layer Descriptions

### Presentation Layer (Browser/CLI)
**Components:** React frontend + CLI commands

**Responsibilities:**
- Render UI for file explorer, editor, terminal, chat
- Project switching with visual indicators (avatars, colors, keep-alive workspaces)
- Capture user input (text, file uploads, terminal commands)
- Display streaming responses, terminal output
- Handle authentication (token in localStorage)

**Key Files:**
- `src/web/app.tsx` — Root React component
- `src/web/components/layout/project-bar.tsx` — Narrow left sidebar with project avatars (52px width)
- `src/web/components/layout/project-bottom-sheet.tsx` — Mobile project switcher (bottom sheet)
- `src/web/components/layout/sidebar.tsx` — Main sidebar with Explorer/Git/History tabs
- `src/web/components/chat/chat-history-panel.tsx` — History tab content (chat sessions)
- `src/web/components/` — UI components
- `src/cli/commands/` — CLI command handlers

---

### HTTP API Layer (Hono)
**Component:** Hono framework, request routing

**Responsibilities:**
- Parse HTTP requests, validate tokens
- Route to correct handler (projects, chat, git, files)
- Format responses in `ApiResponse` envelope
- Handle WebSocket upgrades

**Key Files:**
- `src/server/index.ts` — Server setup, middleware chain
- `src/server/routes/projects.ts` — Project CRUD
- `src/server/routes/project-scoped.ts` — Mount per-project routes
- `src/server/middleware/auth.ts` — Token validation

**Routes:**
```
GET    /api/health              → Health check
GET    /api/auth/check          → Verify auth token
GET    /api/settings/ai         → Get AI provider settings
PUT    /api/settings/ai         → Update AI provider settings
GET    /api/accounts            → List all accounts (sanitized)
POST   /api/accounts            → Create account (encrypt & store token)
GET    /api/accounts/:id        → Get account (sanitized, no token)
PUT    /api/accounts/:id        → Update account (name, priority)
DELETE /api/accounts/:id        → Delete account
POST   /api/accounts/:id/activate → Set as active account
POST   /api/projects            → Create project
GET    /api/projects            → List projects
DELETE /api/projects/:name      → Delete project
PATCH  /api/projects/reorder    → Reorder projects by name order
PATCH  /api/projects/:name/color → Set project color (hex string)
POST   /api/projects/:name/image  → Upload project avatar (multipart, 2MB cap, center-crop to 128×128 webp)
GET    /api/projects/:name/image  → Stream project avatar (immutable cache, path-traversal guard)
DELETE /api/projects/:name/image  → Remove project avatar (reverts to color+initials)
GET    /api/project/:name/chat/sessions           → List sessions
POST   /api/project/:name/chat/sessions           → Create session
GET    /api/project/:name/chat/sessions/:id/messages → { messages, versionMap } — versionMap keys are user-msg ordinals (stable across forks); an absent ordinal means that message has no edited versions
GET    /api/project/:name/chat/sessions/running    → Sessions with a turn in flight (in-memory registry, no DB) — lets the tab strip and title indicator show a running session whose chat tab is not mounted
DELETE /api/project/:name/chat/sessions/:id       → Delete session (leaf-only: 409 if it has edited children)
GET    /api/project/:name/chat/drafts/:sessionId  → Get draft (or null)
PUT    /api/project/:name/chat/drafts/:sessionId  → Save/update draft
DELETE /api/project/:name/chat/drafts/:sessionId  → Clear draft
GET    /api/project/:name/chat/sessions/:id/tasks → Get current task state (TaskCreate/TaskUpdate/TaskStop tracking from session JSONL)
GET    /api/project/:name/git/status              → Git status
GET    /api/project/:name/git/diff                → Diff
POST   /api/project/:name/git/stage               → Stage file
POST   /api/project/:name/git/commit              → Commit
GET    /api/project/:name/files/tree              → Directory tree
GET    /api/project/:name/files/raw               → File content
PUT    /api/project/:name/files/write             → Write file
GET    /api/db/connections                        → List all connections
POST   /api/db/connections                        → Create connection (SQLite/PostgreSQL)
GET    /api/db/connections/:id                    → Get connection (sanitized)
PUT    /api/db/connections/:id                    → Update connection (toggle readonly, UI-only)
DELETE /api/db/connections/:id                    → Delete connection
GET    /api/db/connections/:id/tables             → List tables (with sync)
GET    /api/db/connections/:id/tables/:table      → Get table schema + data
POST   /api/db/connections/:id/query              → Execute query (readonly checked)
PATCH  /api/db/connections/:id/cell               → Update cell value (single)
GET    /api/upgrade/status                        → Get current + available versions, install method
POST   /api/upgrade/apply                         → Install new version, trigger supervisor self-replace
GET    /api/project/:name/workspace               → Get saved workspace layout + metadata
PUT    /api/project/:name/workspace               → Save workspace layout (layout JSON)
GET    /api/project/:name/chat/slash-items        → List slash commands/skills (optional ?q=<query> for fuzzy search)
GET    /api/projects/:path/tags                   → List project tags with session counts
POST   /api/projects/:path/tags                   → Create tag
PATCH  /api/projects/:path/tags/:id               → Update tag (name, color, sortOrder)
DELETE /api/projects/:path/tags/:id               → Delete tag
PATCH  /api/projects/:path/default-tag            → Set project default tag
PATCH  /api/project/:name/chat/sessions/:id/tag   → Assign tag to session
DELETE /api/project/:name/chat/sessions/:id/tag   → Remove tag from session
PATCH  /api/project/:name/chat/sessions/bulk-tag  → Bulk assign tag to multiple sessions
WS     /ws/project/:name/chat/:sessionId          → Chat streaming (per session)
WS     /ws/project/:name/terminal/:id             → Terminal I/O
WS     /ws/global                                 → App-wide event bus: owns project file watching (client sends {type:"watch", projectName}) and delivers file:changed / session:unread_changed / session:phase_changed / jira:* . Must NOT ride on the chat WS — chat tabs mount lazily, so a chat socket is not guaranteed to exist.
WS     /ws/extensions                             → Extension UI bridge
```

**URL Format (Deterministic Tabs, v0.8.77+):**
```
/project/{name}                          → Project root (project switcher)
/project/{name}/editor/{filePath}        → Open editor tab (e.g., src/index.ts)
/project/{name}/conflict-editor/{filePath} → Open conflict resolution editor (during merge/rebase)
/project/{name}/chat/{provider}/{sessionId} → Open chat tab
/project/{name}/terminal/{index}         → Open terminal tab
/project/{name}/database/{connId}/{table} → Open database browser
/project/{name}/git-graph                → Git history graph (singleton)
/project/{name}/settings                 → Settings panel (singleton)
```
Tab IDs are deterministic: `{type}:{identifier}` (e.g., `editor:src/index.ts`, `conflict-editor:src/file.ts`, `chat:claude/abc123`). Deep links auto-create missing tabs.

---

### Service Layer (Business Logic)
**Components:** Singleton service modules

**Responsibilities:**
- Implement core business logic (chat, git, files, terminal)
- Manage dependencies (file paths, command execution)
- Coordinate between providers and data sources
- Validate input and propagate errors

**Services:**

| Service | Purpose | Key Methods |
|---------|---------|-------------|
| **ChatService** | Session management, message streaming | createSession, streamMessage, getHistory |
| **SessionBranchService** | Edit-message global branch tree (`session_branches` table) — links forked sessions, resolves version groups, collapses history to per-tree heads. `resolveVersionMap` batches every ordinal's group for a session in 2 queries (the per-ordinal `resolveVersionGroup` walks the ancestor chain with one query per hop) | recordBranch, resolveVersionGroup, resolveVersionMap, collapseTreesToHeads, hasChildren, getTreeByRoot |
| **TaskStatusAggregator** | Rebuild Claude Task* state from session JSONL (TaskCreate/TaskUpdate/TaskStop tracking) | aggregateTasks |
| **ConfigService** | Config in SQLite, dotted keys with a typed cache | load, get, set, getToken |
| **DbService** | SQLite persistence (WAL, schema v41, connections/accounts/workspace CRUD) | getDb, openTestDb, getWorkspace, setWorkspace, getConnections, insertConnection, deleteConnection, getTableCache |
| **TableCacheService** | Cache table metadata, search tables | syncTables, searchTables, invalidateCache |
| **GitService** | Git command execution | status, diff, commit, stage, branch |
| **FileService** | File operations with validation | read, write, tree, delete, mkdir |
| **TerminalService** | PTY lifecycle, shell spawning | spawn, write, kill |
| **ProjectService** | Project CRUD, scanning | add, remove, get, list, scan |
| **ClaudeUsageService** | Token tracking, cost calculation | trackUsage, getUsage |
| **PushNotificationService** | Web push subscriptions | subscribe, unsubscribe, notify |
| **SessionLogService** | Audit logs with redaction | logSession, getLog |
| **ProviderRegistry** | AI provider routing | getDefault, send (delegates) |
| **CloudflaredService** | Download cloudflared binary | ensureCloudflared, getCloudflaredPath |
| **TunnelService** | Cloudflare Quick Tunnel lifecycle | startTunnel, stopTunnel, getTunnelUrl |
| **DatabaseAdapterRegistry** | Register/retrieve DB adapters (extensible) | registerAdapter, getAdapter |
| **SQLiteAdapter** | SQLite connection, query execution, readonly checks | testConnection, getTables, getTableSchema, getTableData, executeQuery, updateCell |
| **PostgresAdapter** | PostgreSQL connection, query execution, readonly checks | testConnection, getTables, getTableSchema, getTableData, executeQuery, updateCell |
| **AccountService** | Account CRUD, token encryption/decryption | getAccounts, createAccount, updateAccount, deleteAccount |
| **AccountSelectorService** | Select active account based on config + pre-flight retry loop | next(excludeIds?), peek(), onPreflightFail(), onRateLimit(), onAuthError(), onSuccess() |
| **UpgradeService** | Version checking, installation, self-replace signaling | checkForUpdate, applyUpgrade, getInstallMethod, compareSemver |
| **SlashDiscoveryService** | Modular command discovery (skills, builtin commands) | discoverSkillRoots, loadSkills, searchSkills, resolveOverrides, fuzzySearch |
| **PPMBotService** | Coordinator orchestrator (team leader, delegation mgmt) | start, stop, handleUpdate, checkPendingTasks |
| **PPMBotSessionManager** | Coordinator session per chat, project resolver | getCoordinatorSession, rotateCoordinatorSession, resolveProject |
| **PPMBotTelegramService** | Telegram long-polling, message ops | getUpdates, sendMessage, editMessage, setTyping, handleCommands |
| **PPMBotMemoryService** | SQLite project memory persistence | saveMemory, recallMemories, searchByProject |
| **executeDelegation()** | Task execution in isolated session, result capture | (async function, manages ChatService + result storage) |
| **PPMBotFormatterService** | Markdown → Telegram HTML + chunking | formatMarkdown, chunkMessage |
| **PPMBotStreamerService** | ChatEvent → progressive Telegram edits | streamMessageEdits |
| **JiraConfigService** | Jira config CRUD, token encryption | getConfigByProjectId, upsertConfig, deleteConfig, getDecryptedCredentials |
| **JiraWatcherDbService** | Jira watchers + results queries | getAllEnabledWatchers, insertResult, updateResultStatus, getWatcherById |
| **JiraApiClient** | Jira Cloud REST API v3 integration | searchIssues, getIssue, updateIssue, testConnection, getProjects, getFieldOptions |
| **JiraWatcherService** | Poll orchestrator, timer management | startAll, startWatcher, pollWatcher, syncResultStatuses |
| **ClawBotService** | LEGACY Telegram bot (deprecated v0.9.11) | (direct-chat model, replaced by coordinator) |
| **ClawBotTelegramService** | LEGACY Telegram API | (deprecated v0.9.11) |
| **ClawBotSessionService** | LEGACY chatID mapping | (deprecated v0.9.11) |
| **ClawBotMemoryService** | LEGACY FTS5 memory | (deprecated v0.9.11) |
| **ClawBotFormatterService** | LEGACY formatter | (deprecated v0.9.11) |
| **ClawBotStreamerService** | LEGACY streamer | (deprecated v0.9.11) |
| **BashOutputSpy** | Monitor bash tool output in real-time via /proc/PID/fd (Linux/WSL2) or lsof (macOS) | startSpy, stopSpy, stopAllForSession |
| **GroupChatStore** | Group-chat CRUD + windowed message-bus reads (`src/services/group-chat/group-chat.store.ts`) | createGroup, listGroups, addMember, appendMessage, readMessages |
| **GroupChatService** | Live per-group runtime: detached turn loop, abort handle, WS broadcast + reconnect buffer, Option A+ archive on completion | start, stop, resume, addClient, removeClient |
| **TurnEngine** | Provider-agnostic shared-channel loop (DI deps): windowed context + rolling summary, @mention speaker selection, 4 terminations, single final | runGroupTurnLoop, selectNextSpeaker, buildTurnContext |
| **AgentRunner** | Provider-backed member turn (summary from full text, not last chunk), bounded-concurrency parallel dispatch | runAgentTurn, dispatchParallel, makeEngineRunAgent |
| **TranscriptArchive** | Option A+ archive-and-delete of member JSONLs to `~/.ppm/teams/<group>/transcripts/` (copy-verified before delete) | archiveAndDelete, readArchivedTranscript |

### Data Access Layer (SQLite + Filesystem + Git)
**Components:** SQLite via bun:sqlite, direct filesystem access, simple-git wrapper

**Responsibilities:**
- Persist config, projects, session maps, usage, logs in SQLite
- Read/write project files with path validation
- Execute git commands via simple-git
- Cache directory listings
- Enforce security (no parent directory access)

**Key Patterns:**
- SQLite: WAL mode, foreign keys, lazy init, schema v28 (20+ tables: config, connections, accounts, usage_history, session_logs, push_subscriptions, session_map, table_metadata, workspace_state, extension_storage, mcp_servers, clawbot_sessions, clawbot_memories, clawbot_paired_chats, jira_config, jira_watchers, jira_watch_results, bot_tasks, proxy_requests, session_metadata)
- Path validation: `projectPath/relativePath` only, reject `..`
- Caching: Directory trees cached with TTL
- Error handling: Descriptive messages (file not found, permission denied)
- Migration: schema auto-upgrades on version bump (`CURRENT_SCHEMA_VERSION` in `db.service.ts`). The historical YAML config path is gone — `js-yaml` survives only to parse skill frontmatter in `slash-discovery/skill-loader.ts`

---

### State Management (Frontend)
**Component:** Zustand stores in browser

**Stores:**
- **projectStore** — Active project, project list, localStorage persistence
- **tabStore** — Tab facade, delegates to panelStore
- **panelStore** — Grid layout (rows/columns), panel creation/movement, keep-alive snapshots
- **fileStore** — File cache
- **settingsStore** — Theme, sidebar state, git view mode, device name

**Pattern:** Selectors for subscriptions (only re-render affected components)

```typescript
const messages = chatStore((s) => s.messages); // Subscribe to messages only
```

#### Workspace Sync (v0.8.77+)

**Deterministic Tab IDs & URL Routing:**
- Tab IDs derived from type + metadata: `deriveTabId(type, metadata) → {type}:{identifier}`
- Examples: `editor:src/index.ts`, `chat:claude/abc123`, `terminal:1`, `git-graph`
- URLs rebuilt from active tab: `/project/{name}/{type}/{identifier}`
- Deep linking: URL → `parseUrlState()` → auto-create tabs if missing

**Workspace Persistence:**
1. **Client**: PanelStore layout (grid, panels, tabs) cached in localStorage per project
2. **Server**: Workspace JSON persisted in `workspace_state` SQLite table
3. **Sync Flow:**
   - User loads project → fetch workspace from server (GET `/api/project/:name/workspace`)
   - Latest-wins: server `updated_at` vs client localStorage timestamp
   - Panel layout changes debounced (1.5s) → POST to server
   - On reconnect: server layout restored, client edits queued
4. **Cross-Device:** Any device can load workspace, browser restores exact grid + active tabs

---

## Communication Protocols

### REST API (Request/Response)
**Protocol:** HTTP/1.1 with JSON

**Pattern:**
1. Client sends request with auth token header
2. Server validates token (middleware)
3. Service processes request
4. Response formatted as `ApiResponse<T>` envelope
5. HTTP status set (200, 400, 404, 500)

**Example:**
```
POST /api/project/my-project/chat/sessions/abc/messages HTTP/1.1
Authorization: Bearer <token>
Content-Type: application/json

{ "content": "What does this code do?" }

HTTP/1.1 200 OK
{
  "ok": true,
  "data": {
    "messageId": "msg-123",
    "sessionId": "abc"
  }
}
```

---

### WebSocket (Streaming)
**Protocol:** WebSocket over HTTP/1.1

**Chat Streaming Flow:**
1. Client connects: `WS /ws/project/:name/chat/:sessionId`
2. Client sends: `{ type: "message", content: "..." }`
3. Server streams messages:
   - `{ type: "text", content: "..." }` (incremental)
   - `{ type: "tool_use", tool: "file_read", input: {...} }`
   - `{ type: "approval_request", requestId, tool, input }`
   - `{ type: "done", sessionId }`
4. Client approves tool: `{ type: "approval_response", requestId, approved: true }`

**Terminal I/O Flow:**
1. Client connects: `WS /ws/project/:name/terminal/:id`
2. Client sends: `{ type: "input", data: "ls\n" }`
3. Server sends: `{ type: "output", data: "file1 file2\n" }`
4. Client sends: `{ type: "resize", cols: 80, rows: 24 }`

---

## Authentication Flow

```
User opens http://localhost:3210
    ↓
App checks localStorage for auth token
    ↓
If no token:
    → LoginScreen shown (prompt for token)
    → GET /api/auth/check to validate token
    ↓
If valid token:
    → Store in localStorage
    → Load projects: GET /api/projects
    → Main UI rendered
    ↓
For each API request:
    → Include "Authorization: Bearer <token>" header
    → Middleware validates token
    → If invalid → 401 Unauthorized
```

**Token Management:**
- Generated on `ppm init` → stored in `~/.ppm/ppm.db` (`auth.token`)
- Required on the WebSocket handshake too, as `?token=` (browsers cannot set handshake headers)
- Stored in browser localStorage for session persistence
- No expiry (single-user, local environment)

---

## Deployment Architecture

### Single-Machine Deployment (Current)
```
macOS / Linux / Windows Host
  ├── ppm (compiled binary)
  │   └── Embeds: server code, frontend assets
  └── ~/.ppm/ (ppm.db config, sessions, logs, cloudflared, status.json)
```

### Daemon Mode (Default)
```
$ ppm start
  → Background process (background by default)
  → Supervisor spawns server + tunnel, monitors health
  → Status saved to ~/.ppm/status.json (with PID, port, host, shareUrl, supervisorPid, availableVersion)
  → Fallback compat: ppm.pid read/written for backward compatibility
  → Supervisor checks npm registry every 15min for updates, writes availableVersion to status.json

(There is no foreground mode — the supervised daemon is the only one.
 For logs, use `ppm logs -f`; for machine-readable state, `ppm status --json`.)

$ ppm start
  → Daemon mode + Cloudflare Quick Tunnel (always enabled)
  → Downloads cloudflared to ~/.ppm/bin/ (if missing, shows progress)
  → Spawns tunnel process, extracts public URL from stderr
  → URL saved to status.json for parent process
  → Auth warning if auth.enabled is false
  → Note: --share flag is deprecated but accepted for backward compat (does nothing)

$ ppm upgrade
  → CLI command to check and install updates
  → Fetches latest version from npm registry
  → Installs via bun or npm based on install method
  → Signals supervisor to self-replace (spawn new → wait healthy → exit old)
  → Works in headless environments (no OS autostart dependency)

$ ppm stop
  → SOFT STOP: kills server only, supervisor stays alive with Cloud WS + tunnel
  → Supervisor transitions to "stopped" state
  → Minimal HTML page served on port (503 status on /api/health)
  → Tunnel and Cloud connectivity remain active
  → `ppm start` resumes without restarting supervisor process

$ ppm stop --kill OR ppm down
  → FULL SHUTDOWN: kills everything (supervisor + server + tunnel)
  → Supervisor transitions to "upgrading" then terminates
  → Cleans up status.json and ppm.pid
  → Graceful cleanup (close WS, cleanup PTY, stop tunnel)
```

### Supervisor Architecture (v0.9.11+)

The supervisor is a long-lived parent process that manages server + tunnel children with resilience and state management.

**Architecture:**
```
Supervisor Process (parent)
  ├── Edge Forwarder (detached; owns the PUBLIC port)
  │   ├── Raw TCP pipe → server's loopback port (no HTTP parsing, so WS/SSE pass through)
  │   ├── Target read per connection from ~/.ppm/.server-port
  │   ├── SPAWNS NO CHILDREN — that is why its socket can never be inherited
  │   │   and its port can never zombie; cloudflared stays pinned to it forever
  │   ├── Liveness probe every 10s → respawn
  │   └── Adopted by PID across a self-replace upgrade (adopt BEFORE any bind probe)
  │
  ├── Server Child (Hono HTTP server, 127.0.0.1:0 — OS-assigned)
  │   ├── Publishes its bound port to ~/.ppm/.server-port (single writer)
  │   ├── Health checks every 30s against that port, never the public one
  │   ├── Auto-restart on crash (exponential backoff, max 10 restarts)
  │   └── If in "stopped" state, serves minimal 503 page instead of restarting
  │
  ├── Tunnel Child (quick by default; named when configured — see "Tunnel Modes" below)
  │   ├── Origin is the EDGE port, so a server port move cannot rotate the URL
  │   ├── Quick: URL probe every 2min. Named: health probe every 30s, restart-once-then-warn
  │   ├── Auto-reconnect on failure
  │   └── URL persisted to status.json
  │
  ├── State Machine: "running" | "paused" | "stopped" | "upgrading"
  │   ├── running — Server spawned, tunnel optional, serving requests
  │   ├── paused — Supervisor paused (resume via signal)
  │   ├── stopped — Server stopped (soft stop), tunnel alive, Cloud WS active
  │   └── upgrading — Self-replace in progress
  │
  ├── Upgrade Check (every 15min)
  │   └── npm registry poll → availableVersion written to status.json
  │
  ├── Stopped Page Server
  │   ├── Lightweight HTTP handler on a loopback port, published to .server-port
  │   │   so the edge routes the public URL to it (it stands in for the server)
  │   ├── Returns 503 on /api/health
  │   └── Tunnels Cloud WS calls through to PPM Cloud
  │
  └── Error Resilience
      ├── uncaughtException → log + exit gracefully
      ├── unhandledRejection → log + continue
      └── Signal handlers: SIGTERM (full shutdown), SIGUSR1 (self-replace), SIGUSR2 (restart skip backoff)
```

**Soft Stop vs Full Shutdown:**
| Command | Server | Supervisor | Tunnel | Use Case |
|---------|--------|------------|--------|----------|
| `ppm stop` | Killed | Stays alive | Stays alive | Restart later with `ppm start` |
| `ppm stop --kill` | Killed | Killed | Killed | Full cleanup, exit |
| `ppm down` | Killed | Killed | Killed | Full cleanup, exit |

**State Persistence:**
- Status file: `~/.ppm/status.json` — PID, port, host, shareUrl, supervisorPid, availableVersion, state,
  `tunnelMode` ("quick"|"named", what's actually running), `tunnelWarning` (set when named degrades to
  quick or the named hostname stops resolving; persists until the condition clears), `capabilities`
  (`["retunnel"]` once the running supervisor understands that command — its absence is how the UI
  detects a pre-upgrade supervisor and falls back to "run `ppm restart`")
- Lock file: `~/.ppm/.start-lock` — Prevent concurrent starts
- Command file: `~/.ppm/.supervisor-cmd` — IPC for soft_stop, resume, self_replace, restart, upgrade,
  and `retunnel` (reload the tunnel config without a full restart, used after named-tunnel setup);
  `retunnel` is deliberately the lowest-priority action — any lifecycle command overwrites a pending
  one rather than getting silently dropped

**Stopped Page Implementation:**
- Minimal HTTP server on same port as main server
- Serves `503 Service Unavailable` on /api/health
- Proxies Cloud WS calls to PPM Cloud (if tunnel configured)
- Allows `ppm start` to resume without supervisor restart

**Files (Modular Design):**
- `src/services/supervisor.ts` — Main orchestrator (spawn, health checks, upgrade checks)
- `src/services/supervisor-state.ts` — State machine, IPC command handling, signal routing
- `src/services/supervisor-stopped-page.ts` — Minimal 503 page + Cloud WS proxy

---

### Tunnel Modes: Quick vs Named

Two ways to get a public URL, chosen by the `tunnel` config row in SQLite:

- **Quick** (default) — a Cloudflare Quick Tunnel with a random `*.trycloudflare.com` hostname that
  rotates on every restart. No setup, no Cloudflare account.
- **Named** — a stable `https://<prefix>.<zone>` hostname on a Cloudflare-managed domain the user
  owns, set up once through a first-run popup (Cloudflare login → pick a hostname) and reused across
  restarts, hibernate, and crashes.

**Process ownership** — the split matters for reasoning about failures:
- The **supervisor** (`src/services/supervisor.ts`) owns the one long-running `cloudflared tunnel run`
  (or `tunnel --url` for quick) child, in both modes — spawn, health-probe, kill, and respawn all
  happen there, the same seam that already manages the server child.
- The **server** (`src/server/routes/named-tunnel.ts` → `src/services/named-tunnel/`) only
  *orchestrates setup*: one-shot `cloudflared tunnel create/route/token` calls to provision the
  tunnel and DNS record, then asks the supervisor to pick up the new config via `retunnel`
  (`requestTunnelReload()` writes `.supervisor-cmd`). The server process never runs the long-lived
  connector itself.
- A named tunnel that fails to spawn falls back to quick immediately (never leaves the process
  without a public URL); the fallback and the reason are surfaced as `tunnelWarning` in `status.json`.
  A named tunnel whose hostname stops resolving (e.g. the CNAME was deleted) gets exactly one
  restart-and-hope; if the next health probe is still unhealthy, the connector is left running and a
  `tunnelWarning` is raised instead of restarting forever (`src/services/named-tunnel/named-tunnel-probe-state.ts`).

**Where the secrets live** — three different pieces of Cloudflare-issued material, three different
homes, none of them ever in a process's argv:
- `cert.pem`'s `apiToken` (the Cloudflare API credential `cloudflared tunnel login` writes) is parsed
  in-memory to call the Cloudflare API during setup and is **never persisted anywhere PPM controls** —
  it stays only in `~/.cloudflared/cert.pem`, which is on `fs-credential-path-guard.ts`'s refuse-list
  (see "PPM Directory" in the root `CLAUDE.md`) so no generic file route can read, copy, or move it out.
- The tunnel's run token (from `cloudflared tunnel token`) is stored in SQLite as
  `tunnel.namedTunnelToken` and masked wherever config is echoed back (`ppm config get`, the extension
  RPC `workspace:config:get`, `ppm status`) — see `src/services/config-secret-keys.ts`.
- The same run token is also written to `~/.ppm/named-tunnel.token` (mode 0600) and handed to
  `cloudflared` via `--token-file`, never `--token <value>`, so it never appears in a process listing
  or a crash dump that captures cmdlines.

Zone/account IDs read from the cert are pinned into the config row at setup time; a later login to a
different Cloudflare account is detected (`certState: "mismatch"`) and routed to a re-login rather
than silently reused.

### Future: Multi-Machine (not planned)
PPM is single-machine by design; multi-machine would require:
- Central state server (Redis/Postgres)
- Session sharing across servers
- Shared filesystem or file sync protocol
- Load balancer

---

## Error Handling Strategy

| Layer | Error Type | Handling |
|-------|-----------|----------|
| **Presentation** | Network error | Retry, show toast |
| **API** | Invalid input | 400 Bad Request, error message |
| **Service** | File not found | Throw Error, API returns 404 |
| **Service** | Git failed | Throw Error with git output |
| **Provider** | Token invalid | Return error event |
| **Filesystem** | Permission denied | Throw Error with context |

**Pattern:** Bottom-up exception bubbling with context addition at each layer.

---

## Security Architecture

| Component | Security Measure | Implementation |
|-----------|-----------------|-----------------|
| **Auth** | Token validation | Middleware checks header token vs config |
| **Path Traversal** | Path validation | FileService rejects paths with `..` |
| **WebSocket** | Token in URL query | WS connects with `?token=...` or via session |
| **CLI** | Config file permissions | 0600 (user read/write only) |
| **API** | No sensitive data in logs | Token masked in debug output |
| **CORS** | Same-origin only | WS on same host as HTTP API |

---

