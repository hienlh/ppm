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
GET    /api/upgrade/status                        → Get current + available versions, install method
POST   /api/upgrade/apply                         → Install new version, trigger supervisor self-replace
GET    /api/project/:name/workspace               → Get saved workspace layout + metadata
PUT    /api/project/:name/workspace               → Save workspace layout (layout JSON)
WS     /ws/project/:name/chat/:sessionId          → Chat streaming
WS     /ws/project/:name/terminal/:id             → Terminal I/O
```

**URL Format (Deterministic Tabs, v0.8.77+):**
```
/project/{name}                          → Project root (project switcher)
/project/{name}/editor/{filePath}        → Open editor tab (e.g., src/index.ts)
/project/{name}/chat/{provider}/{sessionId} → Open chat tab
/project/{name}/terminal/{index}         → Open terminal tab
/project/{name}/database/{connId}/{table} → Open database browser
/project/{name}/git-graph                → Git history graph (singleton)
/project/{name}/settings                 → Settings panel (singleton)
```
Tab IDs are deterministic: `{type}:{identifier}` (e.g., `editor:src/index.ts`, `chat:claude/abc123`). Deep links auto-create missing tabs.

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
| **DbService** | SQLite persistence (10 tables, WAL, connections/accounts/workspace CRUD) | getDb, openTestDb, getWorkspace, setWorkspace, getConnections, insertConnection, deleteConnection, getTableCache |
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
| **PPMBotService** | Coordinator orchestrator (team leader, delegation mgmt) | start, stop, handleUpdate, checkPendingTasks |
| **PPMBotSessionManager** | Coordinator session per chat, project resolver | getCoordinatorSession, rotateCoordinatorSession, resolveProject |
| **PPMBotTelegramService** | Telegram long-polling, message ops | getUpdates, sendMessage, editMessage, setTyping, handleCommands |
| **PPMBotMemoryService** | SQLite project memory persistence | saveMemory, recallMemories, searchByProject |
| **executeDelegation()** | Task execution in isolated session, result capture | (async function, manages ChatService + result storage) |
| **PPMBotFormatterService** | Markdown → Telegram HTML + chunking | formatMarkdown, chunkMessage |
| **PPMBotStreamerService** | ChatEvent → progressive Telegram edits | streamMessageEdits |
| **ClawBotService** | LEGACY Telegram bot (deprecated v0.9.11) | (direct-chat model, replaced by coordinator) |
| **ClawBotTelegramService** | LEGACY Telegram API | (deprecated v0.9.11) |
| **ClawBotSessionService** | LEGACY chatID mapping | (deprecated v0.9.11) |
| **ClawBotMemoryService** | LEGACY FTS5 memory | (deprecated v0.9.11) |
| **ClawBotFormatterService** | LEGACY formatter | (deprecated v0.9.11) |
| **ClawBotStreamerService** | LEGACY streamer | (deprecated v0.9.11) |

**Key Files:** `src/services/*.service.ts`, `src/services/ppmbot/*.ts`, `src/cli/commands/bot-cmd.ts`

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
- **claude-agent-sdk** (Primary) — @anthropic-ai/claude-agent-sdk, streaming, tool use. Reads model/effort/maxTurns/budget/thinking from config. Settings refreshed per query. Windows CLI fallback for Bun subprocess pipe issues. .env poisoning mitigation. **Multi-account support:** Injects account API token from AccountService instead of relying on ANTHROPIC_API_KEY env var when accounts configured.
- **mock-provider** (Testing) — Returns canned responses
- **cursor-cli** (CLI-based) — Spawns `cursor-agent` CLI binary with NDJSON streaming. Extends `CliProvider` base class.
- **codex/gemini** (Planned) — Pluggable via `CliProvider` extension (~100-150 lines each)

#### Multi-Provider Architecture (v0.8.61+)

PPM supports multiple AI providers through a generic `AIProvider` interface and extensible base classes:

**Provider Types:**
1. **SDK-based** (claude-agent-sdk) — Uses Anthropic SDK for rich features (approvals, thinking blocks)
2. **CLI-based** (cursor-cli, codex, gemini) — Spawns external binary with NDJSON streaming

**Base Classes:**
- `AIProvider` interface — Defines required methods (createSession, sendMessage) + optional capabilities (abortQuery, getMessages, listSessionsByDir, ensureProjectPath)
- `CliProvider` abstract class — Shared spawn/parse/abort logic for all CLI-spawning providers
- Provider-specific subclasses implement: `buildArgs()`, `mapEvent()`, `extractSessionId()`, `isAvailable()`

**Streaming Infrastructure:**
- `parseNdjsonLines()` utility — Async generator that buffers partial TCP packets, yields complete JSON lines
- `ChatEvent` union type — Normalized event format across all providers (text, tool_use, thinking, approval_request, system, done, error)
- Event mappers translate provider-specific JSON → ChatEvent (e.g., Cursor's `reasoning` type → `thinking` event)

**Provider Registration & Bootstrap:**
- `ProviderRegistry` maintains active provider instances
- `bootstrapProviders()` async function checks `isAvailable()` on CLI providers before registering
- Graceful fallback: if Cursor binary not found, provider skips registration (no crash, logged as info)
- Config type `AIProviderConfig.type` union: `"agent-sdk" | "cli" | "mock"`

**CLI-Provider Features:**
- **Session capture** — Extract session ID from provider's init event, re-key process tracking
- **Workspace trust auto-retry** — Detect trust prompts in stderr, retry once with `--trust` flag
- **Process lifecycle** — Track active processes per session, escalate SIGTERM → SIGKILL on abort
- **History loading** — Override `listSessions()` to read native provider history (e.g., Cursor SQLite DAG)
- **Graceful degradation** — Missing binary → provider skipped, not fatal

**New Files (v0.8.61):**
- `src/utils/ndjson-line-parser.ts` — NDJSON streaming parser
- `src/providers/cli-provider-base.ts` — Abstract base class for CLI providers
- `src/providers/cursor-cli/cursor-provider.ts` — CursorCliProvider implementation
- `src/providers/cursor-cli/cursor-event-mapper.ts` — NDJSON → ChatEvent mapping
- `src/providers/cursor-cli/cursor-history.ts` — SQLite DAG reader for Cursor history
- `src/web/components/chat/provider-selector.tsx` — UI component for provider selection

---

### PPMBot Coordinator Service Layer (Telegram-based Team Leader)
**Component:** PPMBot coordinator orchestrator + delegation executor

**Responsibilities:**
- Manage single persistent coordinator session per Telegram chat in `~/.ppm/bot/` workspace
- Route incoming Telegram messages to coordinator (ask/answer) or delegation tracking
- Decide when to answer directly vs. delegate to subagents (based on project context)
- Execute delegated tasks in isolated project sessions
- Track task status and report results back to Telegram
- Format responses as Telegram HTML with progressive message editing

**Architecture:**
```
Telegram → PPMBotTelegramService (polling) → PPMBotService (orchestrator)
                                                 ↓
                            PPMBotSessionManager (coordinator session per chat)
                            coordinatorSession.id → chatService.sendMessage()
                            Task Poller (5s interval)
                            ↓
                    executeDelegation(taskId, telegram, providerId)
                    ├─ getBotTask(taskId) → prompt
                    ├─ chatService.createSession(providerId, projectPath)
                    ├─ run async generator (abort, 900s timeout)
                    └─ updateBotTaskStatus(taskId, "completed", {result})
                    ↓
                    telegram.sendMessage(chatId, result summary)
```

**Services (src/services/ppmbot/):**
- **PPMBotService** — Lifecycle (start/stop), message queue, Telegram polling loop, task poller loop
- **PPMBotSessionManager** — Coordinator session cache per chatID, project resolver (case-insensitive, prefix match)
- **PPMBotTelegramService** — Telegram Bot API (getUpdates polling, sendMessage, editMessage, setTyping)
- **PPMBotMemoryService** — SQLite project memories, contextual recall
- **executeDelegation()** — Task execution in isolated session, result capture, timeout/abort handling
- **PPMBotFormatterService** — Markdown → Telegram HTML, 4096-char chunking
- **PPMBotStreamerService** — ChatEvent → progressive Telegram message edits (1s throttle)

**Coordinator Identity (Persistent Cross-Provider):**
- Location: `~/.ppm/bot/coordinator.md` (loaded on startup, cached in `coordinatorIdentity`)
- Role definition: Team leader, project coordinator, decision-maker
- Decision framework: Answer directly (no project context) vs. Delegate (file access needed)
- Coordination tools: Bash-safe CLI commands (`ppm bot delegate`, `ppm bot task-status`, etc.)
- Cross-provider: Identity text injected as XML context block, works with Claude SDK + CLI providers

**Delegation Flow:**
1. User asks task in Telegram
2. Coordinator decides: delegate? → yes
3. Coordinator calls bash: `ppm bot delegate --chat <chatId> --project <name> --prompt "<enriched>"`
4. CLI creates `bot_tasks` row, returns taskId
5. Service tells user: "Working on it, I'll notify you when done"
6. Background poller (5s) detects pending task
7. Executes: `chatService.createSession()` in target project
8. Streams response, captures summary + full output
9. Updates task status → "completed"
10. Sends Telegram notification with result

**Task Execution (Isolation & Safety):**
- Each task = fresh isolated session (no shared context)
- Timeout: 900s default (configurable per task)
- Abort: AbortController on timeout, can be canceled mid-execution
- Result capture: Both summary (for notification) and full text (for detailed review)
- Error handling: Task status → "failed", error message stored, user notified

**Database Schema (v14):**
- `bot_tasks` — id (UUID), chatId, projectName, projectPath, prompt, status, resultSummary, resultFull, sessionId, error, reported, timeoutMs, createdAt, startedAt, completedAt
- Indexes: `idx_bot_tasks_status` (fast poller lookup), `idx_bot_tasks_chat` (history queries)

**Key Design Decisions:**
1. **Single coordinator session** — Per chat, persistent, one identity (vs. per-task sessions in ClawBot)
2. **Delegation via CLI** — Coordinator calls bash commands (safer than direct DB writes, auditable)
3. **Isolated task execution** — Each delegated task spawns fresh session (no context bleed)
4. **Background polling** — Task execution decoupled from message handler (non-blocking)
5. **Result summary + full** — Notification shows short summary; user can fetch full output via CLI
6. **Cross-provider identity** — Single `coordinator.md` works with any AI provider
7. **Bash-safe tools only** — Coordinator restricted to Bash, Read, Write, Edit, Glob, Grep (safe delegation)

**CLI Expansion (ppm bot commands):**
```
ppm bot delegate --chat <id> --project <name> --prompt "<text>"  # Create task
ppm bot task-status <id>                                          # Check status
ppm bot task-result <id>                                          # Get full output
ppm bot tasks [--chat <id>]                                       # List recent
ppm bot project list                                              # Available projects
ppm bot project current                                           # Active project
ppm bot project switch <name>                                     # Switch project
ppm bot session new <title>                                       # Create session
ppm bot session list                                              # List sessions
ppm bot session resume <id>                                       # Resume session
ppm bot session stop <id>                                         # Stop session
ppm bot status                                                    # Bot health
ppm bot version                                                   # PPM version
ppm bot restart                                                   # Restart service
ppm bot help                                                      # Help
```

**Settings UI (ppmbot-settings-section.tsx):**
- Enable/disable PPMBot
- Paired Telegram chats (approval management)
- Default project selection
- System prompt customization
- Task auto-refresh (poll interval, max history)
- Delegated tasks panel (status, result preview, delete)

---

### ClawBot Service Layer (Telegram Bot Integration) — LEGACY (v0.9.10)
**Component:** Telegram bot service + subsidiary services

**Responsibilities:**
- Receive Telegram messages via long-polling (no webhooks needed)
- Route Telegram user (chatID) to PPM session with pairing-based security
- Persist session state + conversation memory in SQLite (FTS5)
- Stream AI responses back to Telegram with progressive message editing
- Format responses as Telegram HTML with proper chunking (4096 char limit)

**Architecture:**
```
Telegram → ClawBotTelegramService (polling) → ClawBotService (orchestrator)
                                                    ↓
                                            ClawBotSessionService (chatID→sessionID)
                                            ClawBotMemoryService (FTS5 recall)
                                            ChatService + ProviderRegistry
                                            ClawBotStreamerService (ChatEvent→edits)
                                            ClawBotFormatterService (Markdown→HTML)
```

**Services (src/services/clawbot/):**
- **ClawBotService** — Lifecycle management (start/stop), message queue, routing logic
- **ClawBotTelegramService** — Telegram Bot API wrapper (getUpdates long-polling, sendMessage, editMessage, setTyping, command handlers)
- **ClawBotSessionService** — chatID ↔ PPM sessionID bidirectional mapping, session state tracking
- **ClawBotMemoryService** — FTS5 persistent memory (save, recall with relevance, decay factor, supersede logic, cross-project search by name mention)
- **ClawBotFormatterService** — Markdown → Telegram HTML conversion, message chunking (respects 4096 char limit), code block formatting
- **ClawBotStreamerService** — ChatEvent async generator → progressive Telegram message edits (1s throttle for rate limiting)

**Security Model:**
- **Pairing System** — Replace allowlists with code-based pairing: User requests pairing → receives code → owner approves in web UI → chatID registered in `clawbot_paired_chats`
- **Per-User Sessions** — Each Telegram chatID maps to isolated PPM session (no cross-user interference)
- **bypassPermissions** — ClawBot bot runs headless, auto-approves tools (no manual approval flow)

**Database Schema (v13):**
- `clawbot_sessions` — chatID (PK), sessionID (FK chat_sessions), pairedAt, lastUsed
- `clawbot_memories` — id (PK), sessionID (FK), content (text), role (user|assistant), created, decay_factor (FTS5 full-text index)
- `clawbot_paired_chats` — chatID (PK), pairingCode (unique, 6 chars), approvedAt, approvedBy (user ID)

**Key Design Decisions:**
1. **Long-polling** — No webhooks = no public URL required, simpler for self-hosted
2. **Message queue** — Concurrent Telegram messages queued FIFO, prevents race conditions
3. **Progressive edits** — Edit same message for long responses, reduce Telegram API calls, better UX
4. **Memory system** — Hybrid extraction (AI primary + regex fallback), supports cross-project search by project name mention
5. **Config reuse** — Shares existing Telegram bot_token with notifications, separate ClawBotConfig section
6. **Session tagging** — [Claw] prefix visible in web UI without schema changes, robot icon for identification

**Settings Endpoints:**
- `GET /api/settings/clawbot` — Fetch config (enabled, bot token, default project, system prompt, debounce, display toggles)
- `PUT /api/settings/clawbot` — Update config
- `GET /api/clawbot/paired-chats` — List paired Telegram chatIDs
- `POST /api/clawbot/pairing` — Request pairing code (returns code)
- `POST /api/clawbot/pairing/:code/approve` — Approve pairing code (owner only)
- `DELETE /api/clawbot/paired-chats/:chatId` — Revoke pairing

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
- SQLite: WAL mode, foreign keys, lazy init, schema v13 (13 tables: config, connections, accounts, usage_history, session_logs, push_subscriptions, session_map, table_metadata, workspace_state, extension_storage, mcp_servers, clawbot_sessions, clawbot_memories, clawbot_paired_chats)
- Path validation: `projectPath/relativePath` only, reject `..`
- Caching: Directory trees cached with TTL
- Error handling: Descriptive messages (file not found, permission denied)
- Migration: Automatic YAML→SQLite migration on first run with new db.service; schema auto-upgrade on version bump

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

## Chat Streaming Flow (Persistent AsyncGenerator Sessions)

### Architecture Overview (v0.8.55+)

PPM uses a **persistent streaming session** model instead of per-message query execution:

**Key Changes:**
- Provider maintains **long-lived AsyncGenerator streaming input** per chat session (not per message)
- Follow-up messages **push into the existing generator** instead of abort-and-replace
- **Single streaming loop** per session decoupled from WebSocket message handler
- Message priority support: `now` (interrupt current), `next` (queue first), `later` (queue at end)
- Supports image attachments in messages

**Design Benefits:**
- Continuous context preservation — multi-turn conversations flow naturally
- No SDK subprocess restarts between messages (faster)
- Clean separation: BE owns Claude connection, FE disconnect doesn't abort
- Message buffering on reconnect — clients that lose WS connection sync turn events
- Tool approvals don't restart the query — integrated into streaming loop

### Message Flow

```
User types: "Debug this function"
    ↓
MessageInput.tsx calls useChat.sendMessage()
    ↓
useChat opens WebSocket: WS /ws/project/:name/chat/:sessionId
    ↓
Sends: { type: "message", content: "Debug...", priority?: "now"|"next"|"later" }
    ↓
WS handler in chat.ts receives message
    ↓
If already streaming with different content → abort previous + wait cleanup
If streaming, new message priority determines queue behavior:
    • priority: "now" → abort current, restart with new content
    • priority: "next" → push into pending queue (higher priority)
    • priority: "later" → push to end of queue (FIFO)
    ↓
runStreamLoop() executes in detached async context
    ↓
ChatService calls provider.sendMessage() (async generator)
    ↓
Provider (Claude SDK) yields events:
    1. { type: "text", content: "Here's what..." }
    2. { type: "text", content: " happens..." }
    3. { type: "tool_use", tool: "read_file", input: {...} }
    ↓
Stream loop buffers + broadcasts to all connected clients:
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
Provider continues streaming with tool result (no restart)
    ↓
If multiple messages queued, next message processes after done event
    ↓
Final response streamed, then: { type: "done", sessionId }
    ↓
Phase transitions to idle, clients can send new message
    ↓
useChat saves message to store, displays in chat history
```

### Session State Management

**Session Entry** (BE-owned, persists across FE disconnections):
```typescript
interface SessionEntry {
  providerId: string;              // Which AI provider (e.g., "claude")
  clients: Set<ChatWsSocket>;      // Connected FE clients (may be empty)
  abort?: AbortController;         // Current stream abort handle
  projectPath?: string;            // Project context
  projectName?: string;
  pingIntervals: Map<...>;         // Per-client keepalive
  phase: SessionPhase;             // "initializing" | "connecting" | "thinking" | "streaming" | "idle"
  cleanupTimer?: ReturnType<...>;  // Auto-cleanup if no FE reconnects (5min)
  pendingApprovalEvent?: {...};    // Current tool approval waiting
  turnEvents: unknown[];           // Buffered events (for reconnect sync)
  streamPromise?: Promise<void>;   // Track ongoing runStreamLoop
  permissionMode?: string;         // Sticky permission mode for session
}
```

**Client Connection States:**
- **Active streaming + FE connected** → Events broadcast to all clients in real-time
- **Active streaming + FE disconnected** → Events buffered in turnEvents array, BE stream continues
- **FE reconnects** → Receive session_state + buffered turnEvents, resync with stream
- **Idle (no query running)** → Phase is "idle", ready for next message
- **Idle + no FE for 5min** → Cleanup timer removes session from memory

### Follow-up Messages

**Abort-and-Replace Pattern:**
```typescript
if (entry.phase !== "idle" && entry.abort) {
  console.log(`[chat] aborting current query for new message`);
  entry.abort.abort();
  await entry.streamPromise;  // Wait for cleanup
  // Re-fetch entry — may have been mutated during cleanup
  entry = activeSessions.get(sessionId)!;
}
```

**Multiple Message Queueing:**
- First message: immediately starts runStreamLoop
- Second message (while streaming): abort current, wait, start new runStreamLoop
- Priority modes (future): could queue messages for intelligent interleaving

### WebSocket Reconnection Sync

```
FE WebSocket closes (network issue, tab closes)
    ↓
BE keeps session alive, streaming continues
    ↓
FE reconnects: WS /ws/project/:name/chat/:sessionId
    ↓
open() handler checks activeSessions.get(sessionId)
    ↓
If exists (entry found):
    1. Clear cleanup timer (FE is back)
    2. Send session_state with current phase + pendingApproval
    3. If phase !== "idle", send buffered turnEvents
    4. Add WS to clients Set
    ↓
FE processes session_state, renders current phase
    ↓
FE applies buffered events to rebuild turn state
    ↓
FE displays: "reconnected, current phase: streaming" etc.
```

### Phase Transitions

```
idle → initializing → connecting → thinking/streaming ↔ thinking/streaming → idle
  ^                                      ↑                                    ↓
  └──────────────────────────────────────────────────────────────────────────┘
```

**Phase Descriptions:**
- **idle** — No query running, ready to accept new message
- **initializing** — Preparing (permission checks, session resume)
- **connecting** — Waiting for first SDK event (heartbeat: "connecting" with elapsed time every 5s)
- **thinking** — Receiving thinking content (extended thinking)
- **streaming** — Receiving text/tool_use content (dynamic switch between thinking/streaming)

### Image Attachment Support

Messages can now include images:
```typescript
type ChatWsClientMessage =
  | { type: "message"; content: string; images?: { id: string; data: string }[]; priority?: string }
  | ...
```

Images are passed to provider's message context and included in tool input/output.

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
CREATE TABLE accounts (
  id TEXT PRIMARY KEY,
  account_name TEXT NOT NULL,
  encrypted_api_key TEXT NOT NULL,
  priority INTEGER DEFAULT 0,
  is_active INTEGER DEFAULT 0, -- 1 = active, 0 = inactive
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

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

## MCP Server Management

### Overview
MCP (Model Context Protocol) servers extend Claude with custom tools and resources. PPM manages MCP server configurations via Settings UI, storing them in SQLite and passing them to the Claude Agent SDK.

**Features:**
- **Add/Edit/Delete** MCP servers via Settings UI
- **Auto-import** from `~/.claude.json` on first access (convenience, no forced import)
- **Three transport types:** stdio, HTTP, SSE
- **Validation** on name and config before storage
- **SDK integration:** Servers passed to `query()` as `mcpServers` object, tools auto-allowed via `mcp__*` wildcard

### Storage Schema

```sql
CREATE TABLE mcp_servers (
  name TEXT PRIMARY KEY,
  transport TEXT NOT NULL DEFAULT 'stdio',  -- 'stdio' | 'http' | 'sse'
  config TEXT NOT NULL,                     -- JSON: McpServerConfig
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);
```

**Config Format (JSON):**
```json
{
  "type": "stdio",
  "command": "path/to/server",
  "args": ["--flag"],
  "env": { "VAR": "value" }
}
```

Or HTTP/SSE:
```json
{
  "type": "http",
  "url": "http://localhost:3000",
  "headers": { "Authorization": "Bearer token" }
}
```

### REST API

**Endpoints** (`src/server/routes/mcp.ts`):

| Method | Endpoint | Description |
|--------|----------|-------------|
| **GET** | `/api/settings/mcp` | List all servers; auto-import on first access |
| **GET** | `/api/settings/mcp/:name` | Get single server config |
| **POST** | `/api/settings/mcp` | Add new server (validates name + config) |
| **PUT** | `/api/settings/mcp/:name` | Update existing server |
| **DELETE** | `/api/settings/mcp/:name` | Remove server |
| **GET** | `/api/settings/mcp/import/preview` | Preview servers in `~/.claude.json` |
| **POST** | `/api/settings/mcp/import` | Bulk import from `~/.claude.json` |

**Add Server Example:**
```bash
POST /api/settings/mcp
Content-Type: application/json

{
  "name": "file-server",
  "config": {
    "type": "stdio",
    "command": "/usr/local/bin/file-server",
    "args": ["--port", "8000"]
  }
}
```

### Service Layer

**McpConfigService** (`src/services/mcp-config.service.ts`):
- `list()` — Record<name, McpServerConfig> (SDK-compatible format)
- `listWithMeta()` — Array with metadata (for UI)
- `get(name)` — Single server config
- `set(name, config)` — Add or update (upsert)
- `remove(name)` — Delete server
- `exists(name)` — Check if name exists
- `bulkImport(servers)` — Transactional import from `~/.claude.json`, skips existing/invalid

**Validation:**
- `validateMcpName(name)` — alphanumeric + hyphens/underscores, max 50 chars
- `validateMcpConfig(config)` — type-specific checks (command for stdio, url for http/sse)

### Frontend Integration

**UI Components:**
- `MCP Settings Section` (`src/web/components/settings/mcp-settings-section.tsx`) — Tab in Settings UI
- `MCP Server Dialog` (`src/web/components/settings/mcp-server-dialog.tsx`) — Add/Edit modal
- `API client` (`src/web/lib/api-mcp.ts`) — Fetch/mutate operations

**Workflow:**
1. User opens Settings → MCP tab
2. **GET** `/api/settings/mcp` (auto-imports on first access)
3. Display list with transport badge + actions (edit, delete)
4. Click "Add" → Dialog with name + transport selector + config fields
5. **POST** to `/api/settings/mcp` or **PUT** to update
6. On success, list refreshes

### SDK Integration

**Claude Agent SDK Provider** (`src/providers/claude-agent-sdk.ts`):
```typescript
// Line ~574
const mcpServers = mcpConfigService.list();
const hasMcp = Object.keys(mcpServers).length > 0;

// Line ~589: Pass to query() if servers exist
const mcpTools = ["mcp__*"];
const queryConfig = {
  // ... other options
  ...(hasMcp && { mcpServers }),
  allowedTools: [...otherTools, ...mcpTools],
};

const query = new Query(messages, queryConfig);
```

---

## Extension System (v0.9.0+)

### Overview

PPM Extension System enables VSCode-compatible, npm-installable extensions that run in isolated Bun Worker threads. Crash-safe, permission-based, with RPC messaging between main process and worker, and WebSocket bridge for real-time UI updates.

**Architecture (3-tier):**
```
Extension Code (Bun Worker)        ← @ppm/vscode-compat API
  │ RPC (postMessage)
  ▼
Main Process (Hono/Bun)            ← extension-rpc-handlers.ts
  │ WebSocket (/ws/extensions)
  ▼
Browser (React)                    ← Zustand store + React components
```

**Key components:**
- **Package Format:** npm packages (`@ppm/ext-database`, `@ppm/ext-docker`, etc.)
- **Installation:** `~/.ppm/extensions/node_modules/{id}/`
- **Lifecycle:** Install → Enable → Activate → Deactivate → Remove
- **Worker Isolation:** Each activated extension runs in a Bun Worker (crash-safe, 10s activation timeout)
- **Communication:** RPC (Worker↔Main) + WebSocket (Main↔Browser)
- **API Shim:** `@ppm/vscode-compat` — VSCode-compatible API (commands, window, workspace)
- **State Storage:** globalState + workspaceState in SQLite via Memento
- **UI Bridge:** StatusBar, TreeView, WebviewPanel, QuickPick, InputBox, Notifications
- **Contributions:** Commands, views, configuration contributed via manifest

### Manifest Format

Extension metadata defined in `package.json` under `ppm` key:

```json
{
  "name": "@ppm/ext-database",
  "version": "1.0.0",
  "main": "dist/extension.js",
  "ppm": {
    "displayName": "Database Browser",
    "description": "Browse and query databases",
    "icon": "database.svg",
    "engines": { "ppm": ">=0.9.0" },
    "activationEvents": ["onView:databases"],
    "contributes": {
      "commands": [
        {
          "command": "ppm.database.openConnection",
          "title": "Open Database Connection",
          "category": "Database"
        }
      ],
      "views": {
        "explorer": [
          {
            "id": "databases",
            "name": "Databases",
            "type": "tree"
          }
        ]
      },
      "configuration": {
        "properties": {
          "ppm.database.maxRows": {
            "type": "number",
            "default": 1000,
            "description": "Max rows to fetch per query"
          }
        }
      }
    }
  }
}
```

**Fields:**
- `engines.ppm` — PPM version requirement
- `activationEvents` — When extension activates (e.g., `onView:databases`, `onCommand:ext.activate`)
- `contributes` — UI elements + commands contributed by extension

### Installation & Lifecycle

**Installation** (`ppm ext install @ppm/ext-database`):
1. Fetch package from npm
2. Extract to `~/.ppm/extensions/node_modules/{id}/`
3. Parse manifest from `package.json`
4. Store in SQLite `extensions` table (enabled=1)
5. Discover contributions

**Activation** (`ppm ext enable @ppm/ext-database` or automatic):
1. Load manifest + entry point from disk
2. Spawn Bun Worker (process isolation)
3. Create scoped `@ppm/vscode-compat` API instance (RPC-backed)
4. Call `activate(context, vscodeApi)` with 10s timeout
5. Register contributions in `contributionRegistry`
6. Broadcast `contributions:update` via WS to all connected browsers
7. Mark as activated

**Deactivation:**
1. Unregister contributions
2. Terminate worker
3. Clear persisted state if needed

**Removal** (`ppm ext remove @ppm/ext-database`):
1. Deactivate if active
2. Delete from `~/.ppm/extensions/`
3. Remove from SQLite
4. Unregister contributions

### RPC Protocol (Extension ↔ Main Process)

**Message Types:**

1. **Request** (extension → main)
   ```json
   {
     "type": "request",
     "id": 1,
     "method": "storage:get",
     "params": ["extId", "global", "key"]
   }
   ```

2. **Response** (main → extension)
   ```json
   {
     "type": "response",
     "id": 1,
     "result": "value"
   }
   ```

3. **Event** (both directions)
   ```json
   {
     "type": "event",
     "event": "file:changed",
     "data": { "path": "/path/to/file" }
   }
   ```

**Built-in Methods:**
- `storage:get(extId, scope, key)` — Get persistent value
- `storage:set(extId, scope, key, value)` — Set persistent value
- `storage:delete(extId, scope, key)` — Delete key
- Extension can define custom RPC methods via `rpc.onRequest(method, handler)`

### State Storage

**Database Schema:**

```sql
CREATE TABLE extension_storage (
  ext_id TEXT NOT NULL,
  scope TEXT NOT NULL,  -- 'global' | 'workspace'
  key TEXT NOT NULL,
  value TEXT,           -- JSON-serialized
  PRIMARY KEY (ext_id, scope, key)
);
```

**Scopes:**
- **globalState** — Persists across all projects (e.g., user settings, cache)
- **workspaceState** — Project-specific state (e.g., open panel state)

**API** (inside extension):
```typescript
// In activate(context: ExtensionContext)
const globalVal = context.globalState.get("lastConnection", "default");
await context.globalState.update("lastConnection", "my-db");

const wsVal = context.workspaceState.get("selectedTable");
await context.workspaceState.update("selectedTable", "users");
```

### WebSocket Bridge (Extension ↔ Browser)

Extensions interact with the browser UI via a dedicated WebSocket at `/ws/extensions`. The main process translates between Worker RPC and WS messages.

**Server → Client (ExtServerMsg):** `tree:update`, `tree:refresh`, `statusbar:update/remove`, `notification`, `quickpick:show`, `inputbox:show`, `webview:create/html/dispose/postMessage`, `contributions:update`

**Client → Server (ExtClientMsg):** `ready`, `command:execute`, `tree:expand/click`, `webview:message`, `quickpick:resolve`, `inputbox:resolve`, `notification:action`

**Message routing:**
- Extension calls `vscode.window.showInformationMessage()` → RPC → `extension-rpc-handlers.ts` → `broadcastExtMsg()` → WS → `use-extension-ws` hook → toast notification
- Browser user clicks tree item → WS `tree:click` → `extensions.ts` → Worker RPC `ext:command:execute` → CommandService → extension handler
- Webview iframe postMessage → parent → CustomEvent → WS `webview:message` → Worker RPC `ext:webview:message` → EventEmitter → extension's `onDidReceiveMessage` handler

**Request/response pattern:** QuickPick, InputBox, and notification actions use `requestFromBrowser(msg, trackingId, 30s timeout)` — sends WS message and awaits browser response via pending Promise map.

### UI Components

Extension UI state lives in Zustand (`extension-store.ts`) and renders via React:
- **StatusBar** — Fixed bottom bar with left/right aligned items
- **TreeView** — Recursive tree with expand/collapse, renders in sidebar for `ext:*` tabs
- **WebviewPanel** — Sandboxed iframe (`allow-scripts` only), `acquireVsCodeApi()` shim auto-injected
- **QuickPick** — Filterable picker with keyboard nav, bottom-sheet on mobile
- **InputBox** — Text input dialog with password mode support
- **Command Palette** — Extension commands merged with built-in commands

### Contribution Registry

**Purpose:** Central registry of all extension contributions (commands, views, etc.)

**Storage:** In-memory map during runtime

**Endpoints:**
- `GET /api/extensions/contributions` — List all active contributions

**Contribution Types:**
1. **Commands** — Callable actions (e.g., `ppm.database.openConnection`)
   - Registered: `registry.registerCommand(extId, command)`
   - Invoked: `POST /api/extensions/{extId}/commands/{command}`

2. **Views** — Sidebar panels or tree views
   - Registered: `registry.registerView(extId, view)`
   - Rendered in UI based on `type` (tree, webview)

3. **Configuration** — Settings schema
   - Registered: `registry.registerConfig(extId, schema)`
   - Merged with global settings

### CLI Commands

```bash
ppm ext list                      # List installed extensions
ppm ext install @ppm/ext-database # Install from npm
ppm ext remove @ppm/ext-database  # Uninstall
ppm ext enable @ppm/ext-database  # Enable extension
ppm ext disable @ppm/ext-database # Disable extension
ppm ext dev /path/to/ext-src      # Symlink local extension for dev
ppm ext config <ext-id> <key> <value> # Set config value
```

**Dev Mode** (`ppm ext dev /path/to/src`):
- Symlinks local extension to `~/.ppm/extensions/node_modules/`
- Auto-reloads on file change
- Extension runs from source (TypeScript not compiled)

### REST API

**Endpoints** (`src/server/routes/extensions.ts`):

| Method | Endpoint | Description |
|--------|----------|-------------|
| **GET** | `/api/extensions` | List installed extensions |
| **POST** | `/api/extensions` | Install extension (body: {name, version?}) |
| **GET** | `/api/extensions/:id` | Get extension info (manifest, status) |
| **DELETE** | `/api/extensions/:id` | Remove extension |
| **PATCH** | `/api/extensions/:id` | Update extension (body: {enabled}) |
| **GET** | `/api/extensions/contributions` | List all contributions (commands, views, config) |
| **POST** | `/api/extensions/:id/commands/:cmd` | Invoke extension command |

**Example: Install Extension**
```bash
POST /api/extensions
Content-Type: application/json

{ "name": "@ppm/ext-database", "version": "1.0.0" }

# Response
{
  "ok": true,
  "data": {
    "id": "@ppm/ext-database",
    "version": "1.0.0",
    "displayName": "Database Browser",
    "enabled": true,
    "activated": false
  }
}
```

### Service Layer

**ExtensionService** (`src/services/extension.service.ts`):
- `discover()` — Scan `~/.ppm/extensions/` for installed packages
- `install(name)` — Fetch from npm, install locally
- `remove(id)` — Uninstall extension
- `activate(id)` — Load + run extension in worker
- `deactivate(id)` — Terminate worker, cleanup
- `parseManifest(pkg)` — Extract manifest from package.json
- `setExtensionState(extId, scope, key, value)` — Persist state

**ExtensionInstaller** (`src/services/extension-installer.ts`):
- `installExtension(name, dir)` — npm install + verify
- `removeExtension(id, dir)` — rm -rf extension directory
- `devLinkExtension(localPath)` — Symlink for local dev

**ExtensionManifest** (`src/services/extension-manifest.ts`):
- `parseManifest(pkg)` — Validate + parse ppm section
- `discoverManifests(dir)` — Scan all installed extensions

**RpcChannel** (`src/services/extension-rpc.ts`):
- Bidirectional RPC messaging
- Request/response matching by ID
- Event broadcasting
- Timeout handling

### Worker Integration

**ExtensionHostWorker** (`src/services/extension-host-worker.ts`):
- Worker-side code that loads + activates extension
- Loads extension code into worker context
- Exposes ExtensionContext API (globalState, workspaceState, subscriptions)
- Handles incoming RPC messages
- Communicates back to main process

**Design:**
```
Main Process                Worker
     ↓                         ↓
 ExtensionService    ExtensionHostWorker
     ↓                         ↓
 RpcChannel ←────────────→ RpcChannel
     ↓                         ↓
 Sends: {                Extension Code
   type: "request",      (User's ext.ts)
   method: "..."        ↓
 }                   activate(context)
     ↓                   ↓
 Handlers respond  context.storage.get()
     ↑                   ↑
     └─────────────────┘
```

### Dev Workflow

**Creating an Extension:**

1. Create npm package:
   ```bash
   npm init -y @ppm/ext-my-feature
   npm install @ppm/extension-api
   ```

2. Write `src/extension.ts`:
   ```typescript
   import type { ExtensionContext } from "@ppm/extension-api";

   export async function activate(context: ExtensionContext) {
     console.log(`Extension ${context.extensionId} activated!`);
     
     const val = context.globalState.get("count", 0);
     await context.globalState.update("count", val + 1);
   }

   export function deactivate() {
     console.log("Extension deactivated");
   }
   ```

3. Add to `package.json`:
   ```json
   {
     "ppm": {
       "displayName": "My Feature",
       "main": "dist/extension.js",
       "contributes": {
         "commands": [...]
       }
     }
   }
   ```

4. Install locally for dev:
   ```bash
   ppm ext dev /path/to/ext-my-feature
   ```

5. Extension auto-activates based on `activationEvents`, state persists

### Crash Safety

**Worker Isolation:**
- Each extension in isolated Bun Worker thread
- Worker crash doesn't crash main process
- Error events logged, extension marked as failed
- Main process continues operating

**Cleanup:**
- Worker terminates → cleanup timer expires after 5min
- Persisted state preserved in SQLite (not lost on crash)
- Next activation reloads from disk, state auto-restored

### Future Enhancements (Phase 2+)

- **UI Webview Support** — Extensions define HTML/React UI panels
- **Extension Settings UI** — Auto-generate UI from `contributes.configuration`
- **Hot Reload** — Auto-reload extension on file change during dev
- **Marketplace** — Browse, rate, publish extensions (v1.0+)
- **Permissions** — User prompt for sensitive operations
- **Inter-Extension API** — Extensions can call each other via RPC

---

**Tool Allow List:**
- All MCP tools automatically allowed via wildcard `mcp__*`
- MCP server connection failures don't block chat (logged as warning)

### Import Flow

**Auto-import on first access:**
1. GET `/api/settings/mcp` called
2. If table is empty, read `~/.claude.json`
3. If `mcpServers` key exists, bulk import (validate + skip duplicates)
4. Return populated list

**Manual import:**
1. GET `/api/settings/mcp/import/preview` — show what's available
2. POST `/api/settings/mcp/import` — import validated servers
3. Returns `{ imported: N, skipped: M }`

### Error Handling

| Scenario | Response |
|----------|----------|
| Invalid name (non-alphanumeric) | 400 Bad Request |
| Invalid config (missing required fields) | 400 Bad Request |
| Duplicate name | 409 Conflict |
| Server not found (GET/:name, PUT/:name, DELETE/:name) | 404 Not Found |
| `~/.claude.json` not found (import) | 404 Not Found |
| Corrupt config JSON (recovery) | Log warning, skip entry, continue |

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
  → Supervisor spawns server + tunnel, monitors health
  → Status saved to ~/.ppm/status.json (with PID, port, host, shareUrl, supervisorPid, availableVersion)
  → Fallback compat: ppm.pid read/written for backward compatibility
  → Supervisor checks npm registry every 15min for updates, writes availableVersion to status.json

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
  ├── Server Child (Hono HTTP server)
  │   ├── Health checks every 30s (/api/health)
  │   ├── Auto-restart on crash (exponential backoff, max 10 restarts)
  │   └── If in "stopped" state, serves minimal 503 page instead of restarting
  │
  ├── Tunnel Child (Cloudflare Quick Tunnel, if --share)
  │   ├── URL probe every 2min
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
  │   ├── Lightweight HTTP handler on same port as server
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
- Status file: `~/.ppm/status.json` — PID, port, host, shareUrl, supervisorPid, availableVersion, state
- Lock file: `~/.ppm/.start-lock` — Prevent concurrent starts
- Command file: `~/.ppm/.supervisor-cmd` — IPC for soft_stop, resume, self_replace

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

