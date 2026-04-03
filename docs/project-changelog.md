# PPM Project Changelog

All notable changes to PPM are documented here. Format follows [Keep a Changelog](https://keepachangelog.com/).

**Current Version:** v0.9.0

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
