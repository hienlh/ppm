# PPM System Architecture

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
│  │              Hono HTTP Framework (Port 8080)                   │   │
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
   │  • Legacy config file (~/.ppm/config.yaml)      │
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
POST   /api/projects            → Create project
GET    /api/projects            → List projects
DELETE /api/projects/:name      → Delete project
PATCH  /api/projects/reorder    → Reorder projects by name order
PATCH  /api/projects/:name/color → Set project color (hex string)
GET    /api/project/:name/chat/sessions           → List sessions
POST   /api/project/:name/chat/sessions           → Create session
GET    /api/project/:name/chat/sessions/:id/messages → Get history
DELETE /api/project/:name/chat/sessions/:id       → Delete session
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
WS     /ws/project/:name/chat/:sessionId          → Chat streaming
WS     /ws/project/:name/terminal/:id             → Terminal I/O
```

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
| **ConfigService** | Config loading (YAML→SQLite migration) | load, save, getToken |
| **DbService** | SQLite persistence (8 tables, WAL, connections CRUD) | getDb, openTestDb, getConnections, insertConnection, updateConnection, deleteConnection, getTableCache |
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

**Key Files:** `src/services/*.service.ts`

---

### Provider Layer (AI Adapters)
**Component:** Provider interface + implementations

**Responsibilities:**
- Abstract AI model differences behind common interface
- Stream responses as async generators
- Handle tool use and approval flows
- Track token usage

**Interface (src/providers/provider.interface.ts):**
```typescript
interface AIProvider {
  createSession(): Promise<Session>;
  sendMessage(sessionId: string, message: string, context?: FileContext[]): AsyncIterable<ChatEvent>;
  onToolApproval(sessionId: string, requestId: string, approved: boolean, data?: unknown): Promise<void>;
}
```

**Implementations:**
- **claude-agent-sdk** (Primary) — @anthropic-ai/claude-agent-sdk, streaming, tool use. Reads model/effort/maxTurns/budget/thinking from config. Settings refreshed per query. Windows CLI fallback for Bun subprocess pipe issues. .env poisoning mitigation.
- **mock-provider** (Testing) — Returns canned responses
- **Note:** CLI provider removed (v2); agent SDK is sole AI provider with Windows CLI fallback

---

### Data Access Layer (SQLite + Filesystem + Git)
**Components:** SQLite via bun:sqlite, direct filesystem access, simple-git wrapper

**Responsibilities:**
- Persist config, projects, session maps, usage, logs in SQLite
- Read/write project files with path validation
- Execute git commands via simple-git
- Cache directory listings
- Enforce security (no parent directory access)

**Key Patterns:**
- SQLite: WAL mode, foreign keys, lazy init, schema v1 with 6 tables
- Path validation: `projectPath/relativePath` only, reject `..`
- Caching: Directory trees cached with TTL
- Error handling: Descriptive messages (file not found, permission denied)
- Migration: Automatic YAML→SQLite migration on first run with new db.service

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

## Project Workspace Management

### Keep-Alive Pattern (v2.0+)
When switching projects, workspaces are preserved instead of destroyed:
1. **Workspace Mount State**: Each project's UI (tabs, terminal xterm DOM, file selections) remains mounted in the DOM
2. **Visibility Toggle**: CSS `display: none/block` hides/shows workspaces instead of React unmounting
3. **Terminal DOM Persistence**: xterm.js terminal instances retain their DOM structure across switches (prevents re-render flicker)
4. **Cache Efficiency**: Zustand stores persist open tabs, selections, and scroll positions per project

**Benefits:**
- Instant project switching (no DOM reconstruction)
- Terminal history preserved across switches
- Smooth UX without flashing/re-rendering
- Reduced network requests (cached UI state)

### Project Color & Ordering (v2.0+)
**Storage**: Colors stored as optional `color` field in `Project` interface (hex string or undefined)

**Endpoints:**
- `PATCH /api/projects/:name/color` — Update project color
- `PATCH /api/projects/reorder` — Reorder projects array in config

**UI Components:**
- `ProjectBar` (52px sidebar) — Shows project avatars with color backgrounds, context menu for reorder/rename/delete/color-picker
- `ProjectBottomSheet` (mobile) — Bottom sheet switcher with scrollable project list
- `ProjectAvatar` utility — Generates smart initials with collision resolution (prefer 1-char, fallback to 2-char or index)
- `PROJECT_PALETTE` — 12-color palette for default colors when not customized

---

## Code Editor Migration (v2.0+)

**Migration**: CodeMirror 6 → Monaco Editor (@monaco-editor/react)

**Reasons:**
- Better syntax highlighting for complex languages
- Superior IntelliSense and code completion
- Performance improvements on large files
- More polished diff viewer experience

**Components Updated:**
- `src/web/components/editor/code-editor.tsx` — Monaco Editor with language detection
- `src/web/components/editor/diff-viewer.tsx` — Monaco diff viewer for git diffs

**Features:**
- Alt+Z toggle for word wrap
- Automatic language detection from file extension
- Theme sync with app dark/light mode
- Responsive layout with proper scrolling

---

## Authentication Flow

```
User opens http://localhost:8080
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
- Generated on `ppm init` → stored in `ppm.yaml`
- Sent from CLI via `-c <config>` flag
- Stored in browser localStorage for session persistence
- No expiry (single-user, local environment)

---

## AI Provider Configuration

PPM exposes AI settings as global configuration (not per-session) via REST API and Settings UI. Configuration is stored in `ppm.yaml` and read fresh per query.

### Configuration Shape
```yaml
ai:
  default_provider: claude
  providers:
    claude:
      type: agent-sdk
      api_key_env: ANTHROPIC_API_KEY
      model: claude-sonnet-4-6
      effort: high
      max_turns: 100
      max_budget_usd: 2.00
      thinking_budget_tokens: 10000
```

**Fields:**
- `default_provider`: Active provider name (e.g., `claude`)
- `type`: Provider type (`agent-sdk` or `mock`)
- `api_key_env`: Environment variable containing API key
- `model`: Model ID (e.g., `claude-sonnet-4-6`, `claude-opus-4-6`)
- `effort`: Processing level (`low`, `medium`, `high`, `max`)
- `max_turns`: Maximum interaction turns (1-500, default 100)
- `max_budget_usd`: Spending limit in USD (optional)
- `thinking_budget_tokens`: Extended thinking budget in tokens (optional, 0=disabled)

### API Endpoints

**GET /api/settings/ai** — Fetch current AI config
```json
{
  "ok": true,
  "data": {
    "default_provider": "claude",
    "providers": { "claude": {...} }
  }
}
```

**PUT /api/settings/ai** — Update AI config (shallow merge per provider)
```json
{
  "providers": {
    "claude": {
      "model": "claude-opus-4-6",
      "max_turns": 50
    }
  }
}
```
Returns full updated config. Validates ranges/enums before writing.

### How Provider Uses Settings

1. **SDK Provider (`sendMessage`)**
   - Calls `getProviderConfig()` to read fresh config from `configService`
   - Maps snake_case config to camelCase SDK options
   - Passes `model`, `effort`, `maxTurns`, `maxBudgetUsd`, `thinkingBudgetTokens` to `query()`
   - Falls back to defaults if fields not set

2. **Mock Provider**
   - Ignores AI settings (always returns canned responses for testing)

3. **Changes Take Effect**
   - Immediately on next query (config read fresh each time)
   - No active queries affected (config mid-flight not re-evaluated)

---

## Chat Streaming Flow

```
User types: "Debug this function"
    ↓
MessageInput.tsx calls useChat.sendMessage()
    ↓
useChat opens WebSocket: WS /ws/project/:name/chat/:sessionId
    ↓
Sends: { type: "message", content: "Debug..." }
    ↓
Server routes to ChatService.streamMessage()
    ↓
ChatService calls provider.sendMessage() (async generator)
    ↓
Provider (Claude SDK) streams response:
    1. Yields: { type: "text", content: "Here's what..." }
    2. Yields: { type: "text", content: " happens..." }
    3. Yields: { type: "tool_use", tool: "read_file", input: {...} }
    ↓
ChatService wraps as WebSocket messages:
    { type: "text", content: "Here's what..." }
    { type: "text", content: " happens..." }
    { type: "tool_use", tool: "read_file", input: {...} }
    { type: "approval_request", requestId, tool, input }
    ↓
Client receives, displays message incrementally
    ↓
User sees tool approval prompt, clicks "Approve"
    ↓
Client sends: { type: "approval_response", requestId, approved: true }
    ↓
ChatService.onToolApproval() executes tool (file_read, git commands, etc.)
    ↓
Provider continues streaming with tool result
    ↓
Final response streamed, then: { type: "done", sessionId }
    ↓
useChat closes WebSocket, saves message to store
```

---

## Terminal Flow

```
User clicks Terminal tab
    ↓
TerminalTab.tsx mounts
    ↓
useTerminal hook opens WebSocket: WS /ws/project/:name/terminal/:id
    ↓
TerminalService.spawn() creates PTY (Bun.spawn)
    ↓
xterm.js renders terminal emulator
    ↓
User types: "npm test"
    ↓
xterm.js captures key event
    ↓
Sends via WebSocket: { type: "input", data: "npm test\n" }
    ↓
TerminalService.write(pty, "npm test\n")
    ↓
npm process spawned inside PTY
    ↓
Output captured: "PASS: all tests\n"
    ↓
TerminalService sends: { type: "output", data: "PASS: all tests\n" }
    ↓
xterm.js renders output
    ↓
User resizes window → xterm.js resizes terminal
    ↓
Sends: { type: "resize", cols: 120, rows: 40 }
    ↓
TerminalService calls pty.resize()
    ↓
Shell (bash/zsh) receives SIGWINCH signal
    ↓
Terminal state updated
```

---

## Git Integration Flow

```
User right-clicks file in FileTree
    ↓
Context menu shows "Stage" option
    ↓
User clicks "Stage"
    ↓
FileActions.tsx calls POST /api/project/:name/git/stage
    ↓
Sends: { path: "src/index.ts" }
    ↓
GitService.stage(projectPath, "src/index.ts")
    ↓
Executes: git add src/index.ts (via simple-git)
    ↓
Returns: { ok: true }
    ↓
GitStatusPanel.tsx refreshes: GET /api/project/:name/git/status
    ↓
GitService.status() returns:
    {
      current: "main",
      staged: ["src/index.ts"],
      unstaged: ["README.md"],
      untracked: ["temp.log"]
    }
    ↓
UI updates: "src/index.ts" moves from "Unstaged" to "Staged"
```

---

## Database Management (v2.0+)

### Architecture Overview

PPM now supports managing external databases (SQLite & PostgreSQL) through a unified adapter pattern:

```
┌─────────────────────────────────────────────────────────────────┐
│                    Web UI (React)                               │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │ Database Sidebar                                         │   │
│  │ • Connection List (with color badges)                    │   │
│  │ • Create/Edit Connection Form                            │   │
│  │ • Color Picker (WCAG contrast-aware)                     │   │
│  │ • Query Execution UI                                     │   │
│  └──────────────────────────────────────────────────────────┘   │
└─────────────────┬───────────────────────────────────────────────┘
                  │ HTTP REST / WebSocket
┌─────────────────┴───────────────────────────────────────────────┐
│                    PPM Server (Hono)                            │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │ /api/db Routes                                           │   │
│  │ • GET  /connections        → List all connections        │   │
│  │ • POST /connections        → Create connection           │   │
│  │ • GET  /connections/:id    → Get connection (sanitized)  │   │
│  │ • PUT  /connections/:id    → Update (readonly toggle)    │   │
│  │ • DELETE /connections/:id  → Remove connection           │   │
│  │ • GET  /connections/:id/tables      → List + sync tables │   │
│  │ • GET  /connections/:id/tables/:tbl → Schema + data      │   │
│  │ • POST /connections/:id/query       → Execute query      │   │
│  │ • PATCH /connections/:id/cell       → Update cell        │   │
│  └──────────────────────────────────────────────────────────┘   │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │ Service Layer                                            │   │
│  │ • DbService (connection CRUD, caching)                   │   │
│  │ • TableCacheService (metadata cache, search)             │   │
│  │ • DatabaseAdapterRegistry (extensible)                   │   │
│  └──────────────────────────────────────────────────────────┘   │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │ Adapters (Pluggable Pattern)                             │   │
│  │ • SQLiteAdapter → Uses `bun:sqlite` for local files      │   │
│  │ • PostgresAdapter → Uses postgres driver for servers     │   │
│  │ • isReadOnlyQuery() → Safety check (CTE-safe regex)      │   │
│  │ • readonly=1 by default (safe-by-default)               │   │
│  └──────────────────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────────────────┘
        ↓↑
   ┌────────────────────────────────────────────┐
   │  External Databases                         │
   │  • SQLite files (path: /path/to/db.db)      │
   │  • PostgreSQL servers (connStr: postgres://)│
   └────────────────────────────────────────────┘
```

### DatabaseAdapter Pattern (Extensible)

**Interface** (`src/types/database.ts`):
```typescript
interface DatabaseAdapter {
  testConnection(config: DbConnectionConfig): Promise<{ ok: boolean; error?: string }>;
  getTables(config: DbConnectionConfig): Promise<DbTableInfo[]>;
  getTableSchema(config: DbConnectionConfig, table: string, schema?: string): Promise<DbColumnInfo[]>;
  getTableData(config: DbConnectionConfig, table: string, opts: {...}): Promise<DbPagedData>;
  executeQuery(config: DbConnectionConfig, sql: string): Promise<DbQueryResult>;
  updateCell(config: DbConnectionConfig, table: string, opts: {...}): Promise<void>;
}
```

**Implementations:**
1. **SQLiteAdapter** — Local file-based SQLite via `bun:sqlite`
   - testConnection: Opens file, runs pragma check
   - Supports: SELECT, INSERT, UPDATE, DELETE (if writable), CREATE TABLE

2. **PostgresAdapter** — Remote PostgreSQL servers via postgres driver
   - testConnection: Attempts connection with credentials
   - Supports: Full SQL except DDL on readonly connections

**Registry Pattern** (`src/services/database/adapter-registry.ts`):
```typescript
registerAdapter("sqlite", new SQLiteAdapter());
registerAdapter("postgres", new PostgresAdapter());
// Can be extended: registerAdapter("mysql", new MysqlAdapter());
```

### Security Design

**Readonly by Default:**
- All connections created with `readonly = true` in database
- Default: read-only query execution (safe-by-default)
- Web UI toggle: Switch to writable (admin decision only)
- CLI: Cannot disable readonly via command-line (browser only)

**Readonly Query Detection:**
```typescript
// isReadOnlyQuery() in src/services/database/readonly-check.ts
// Checks for: SELECT, PRAGMA, EXPLAIN, WITH (CTE)
// Rejects: INSERT, UPDATE, DELETE, CREATE, DROP, ALTER, etc.
// CTE-safe: Handles "WITH AS SELECT" (wraps CTE result check)
```

**Credential Handling:**
- Connection credentials stored in SQLite `connections` table as `connection_config` JSON
- **NEVER** returned in API responses (stripped by `sanitizeConn()` in routes)
- Only used internally by adapters when executing queries
- Frontend never sees passwords/connection strings

**API Security:**
- All `/api/db` requests require valid auth token (middleware checked)
- Connection IDs are numeric (no enumeration risk)
- Connection color is user-specific (cosmetic only, not sensitive)

### Data Flow: Query Execution

```
User opens Database tab
    ↓
DatabaseSidebar fetches: GET /api/db/connections
    ↓
ConnectionList displays (sanitized, no credentials)
    ↓
User clicks connection → GET /api/db/connections/:id/tables
    ↓
DbService.getConnections() reads from SQLite
    ↓
TableCacheService.syncTables() calls adapter.getTables()
    ↓
SQLiteAdapter/PostgresAdapter queries database
    ↓
Results cached in table_metadata table
    ↓
UI displays table list + schema
    ↓
User selects table → GET /api/db/connections/:id/tables/:table
    ↓
Adapter.getTableData() executes paginated query
    ↓
Results returned: { columns, rows, total, page, limit }
    ↓
UI renders table grid with pagination
    ↓
User executes custom query → POST /api/db/connections/:id/query
    ↓
isReadOnlyQuery() checks SQL (rejects writes if readonly=true)
    ↓
Adapter.executeQuery() runs SQL
    ↓
Results returned: { columns, rows, rowsAffected, changeType }
    ↓
UI displays results (read-only highlight if mutation was blocked)
```

### Connection Storage

**SQLite Schema** (in `~/.ppm/ppm.db`):
```sql
CREATE TABLE connections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL, -- 'sqlite' | 'postgres'
  name TEXT NOT NULL,
  connection_config TEXT NOT NULL, -- JSON: { path, connectionString, ... }
  readonly INTEGER DEFAULT 1, -- 1 = readonly, 0 = writable (UI-only toggle)
  group_name TEXT,
  color TEXT, -- Optional hex color (#3b82f6)
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE table_metadata (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  connection_id INTEGER NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
  table_name TEXT NOT NULL,
  schema_name TEXT DEFAULT 'public',
  row_count INTEGER,
  last_synced TEXT,
  UNIQUE(connection_id, table_name, schema_name)
);
```

### CLI Support (ppm db)

**Commands** (`src/cli/commands/db-cmd.ts`):
```bash
ppm db connections           # List all connections
ppm db connect               # Add new connection (interactive)
ppm db remove <name>         # Delete connection
ppm db query <name> <sql>    # Execute query (respects readonly)
ppm db tables <name>         # List tables
ppm db schema <name> <table> # Show table schema
ppm db data <name> <table>   # Show table data (paginated)
```

**CLI Safety:**
- Always respects readonly flag (cannot override via CLI)
- Uses same adapter/validation as web UI
- Table formatting for terminal output

---

## Deployment Architecture

### Single-Machine Deployment (Current)
```
Linux/macOS Host
  ├── ppm (compiled binary)
  │   └── Embeds: server code, frontend assets
  ├── ppm.yaml (config, auto-generated)
  └── ~/.ppm/ (optional: session cache, logs)
```

### Daemon Mode (Default)
```
$ ppm start
  → Background process (background by default)
  → Status saved to ~/.ppm/status.json (with PID, port, host, shareUrl)
  → Fallback compat: ppm.pid read/written for backward compatibility

$ ppm start --foreground
  → Runs in foreground (debugging, CI/CD)
  → WebSocket and all features fully functional
  → Tunnel (--share) works in foreground mode

$ ppm start --share
  → Daemon mode + Cloudflare Quick Tunnel
  → Downloads cloudflared to ~/.ppm/bin/ (if missing, shows progress)
  → Spawns tunnel process, extracts public URL from stderr
  → URL saved to status.json for parent process
  → Auth warning if auth.enabled is false

$ ppm stop
  → Reads ~/.ppm/status.json first (new format)
  → Falls back to ppm.pid (compat)
  → Sends SIGTERM to daemon
  → Cleans up status.json and ppm.pid
  → Graceful shutdown (close WS, cleanup PTY, stop tunnel)
```

### Future: Multi-Machine (Not in v2)
Would require:
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

