# PPM Project Changelog

All notable changes to PPM are documented here. Format follows [Keep a Changelog](https://keepachangelog.com/).

**Current Version:** v0.9.72

---

## [Unreleased] — Slash-Discovery Module (in progress)

### Added
- **Modular Slash-Discovery Engine** — Composable, testable command discovery replacing monolithic `slash-items.service.ts`
  - Skill root discovery: user-global (`~/.claude/skills/`), env vars, bundled assets
  - SKILL.md parsing + loose `.md` file + command registry support
  - Shadowing resolution: project > user > bundled priority hierarchy
  - Fuzzy search via Levenshtein distance with configurable tolerance
  - Built-in command registry (9 commands: /skills, /version, /help, etc.)
  - CLI tool: `ppm skills list|search|info` with JSON output and project filtering
  - API endpoint: `GET /chat/slash-items?q=<query>` for server-side search
  - WebSocket interception for /skills and /version commands (execute locally before SDK)
  - Auto-generated bundled guide skill from docs (`assets/skills/ppm-guide/SKILL.md`)

### Technical Details
- **Files Created:**
  - `src/services/slash-discovery/` — 9 modular files (types, discovery, loading, searching, handlers)
  - `src/cli/commands/skills-cmd.ts` — CLI command handler
  - `scripts/generate-ppm-guide.ts` — Guide skill generator
  - `assets/skills/ppm-guide/SKILL.md` — Auto-generated from docs
- **Files Modified:**
  - `src/server/routes/chat.ts` — Integrated discovery module for slash-items endpoint
  - `src/server/ws/chat.ts` — Intercept /skills, /version before SDK dispatch
  - `src/cli/index.ts` — Registered skills command
  - `package.json` — Added `generate:guide` script
- **Breaking Changes:** None (existing `/chat/slash-items` endpoint preserved, new response includes `type` field)

---

## [0.9.72] — 2026-04-09

### Added
- **Account Selection Pre-flight Loop** — Intelligent account fallback during token refresh
  - AccountSelector.next() now accepts excludeIds Set to skip previously failed accounts
  - Pre-flight token refresh loop tries all accounts before final failure (was linear before)
  - New AccountSelector.onPreflightFail() method handles preflight failure with 1-5min backoff
  - Status updates streamed to UI as blockquotes during routing/refreshing/switching phases
  - Cumulative penalty: preflight failures counted with rate-limit and auth-error retries

### Technical Details
- **Files Modified:**
  - `src/providers/claude-agent-sdk.ts` — Pre-flight loop with excludeIds exclusion set
  - `src/services/account-selector.service.ts` — excludeIds parameter, onPreflightFail() method
  - `src/types/chat.ts` — New status_update ChatEvent type
  - `src/web/components/chat/message-list.tsx` — Render status_update as blockquote
- **Type Changes:** status_update event = { type: "status_update", phase: "routing" | "refreshing" | "switching", message, accountLabel? }
- **Breaking Changes:** None (backward compatible)

---

## [0.9.11] — 2026-04-07

### Added
- **PPMBot Coordinator Redesign** — Transform from direct AI chat executor to intelligent team leader delegating to subagents
  - Single persistent coordinator session per Telegram chat in `~/.ppm/bot/` workspace
  - Decision framework: Answer directly if no project context needed; delegate for file access, project-specific tasks
  - Delegation via bash: `ppm bot delegate --chat <id> --project <name> --prompt "<enriched>"` creates task
  - Background task poller (5s interval) executes pending tasks in isolation
  - Each task execution: Creates fresh PPM session in target project, runs async generator, captures result summary
  - Abort/timeout handling: AbortController-based task cancellation, 900s default timeout
  - UI: Settings panel displays delegated tasks with auto-refresh
  - CLI expansion: `ppm bot` commands for delegation, project management, session control, status queries
  - Telegram commands reduced: 3 public (/start, /help, /status) + 1 hidden (/restart)
  - Coordinator identity: `~/.ppm/bot/coordinator.md` replaces per-session identity, loaded via XML context block
  - Cross-provider support: Coordinator identity works with any provider (Claude SDK, Cursor, etc.)

### Technical Details
- **Database Migration (v14):**
  - `bot_tasks` — taskId, chatId, projectName, projectPath, prompt, status, resultSummary, resultFull, error, timeoutMs, createdAt, startedAt, completedAt
  - Indexes: `idx_bot_tasks_status`, `idx_bot_tasks_chat` for fast polling + history queries
- **Files Created:**
  - `src/services/ppmbot/ppmbot-delegation.ts` — executeDelegation() function with task lifecycle management
- **Files Modified:**
  - `src/services/ppmbot/ppmbot-service.ts` — Task poller loop, lifecycle management (start/stop)
  - `src/services/ppmbot/ppmbot-session.ts` — PPMBotSessionManager with coordinator session cache
  - `src/services/db.service.ts` — Schema v14 migration, bot_tasks CRUD functions
  - `src/cli/commands/bot-cmd.ts` — Expanded with delegation, project, session, status, help commands
  - `src/server/routes/settings.ts` — Bot tasks endpoints for UI refresh
  - `src/web/components/settings/ppmbot-settings-section.tsx` — Delegated tasks panel with auto-refresh
- **Type Changes:**
  - New: `BotTask`, `BotTaskStatus` ("pending" | "running" | "completed" | "failed" | "timeout")
  - New: `PPMBotCommand` with chatId, messageId, userId
- **API Changes:** New endpoints for bot task management
- **Breaking Changes:** None (coordinator coexists with legacy ClawBot; migration transparent)

### Key Design Principles
- **Coordinator per chat** — Single session manages delegation, not direct chat
- **Project isolation** — Each delegated task spawns fresh isolated session
- **CLI-driven delegation** — Coordinator calls bash `ppm bot` commands (bash-safe tools only)
- **Background execution** — Task polling decoupled from message handler
- **Result capture** — Store both summary (notification) and full output (detailed review)

---

## [0.9.10] — 2026-04-06

### Added
- **Supervisor Always Alive Feature** — Distinguish between soft stop (server shutdown) and full shutdown (supervisor shutdown)
  - `ppm stop` now performs SOFT STOP: kills server only, supervisor remains alive with Cloud WS + tunnel connectivity
  - `ppm stop --kill` or `ppm down` performs FULL SHUTDOWN: kills everything (old `ppm stop` behavior)
  - Supervisor now has new `stopped` state (in addition to running, paused, upgrading)
  - When stopped, minimal HTML page served on the port (503 status on /api/health)
  - `ppm start` detects existing supervisor and handles resume/upgrade scenarios
  - Autostart now uses `__supervise__` instead of `__serve__` for consistency
  - Cloud WS has new commands: `start`, `shutdown` (stop is now soft stop, separate from shutdown)
  - Supervisor has uncaughtException/unhandledRejection handlers (never crashes)
  - Supervisor logic modularized into 3 files: supervisor.ts (orchestrator), supervisor-state.ts (state machine), supervisor-stopped-page.ts (503 page)

### Technical Details
- **Files Created:**
  - `src/services/supervisor-state.ts` — State machine, IPC command file handling
  - `src/services/supervisor-stopped-page.ts` — Minimal 503 HTML response
  - Enhanced `src/services/supervisor.ts` — Orchestrator with stopped state support
- **Files Modified:**
  - `src/cli/commands/stop.ts` — Added --kill flag, soft stop default, ppm down alias
  - `src/cli/commands/start.ts` — Resume detection for existing supervisor
  - `src/cli/autostart-generator.ts` — Uses __supervise__ entry point
  - Cloud WS endpoints updated with new commands
- **Type Changes:** SupervisorState = "running" | "paused" | "stopped" | "upgrading"
- **API Changes:** GET /api/health returns 503 when server stopped (supervisor still running)
- **Breaking Changes:** None (backward compatible, graceful fallback)

---

## [0.9.10] — 2026-04-06

### Added
- **ClawBot Telegram Integration** — Telegram bot service layer for AI-powered messaging
  - Telegram long-polling: receive messages via polling (no webhooks needed for self-hosted)
  - Session routing: chatID → PPM session mapping with per-user thread isolation
  - Memory system: SQLite FTS5 for persistent conversation history + recall with decay/supersede
  - Response streaming: ChatEvent → progressive Telegram message editing (1s throttle)
  - Message formatting: Markdown → Telegram HTML with 4096-character chunking
  - Pairing system: Code-based device pairing for security (owner approves in web UI)
  - Message queue: Handle concurrent Telegram messages without race conditions
  - Settings UI: Enable/disable, paired devices, default project, system prompt, display toggles, debounce config
  - Chat history: [Claw] prefix sessions with robot icon for easy identification
  - Cross-project memory: Auto-detect project name mentions → include that project's memories in context

### Technical Details
- **Database Migration (v13):**
  - `clawbot_sessions` — chatID, sessionID, pairedAt, lastUsed
  - `clawbot_memories` — sessionID, content, role, created, decay_factor (FTS5)
  - `clawbot_paired_chats` — chatID, pairingCode, approvedAt, approvedBy
- **Files Created:**
  - `src/services/clawbot/clawbot.service.ts` — Main orchestrator
  - `src/services/clawbot/clawbot-telegram.ts` — Telegram API polling
  - `src/services/clawbot/clawbot-session.ts` — Session mapping
  - `src/services/clawbot/clawbot-memory.ts` — FTS5 memory CRUD + hybrid extraction (AI + regex)
  - `src/services/clawbot/clawbot-formatter.ts` — Markdown → Telegram HTML
  - `src/services/clawbot/clawbot-streamer.ts` — ChatEvent → progressive message edits
  - `src/types/clawbot.ts` — Type definitions
  - `src/web/components/settings/clawbot-settings-section.tsx` — Settings UI
- **Files Modified:**
  - `src/services/db.service.ts` — Schema v13 migration
  - `src/types/config.ts` — ClawBotConfig interface
  - `src/server/index.ts` — ClawBot poller startup
  - `src/server/routes/settings.ts` — ClawBot settings endpoints (GET/PUT)
  - `src/web/components/settings/settings-tab.tsx` — ClawBot category
  - `src/web/components/chat/chat-history-bar.tsx` — [Claw] prefix + icon tagging

### Key Design Principles
- **Long-polling over webhooks** — Simpler self-hosted setup, no public URL required
- **bypassPermissions by default** — Headless bot, no manual tool approvals needed
- **Hybrid memory extraction** — AI extraction (primary) + regex fallback (fallback)
- **Progressive message editing** — 1s throttle balances UX with Telegram rate limits
- **Message debouncing** — 2s default, configurable per session
- **Pairing-based security** — Replace allowlists with owner-approved pairing codes

---

## [0.9.9] — 2026-04-04

### Added
- **Agent Teams (experimental)** — Toggle in Settings > AI to enable multi-agent collaboration
  - Passes `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` to SDK subprocess when enabled
  - Adds `TeamCreate`, `TeamDelete`, `SendMessage`, `TaskCreate`, `TaskUpdate`, `TaskList`, `TaskGet` to allowed tools
  - Switch UI with warning about experimental status and ~7x token cost
  - Default: off. Requires Claude Code v2.1.32+
- **Agent Team UI — Real-time Monitoring** — Visual collaboration dashboard for active teams
  - Backend: REST endpoints (`GET /api/teams`, `GET /api/teams/:name`, `DELETE /api/teams/:name`) + fs.watch inbox monitor via chat WebSocket
  - Real-time inbox events: `team_detected`, `team_inbox`, `team_updated` streamed to chat clients
  - Frontend: Team activity button on chat input (Users icon with unread pulse dot)
  - Desktop popover / Mobile drawer showing members (with status badges) + message timeline
  - Settings UI: Team list in AI Settings with delete confirmation (only for inactive teams)
  - Architecture: Type-safe types (`src/types/team.ts`), extracted team-inbox-watcher module, zero new type errors
  - Mobile-first: Responsive popover/drawer, touch-friendly delete actions

---

## [0.9.2] — 2026-04-04

### Added
- **File Download Feature** — Single-file and folder-as-zip downloads with short-lived tokens
  - Download tokens: one-time, 30s TTL, non-reusable
  - Backend: POST `/files/download/token` for token generation, GET `/files/raw?download=true&dl_token=X` for file downloads, GET `/files/download/zip?path=X` for folder zips
  - Frontend: Download context menu in file tree, download button in editor toolbar
  - Security: Tokens scoped to download paths only, path traversal protection maintained
  - Performance: Streaming via Bun.file() and archiver, no RAM buffering for large files
  - Testing: 30 integration tests covering auth, streaming, path traversal, zip integrity

### Technical Details
- **Files Created:**
  - `src/services/download-token.service.ts` — In-memory token store with TTL cleanup
  - `src/server/routes/file-download.ts` — Download endpoints (token + zip)
  - `src/web/lib/file-download.ts` — Download utilities (single file + folder)
  - `tests/integration/file-download.test.ts` — Integration tests
- **Files Modified:**
  - `src/server/middleware/auth.ts` — Added dl_token fallback for downloads
  - `src/server/routes/files.ts` — Added ?download=true mode
  - `src/server/routes/project-scoped.ts` — Registered download routes
  - `src/web/components/explorer/file-tree.tsx` — Added download context menu item
  - `src/web/components/editor/editor-toolbar.tsx` — Added download button
  - `src/web/components/editor/code-editor.tsx` — Passed filePath/projectName to toolbar
  - `src/server/helpers/error-status.ts` — Extracted shared error helper
- **Dependencies:**
  - `archiver` — Streaming zip library (well-maintained, ~500KB)

---

## [0.9.0] — 2026-04-03

### Added
- **Extension System (Phase 1-6)** — VSCode-compatible npm extensions with Bun Worker isolation, RPC protocol, @ppm/vscode-compat API shim, UI components (TreeView, WebviewPanel, StatusBar, QuickPick, InputBox), WS bridge, ext-database demo extension, Extension Manager UI, CLI support
- **Multi-Provider AI** — ProviderInterface, CliProvider base, CursorCliProvider with NDJSON streaming, provider selector UI
- **MCP Server Management** — REST API CRUD, SQLite storage, Settings UI, auto-import from ~/.claude.json, SDK integration
- **ext-database extension** — Connection tree with color dots/badges/actions, table viewer webview with data grid/inline editing/pagination/SQL panel, add connection via QuickPick+InputBox flow

### Technical Details
- Extension architecture: npm packages isolated in Bun Workers, communicate via RPC, manifest-driven contribution points (commands, views, menus, configuration)
- Multi-provider: Tier 1 (Claude Agent SDK, full agentic), Tier 2 (Cursor CLI, agentic via own tool system)
- MCP: Servers passed to SDK as `mcpServers`, tools auto-allowed via `mcp__*` wildcard

---

## [0.8.77] — 2026-04-01

### Added
- **Deterministic Tab URLs + Backend Workspace Sync**
  - Tab IDs now deterministic ({type}:{identifier}) instead of random (tab-xxxx)
  - URL format changed: `/project/{name}/{tabType}/{identifier}` (e.g., `/project/ppm/editor/src/index.ts`)
  - New `workspace_state` database table (schema v10) persists tab layout per project
  - GET/PUT `/api/project/:name/workspace` endpoints for server-side persistence
  - Frontend syncs workspace layout to server with 1.5s debounce
  - Deep linking from URL auto-creates tabs if missing
  - Latest-wins conflict resolution: server timestamp > client localStorage
  - Tab ID patterns standardized: `editor:path`, `chat:provider/sessionId`, `terminal:index`, etc.
  - Migration from random IDs to deterministic IDs on first load

### Technical Details
- **Files Created:**
  - `src/server/routes/workspace.ts` — Workspace GET/PUT endpoints
  - `src/web/hooks/use-workspace-sync.ts` — Server sync orchestration with debounce
- **Files Modified:**
  - `src/services/db.service.ts` — Added workspace_state table (schema v10), helper functions
  - `src/web/stores/panel-utils.ts` — Deterministic tab ID derivation logic
  - `src/web/hooks/use-url-sync.ts` — URL parsing/building with new format
  - `src/web/stores/panel-store.ts` — Load workspace from server on project switch
  - `src/web/stores/tab-store.ts` — Tab interface updated with metadata
- **Breaking Changes:** URLs changed; old `/project/{name}/tab/{id}` URLs redirected or ignored (fallback to project root)
- **Migration:** Client-side: old random tab IDs migrated to deterministic format on first load

### Benefits
- **Shareable deep links** — URLs point to specific files/chats (e.g., `/project/ppm/editor/src/index.ts`)
- **Cross-device persistence** — Workspace layout saved on server, restored on any device
- **URL-driven navigation** — Paste URL to recreate workspace state
- **Conflict-free sync** — Latest timestamp wins; no manual merge dialogs

---

## [0.8.63] — 2026-03-28

### Added
- **MCP Server Management** — Configure Model Context Protocol servers via Settings UI
  - REST API: GET/POST/PUT/DELETE `/api/settings/mcp`, plus import endpoints
  - Storage: SQLite `mcp_servers` table (name, transport, config JSON)
  - UI: Settings tab with server list, add/edit dialog, delete action
  - Auto-import: Reads `~/.claude.json` on first access (skips existing/invalid)
  - Validation: Name (alphanumeric, max 50 chars) + transport-specific config checks
  - SDK integration: Servers passed to `query()` as `mcpServers`, tools auto-allowed via `mcp__*` wildcard

### Technical Details
- **Files Created:**
  - `src/types/mcp.ts` — McpServerConfig types, validation functions
  - `src/services/mcp-config.service.ts` — CRUD service + bulk import
  - `src/server/routes/mcp.ts` — REST API endpoints
  - `src/web/lib/api-mcp.ts` — Frontend API client
  - `src/web/components/settings/mcp-settings-section.tsx` — Settings UI
  - `src/web/components/settings/mcp-server-dialog.tsx` — Add/Edit dialog
- **Files Modified:**
  - `src/services/db.service.ts` — Schema v8 migration (mcp_servers table)
  - `src/server/index.ts` — Route registration
  - `src/providers/claude-agent-sdk.ts` — mcpServers + mcp__* allowedTools
  - `src/web/components/settings/settings-tab.tsx` — MCP category added

---

## [0.8.62] — 2026-03-26

### Added
- **Cmd+Shift+V shortcut** — Command palette entry for voice input
- **Voice input** — Web Speech API integration for chat

---

## [0.8.61] — 2026-03-26 (Beta)

### Added
- **Multi-Provider Architecture** — Generic AI provider system supporting Claude (SDK-based) and CLI-spawning providers
  - `AIProvider` interface with optional capability methods (`abortQuery?`, `getMessages?`, `listSessionsByDir?`)
  - `CliProvider` abstract base class for CLI-spawning providers (Cursor, Codex, Gemini)
  - `CursorCliProvider` implementation — spawns `cursor-agent` with NDJSON streaming
  - NDJSON line parser utility for TCP packet boundary handling
  - Cursor event mapper — normalizes Cursor NDJSON → standard ChatEvent union
  - Cursor history reader — loads sessions from `~/.cursor/chats/` SQLite DAG
  - Provider selector UI component — users can choose provider when creating chat
  - Async provider bootstrap — checks binary availability, registers only if available
  - Workspace trust auto-retry — detects trust prompts, retries with `--trust` flag
  - Process lifecycle management — SIGTERM → SIGKILL escalation, orphan cleanup

### Technical Details
- **Files Created:**
  - `src/utils/ndjson-line-parser.ts` — NDJSON streaming parser
  - `src/providers/cli-provider-base.ts` — Abstract CliProvider base class
  - `src/providers/cursor-cli/cursor-provider.ts` — CursorCliProvider
  - `src/providers/cursor-cli/cursor-event-mapper.ts` — Event mapping
  - `src/providers/cursor-cli/cursor-history.ts` — SQLite history reader
  - `src/web/components/chat/provider-selector.tsx` — Provider selection UI
  - `tests/unit/ndjson-line-parser.test.ts` — Parser tests
  - `tests/unit/cursor-event-mapper.test.ts` — Mapper tests
  - `tests/integration/cursor-provider.test.ts` — Integration tests
  - `tests/integration/chat-service-multi-provider.test.ts` — Service tests
- **Files Modified:**
  - `src/types/chat.ts` — Added optional capability methods to AIProvider, added `system` event type
  - `src/types/config.ts` — Added `"cli"` type, `cli_command` field to AIProviderConfig
  - `src/providers/registry.ts` — Added async `bootstrapProviders()` for conditional registration
  - `src/server/ws/chat.ts` — Removed `as any` casts, use optional chaining for capabilities
  - `src/services/chat.service.ts` — Use optional methods instead of duck-typing
  - `src/web/components/chat/session-picker.tsx` — Integrated provider selector
- **Breaking Changes:** None (backward compatible, all tests passing)
- **Architecture:** All phases complete (6/6), 555 tests passing

### Benefits
- Extensible foundation for Codex, Gemini, and future providers (~100-150 lines each)
- No more `as any` casts for provider methods — type-safe optional capability pattern
- CLI providers can override session history reading (e.g., Cursor SQLite DAG)
- Graceful degradation — missing CLI binary doesn't crash, logs info, skips provider

---

## [0.8.55] — 2026-03-26

### Added
- **Streaming Input Migration** — Persistent AsyncGenerator session model for chat
  - Provider maintains long-lived streaming input per session (not per message)
  - Follow-up messages push into existing generator instead of abort-and-replace
  - Single streaming loop decoupled from WebSocket message handler
  - Message priority support (`now`/`next`/`later`) for intelligent message ordering
  - Image attachment support in message sending
  - Session state persistence across FE disconnections (5-minute cleanup timeout)
  - Event buffering on reconnect: clients receive buffered turn events after reconnection
  - Phase transitions: `idle` → `initializing` → `connecting` → `thinking`/`streaming` → `idle`

### Technical Details
- **Provider Layer** (`src/providers/claude-agent-sdk.ts`): Maintains streaming session per sessionId
- **WebSocket Handler** (`src/server/ws/chat.ts`):
  - `runStreamLoop()` executes independently (detached from WS scope)
  - `activeSessions` map persists session state across FE disconnections
  - `startSessionConsumer()` pattern replaces per-message `runStreamLoop()` calls
  - Event buffering (turnEvents array, max 10k events) for reconnect sync
  - Per-client ping intervals (15s keepalive)
- **Types** (`src/types/api.ts`, `src/types/chat.ts`):
  - `ChatWsClientMessage` extended with `priority?: string` and optional `images`
  - `SessionPhase` = "initializing" | "connecting" | "thinking" | "streaming" | "idle"
  - `SessionEntry` tracks clients, abort handle, phase, pending approvals, buffered events
- **Frontend** (`src/web/components/chat/message-input.tsx`): PriorityToggle component (visible during streaming)
- **Benefits**:
  - No SDK subprocess restarts between messages (faster context preservation)
  - Tool approvals integrated into streaming (no query restart)
  - Message buffering prevents loss on FE reconnection
  - Cleaner architecture: BE owns Claude connection, FE disconnect ≠ abort

---

## [0.8.54] — 2026-03-25

### Added
- **Auto-upgrade feature** — Full implementation with supervisor, API, CLI, and UI components
  - Supervisor checks npm registry every 15 minutes for new versions
  - UI banner displays when new version available with one-click upgrade button
  - `ppm upgrade` CLI command for headless systems (with `--check` flag to preview)
  - Self-replace mechanism: supervisor spawns new supervisor from updated code, waits for health, then exits old
  - Self-replace eliminates OS autostart dependency — upgrade works even on headless/containerized systems
  - GET `/api/upgrade/status` returns current version, available version, install method (npm/bun/binary)
  - POST `/api/upgrade/apply` installs new version and signals supervisor for restart
  - Compiled binary installs gracefully rejected with clear message (future: GitHub releases support)
  - Config option: `autoUpgrade` setting (default: true) allows opt-out
  - All upgrade routes require authentication

### Technical Details
- **Services**: `src/services/upgrade.service.ts` handles version checking, semver comparison, install method detection, and installation
- **Supervisor**: Enhanced with 15-minute version check timer, available version tracking in status.json, SIGUSR1-triggered self-replace
- **API Routes**: `src/server/routes/upgrade.ts` with status and apply endpoints
- **CLI**: `src/cli/commands/upgrade.ts` with interactive upgrade and check-only mode
- **UI**: `src/web/components/layout/upgrade-banner.tsx` fixed-position banner with dismiss/upgrade buttons, polling every 60s
- Install method detection: `isCompiledBinary()` → binary, `process.execPath.includes("bun")` → bun, else → npm
- Semver comparison: lightweight string split (no external lib)
- Self-replace implementation: saves `process.argv`, spawns new supervisor, polls status.json for new PID, waits up to 30s

---

## [0.8.53] — 2026-03-18

### Fixed
- Keybindings: prevent command palette false trigger during IME composition

---

## [0.8.52] — 2026-03-15

### Added
- Process supervisor with auto-restart and tunnel resilience
  - Supervisor spawns and monitors server + tunnel processes
  - Auto-restart on crash with exponential backoff
  - Health checks every 30 seconds
  - Cloudflare tunnel auto-reconnect on failure
  - Status file (~/.ppm/status.json) tracks PID, port, URL

---

## [0.7.x — v0.8.52] — Prior Releases

Multi-account credential management, usage tracking, mobile UX optimization, Cloudflare tunnel integration, push notifications, terminal output streaming.

---

## Categories

- **Added** — New features
- **Fixed** — Bug fixes
- **Changed** — Behavioral changes
- **Deprecated** — Features marked for removal
- **Removed** — Removed features
- **Security** — Security vulnerability fixes

---

## Version Scheme

PPM uses semantic versioning: MAJOR.MINOR.PATCH

- MAJOR: Breaking changes to API/CLI/config format
- MINOR: New features (backward compatible)
- PATCH: Bug fixes and small improvements
