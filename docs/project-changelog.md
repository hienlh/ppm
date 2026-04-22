# PPM Project Changelog

All notable changes to PPM are documented here. Format follows [Keep a Changelog](https://keepachangelog.com/).

**Current Version:** v0.13.0

---

## [0.13.0] — 2026-04-21 — PPM Export Skill

### Added
- **`ppm export skill`** — self-describe for external AI. Installs a Claude Code skill at `~/.claude/skills/ppm/` (or `<project>/.claude/skills/ppm/` with `--scope project`, or custom `--output <dir>`) so external AI agents can autonomously control PPM via its CLI, HTTP API, and SQLite config DB. Skill package contains `SKILL.md` + `references/{cli-reference,http-api,db-schema,common-tasks}.md`.
- **Build-time generators** (`scripts/generate-ppm-skill.ts` + `scripts/lib/`): walk the Commander tree for CLI reference and regex-scan `src/server/index.ts` + `src/server/routes/*.ts` for HTTP API reference. Zero-side-effect static introspection.
- **Runtime generator** (`src/services/skill-export/generate-db-schema.ts`): opens `~/.ppm/ppm.db` readonly via `bun:sqlite` and emits markdown tables per PRAGMA table_info.
- **Re-install safety**: existing skill files renamed to `<name>.bak-<YYYYMMDDHHmm>` before overwrite; never destructive.
- **`buildProgram()` export** in `src/index.ts` — the assembled Commander tree without `.parse()`, enabling build-time doc tools.

### Changed
- `scripts/generate-ppm-guide.ts` → `scripts/generate-ppm-skill.ts`; `assets/skills/ppm-guide/` → `assets/skills/ppm/`; `generate:guide` npm script → `generate:skill`.

---

## [Unreleased] — Lazy-Load File Tree + Palette Index, Session Tagging, File Compare, Jira Debug Session Redesign, Frontend Memory Optimization, Git-Graph Enhancements

### Added
- **File Compare** — Side-by-side diff viewer for comparing two files or file versions
  - Four triggers: (1) tab right-click "Select for Compare" / "Compare with Selected", (2) file tree right-click (same), (3) command palette "Compare Files...", (4) keyboard shortcut `Mod+Alt+D`
  - Reuses existing `DiffViewer` component + `git-diff` tab type + `/files/compare` API — no new backend endpoints
  - Supports dirty buffer content: unsaved editor changes captured at select-time
  - New zustand store `useCompareStore` persists selection across reload (strips dirty content >500KB to keep localStorage fast)
  - Auto-clears selection on project switch via store subscription
  - New keybinding action `compare-files` with customizable default `Mod+Alt+D` in Settings > Keybindings

- **Lazy-Load File Tree + Palette Index** — Instant project opening on large codebases
  - Backend: `GET /api/project/:name/files/list?path=<rel>` for 1-level directory listing with gitignore decoration
  - Backend: `GET /api/project/:name/files/index` for flat full-project index (cached, watcher-invalidated)
  - Filter model: hardcoded defaults ⊂ global config ⊂ per-project override (VS Code style)
  - Settings API: `GET/PATCH /api/settings/files` for global `files.exclude` / `files.searchExclude` / `files.useIgnoreFiles`
  - Project settings: `GET/PATCH /api/project/:name/settings` for per-project override (schema v21: projects.settings JSON)
  - Frontend: File store refactored to lazy-load with AbortController pool; tree auto-expands root only, children load on-demand
  - Command palette + chat file-picker switched from tree-flattening to `fileIndex` for instant search
  - New Settings section: **Files & Search** — global + active-project-scoped settings, glob list editor, `useIgnoreFiles` toggle
  - Gitignored files decorated grey in tree (when `useIgnoreFiles=true`)
  - `/api/project/:name/files/tree` marked @deprecated (still functional)

- **Session Tagging** — Per-project tags for organizing chat sessions
  - Database: schema v20 migration creates `project_tags` table with id, project_path, name, color, sort_order; adds `tag_id` FK to `session_metadata`
  - Tag service: `tag.service.ts` with CRUD helpers (create, read, update, delete, bulk assign), session tag enrichment, tag counting
  - API routes: `tag-routes.ts` with GET/POST/PATCH/DELETE endpoints for tag CRUD, default tag management
  - Session tag assignment: PATCH/DELETE endpoints on chat routes, bulk assign endpoint for multi-session tagging
  - Auto-tag new sessions: New sessions auto-assigned to project's default tag if configured
  - UI: Color dots on session rows (8x8px circles showing tag color), tag filter chip bar above session list with count badges
  - Filter bar: "All" chip plus one per tag, client-side filtering integrated with search (AND logic)
  - Tag management: Settings panel (tag-settings-section.tsx) with create/edit/delete/reorder UI, drag-to-reorder on desktop, up/down arrows on mobile
  - Context menu: Right-click session → "Set Tag" submenu with tag list, current tag has checkmark, "Remove tag" option
  - Keyboard shortcuts: Keys 1-4 quickly assign top 4 project tags when history panel open and session focused
  - Bulk operations: Select multiple sessions → floating action bar with tag assignment and bulk endpoint
  - Responsive: Mobile-first design (44x44px touch targets), horizontal chip scroll, bottom sheet context menu, touch-friendly tag management

### Technical Details
- **Database:**
  - Migration v20: Creates `project_tags(id, project_path, name, color, sort_order, created_at)` with UNIQUE(project_path, name)
  - Alters `session_metadata` to add `tag_id INTEGER REFERENCES project_tags(id) ON DELETE SET NULL`
  - Alters `projects` to add `default_tag_id INTEGER REFERENCES project_tags(id) ON DELETE SET NULL`
  - Seeds 4 default tags per project on migration and on new project creation
- **Files Created:**
  - `src/services/tag.service.ts` — Tag CRUD helpers, session tag enrichment, bulk operations (~150 lines)
  - `src/server/routes/tag-routes.ts` — Tag API endpoints (GET/POST/PATCH/DELETE project tags, default tag) (~100 lines)
  - `src/web/components/settings/tag-settings-section.tsx` — Tag management UI with CRUD, reorder, default toggle (~170 lines)
  - `src/web/components/chat/session-context-menu.tsx` — Extracted context menu content (optional, ~80 lines)
  - `src/web/components/chat/session-bulk-actions.tsx` — Bulk action bar (optional, ~60 lines)
- **Files Modified:**
  - `src/services/db.service.ts` — Schema v20 migration, bump CURRENT_SCHEMA_VERSION
  - `src/services/project.service.ts` — Call seedDefaultTags() on project add
  - `src/types/chat.ts` — Add ProjectTag interface, tag field to SessionInfo
  - `src/server/routes/chat.ts` — Session tag endpoints (PATCH/DELETE single, PATCH bulk), tag enrichment in GET /sessions, auto-tag on POST /sessions
  - `src/web/components/chat/chat-history-bar.tsx` — Tag filter chip bar, color dots per session, context menu wrapper, keyboard shortcuts, bulk select mode
  - `src/web/components/chat/session-picker.tsx` — Color dots per session
  - `src/web/components/chat/chat-welcome.tsx` — Color dots per recent session
  - `src/web/components/settings/settings-tab.tsx` — Register TagSettingsSection
- **Type Changes:**
  - New: `ProjectTag` = { id, projectPath, name, color, sortOrder }
  - New: `ChatWsServerMessage` variants for tag updates (future)
  - Updated: `SessionInfo` includes `tag?: { id, name, color } | null`
- **API Changes:**
  - GET `/projects/:path/tags` → `{ tags: ProjectTag[], counts: Record<number, number> }`
  - POST `/projects/:path/tags` → create tag
  - PATCH `/projects/:path/tags/:id` → update tag (name, color, sortOrder)
  - DELETE `/projects/:path/tags/:id` → delete tag
  - PATCH `/projects/:path/default-tag` → set project default tag
  - PATCH `/chat/sessions/:id/tag` → assign tag to session
  - DELETE `/chat/sessions/:id/tag` → remove tag from session
  - PATCH `/chat/sessions/bulk-tag` → bulk assign tag to multiple sessions (limit 100 per request)
- **Breaking Changes:** None (additive feature, backward compatible)
- **Test Coverage:** Integration tests for tag CRUD, session enrichment, API validation (100+ tests)

---

## [0.11.11] — 2026-04-19

### Added
- **Real-Time Bash Output Streaming** — Stream bash tool output in chat UI while commands run
  - Backend service `BashOutputSpy` monitors bash process via `/proc/PID/fd/1` (Linux/WSL2) and `lsof` (macOS); graceful no-op on native Windows
  - Cross-platform PID discovery using `pgrep -fn` (Linux + macOS)
  - File polling at 100ms intervals captures output lines as they're written
  - New WebSocket message type: `bash_output` with `{ toolUseId, content, lineCount }`
  - Frontend hook `useChat` buffers partial output per toolUseId in ref (no excessive re-renders)
  - ToolCard component auto-expands when streaming and displays line count indicator with animated spinner
  - StreamingBashOutput component with auto-scroll-to-bottom (respects user scroll position)
  - Display truncated to last 200 lines for performance; 500KB frontend memory cap
  - Partial output cleared on `tool_result` or session cleanup; no buffering in reconnect history

### Technical Details
- **Files Created:**
  - `src/services/bash-output-spy.ts` — Cross-platform process monitoring with line-buffering
- **Files Modified:**
  - `src/types/api.ts` — Added `bash_output` to `ChatWsServerMessage` union
  - `src/server/ws/chat.ts` — Wire spy start/stop into tool_use/tool_result event loop
  - `src/web/hooks/use-chat.ts` — Buffer partial output per toolUseId, expose via ref
  - `src/web/components/chat/message-list.tsx` — Thread bashPartialOutput to ToolCard
  - `src/web/components/chat/tool-cards.tsx` — Render StreamingBashOutput component, auto-expand on streaming
- **Type Changes:**
  - New: `ChatWsServerMessage` variant = `{ type: "bash_output"; toolUseId: string; content: string; lineCount: number }`
  - Hook return type extended with `bashPartialOutput: RefObject<Map<string, { content: string; lineCount: number }>>`
- **Breaking Changes:** None (additive feature, backward compatible)

---

## [Unreleased] — Jira Debug Session Redesign + Frontend Memory Optimization + Git-Graph Stash Management, Rebase, Conflict Resolution + Worktree CRUD

### Added
- **Jira Debug Session Redesign** — Direct Claude session debug replacing bot_task flow with concurrency queue
  - Replaced bot_task-based debug with direct `chatService.sendMessage()` calls (simpler, faster)
  - Concurrency queue: max 2 concurrent sessions globally, max 1 per project (prevents resource exhaustion)
  - Manual "Start Debug" button with editable prompt in results panel (override watcher template)
  - Unread tracking: `read_at` column on `jira_watch_results`, unread badge count in UI
  - WS toast notifications on debug completion (`jira:debug_complete` event)
  - Prompt override support for custom debug instructions per result
  - Result status flow: pending → queued → running → done/failed
  - Timeout protection: 10-minute abort-on-timeout with graceful cleanup
  - AI summary capture: last assistant text (max 500 chars) stored in result
  - Database schema v19: added `read_at` (nullable timestamp), `triggered_by` ("auto"|"manual")
  - New service: `JiraDebugSessionService` with queue management + concurrency limits
  - New component: `JiraDebugPromptDialog` for manual prompt override UI
  - API: `POST /api/jira/results/:id/debug` to trigger debug (with optional prompt)

- **Jira Watcher Auto-Debug (v0.9.86+)** — Poll Jira Cloud per-project, auto-debug matched tickets
  - Jira Cloud REST API integration (search, get issue, transitions, metadata discovery)
  - Per-project config (base URL, email, AES-256 token encryption)
  - JQL-based watchers with two modes: debug (queue session) and notify-only (Telegram notification)
  - Configurable poll intervals (30s–60m per watcher, interval clamping)
  - Rate limit aware (tracks Jira API quota, auto-backoff 429 responses)
  - Result tracking (pending/queued/running/done/failed status, AI summary persistence)
  - Prompt templating ({issue_key}, {summary}, {description}, {status}, {priority} substitution)
  - Soft deletes (preserve result history, don't lose tracking)
  - Frontend filter builder UI (projects, issue types, priorities, statuses, custom JQL)
  - CLI commands: `ppm jira config {set,show,remove,test}`, `ppm jira watch {add,list,enable,disable,remove,test,pull}`
  - API routes: /api/jira/config/*, /api/jira/{watchers,results,search,ticket,metadata}
  - 3 SQLite tables (v18): jira_config, jira_watchers, jira_watch_results
  - 44 tests (integration + unit, JQL builder, result sync, credential encryption, rate limiting)

- **Frontend Memory & Performance Optimizations** — Reduce re-renders, lazy-load heavy components, code splitting
  - **useShallow pattern:** All destructured Zustand store calls now use `useShallow` (36 usage sites) to prevent re-renders on object mutations
  - **React.memo wrapping:** 10 heavy components memoized (CodeEditor, MessageBubble, ProjectBar, ProjectAvatar, TerminalTab, PanelLayout, Sidebar, StatusBar, StatusBarEntry, TabBar, TreeNode)
  - **Lazy loading:** MarkdownRenderer lazy-loaded from 3 sites, CodeMirror on-demand in postgres-viewer
  - **Dynamic import:** Mermaid loaded on-demand in markdown-code-block (only when needed)
  - **Code splitting:** 5 vendor chunks in vite.config.ts (monaco, mermaid, xterm, markdown, ui libraries) for better caching
  - **Chat pagination:** Message history limited to 50 per page with load-more button
  - **Message cap:** Team activity capped at 500 messages to prevent unbounded growth

### Added (Git-Graph)
- **Git Stash Management** — Toolbar popover for interactive stash operations
  - List all stashes with index, hash (abbreviated), and message
  - Apply/Pop/Drop actions per stash via context menu or action buttons
  - "Stash Changes" button in main toolbar to stash uncommitted work
  - Stash list persisted in RepoInfo and refreshed on uncommitted status updates
  - Keyboard shortcuts for quick access to stash operations

- **Interactive Rebase** — Branch context menu + commit history actions
  - "Rebase current branch onto..." option in commit context menu
  - Confirmation dialog shows branch selection and target commit
  - Rebase state detection and progress tracking (e.g., "3/5" for interactive rebase)
  - Continue/Skip/Abort controls in merge state banner during rebase

- **Merge/Rebase/Cherry-Pick Conflict Detection** — Visual conflict indicators
  - Detects merge state from .git sentinel files (MERGE_HEAD, REBASE_MERGE, CHERRY_PICK_HEAD)
  - Parses git status UU/AA/DD/AU/UA/DU/UD codes for unmerged entries
  - Conflicted files displayed in "Conflicts" section in uncommitted status
  - Conflict state banner shows merge state type + progress + action buttons (Continue/Skip/Abort)
  - Auto-detects merge state only when conflicts exist (performance optimization)

- **Inline Conflict Resolution Editor** — New conflict-editor tab type with Monaco
  - Dedicated `conflict-editor` tab type for visual conflict resolution
  - Monaco-based editor with syntax highlighting per file type (JS/TS/Python/etc.)
  - Conflict regions visually highlighted: green for current, blue for incoming, gray for markers
  - Accept buttons: Accept Current / Accept Incoming / Accept Both (with proper merging)
  - Conflict counter in header: "N conflicts remaining" → "All conflicts resolved" on completion
  - Automatic file save after each resolution; conflict count updates in real-time
  - Parses 3-way conflict markers (<<<<<<, =======, >>>>>>>) and extracts labels (HEAD/branch names)

- **Worktree Management** — Full CRUD with project integration
  - Worktree toolbar popover listing all worktrees (with path, branch, HEAD status)
  - Create worktree from commit context menu ("Create Worktree Here...")
  - Remove, prune, and auto-lock operations per worktree
  - Current worktree highlighted with badge and active background
  - Auto-add unregistered worktrees as projects via confirmation dialog
  - Branch-already-exists dialog offers force-replace option for branch conflicts
  - Project switcher integration: switch to worktree branches directly

- **Bundled Extensions Support** — Auto-discover extensions from packages/ext-* directories
  - PPM discovers bundled extensions (e.g., ext-git-graph) without manual installation
  - Bundled extensions available out-of-the-box with all PPM instances
  - `ppm ext list` shows "Source" column (bundled/user) for transparency
  - Bundled extension removal protection: prevents accidental deletion, suggests `ppm ext disable` instead
  - User-installed extensions override bundled with same ID (user takes precedence)
  - Extension paths tracked separately for bundled vs node_modules locations

- **Git-Graph UI Improvements** — 7 UX refinements + comprehensive git workflow
  - Branch context menu: right-click for checkout/merge/rebase/delete/create operations
  - Double-click checkout: branch labels double-click to switch branches instantly
  - Toast notifications: replaced blocked alert() with inline webview toast elements
  - SVG icons: replaced Unicode symbols (↻⬇🔍⚙🌲📁) with inline Lucide SVG icons
  - Auto-fetch enhancement: added 10-second interval option to dropdown
  - Uncommitted polling: 5-second status refresh to detect working tree changes
  - Interactive UI elements: resizable graph column, branch filter dropdown, tree/list view toggle
  - Git actions: stage/unstage files, commit from webview, stash/reset/clean operations
  - Path traversal validation for security (assertSafePath in RPC handlers)
  - Fallback guards for all tab type handling (unknown tab types safely ignored)

- **Extension Error Reporting & Logging** — Silent failure debugging & user feedback
  - Activation error tracking: Map stores `extId → error message` in ExtensionService
  - Error toasts on command failure: "Extension command failed: {error}" displays in UI
  - Timeout UX improved: Fallback UI shows activation error + "Retry" button for quick recovery
  - Breadcrumb logging with tags for debugging: `[ExtService]`, `[ExtHost]`, `[ExtWS]`, `[ext-git-graph]`
  - Console logs track: activation start/success, command routing, failures with context
  - Activation errors included in `contributions:update` message sent to browser on WS connect

- **Faithful SVG Graph Rendering** — Port of vscode-git-graph algorithm with deterministic layout
  - Single SVG model with continuous branch paths using Bézier curves
  - Deterministic lane assignment algorithm with greedy color reuse
  - Proper HEAD/stash node rendering (hollow circle for HEAD, nested circles for stash)
  - Shadow lines for visual depth and branch continuity
  - Mobile SVG alignment: gridY matches 44px CSS row height
  - XSS security fix: escHtml applied to parent hashes and file status in detail panel
  - Regex ordering fix in formatCommitMessage for proper URL/mention detection
  - Removed dot alignment bug that forced rows to 29px

### Technical Details

**Stash/Rebase/Conflict/Worktree Implementation:**
- **Files Created:**
  - `src/web/components/editor/conflict-editor.tsx` — Monaco-based conflict resolution editor with visual highlighting, accept buttons, real-time conflict counter, auto-save on resolution

- **Files Modified:**
  - `packages/ext-git-graph/src/extension.ts` — Added stash parsing, merge state detection (merge/rebase/cherry-pick), conflict file opening, worktree CRUD operations, branch context menu rebase action
  - `packages/ext-git-graph/src/types.ts` — Added Stash interface, MergeState interface (type, progress, message), FileChange status "U" for unmerged, Worktree interface, updated UncommittedData with conflicted field
  - `packages/ext-git-graph/src/webview-html.ts` — Added stash popover UI, rebase context menu item, conflict section in uncommitted panel, merge state banner with Continue/Skip/Abort, worktree popover with CRUD UI
  - `src/web/stores/tab-store.ts` — Added "conflict-editor" as valid TabType
  - `src/web/stores/panel-utils.ts` — Added conflict-editor case to deriveTabId() for metadata-driven tab ID generation
  - `src/web/components/layout/editor-panel.tsx` — Lazy-imported ConflictEditor component with fallback
  - `src/web/components/layout/tab-content.tsx` — Lazy-imported ConflictEditor component with fallback
  - `src/web/components/layout/mobile-nav.tsx` — Added conflict-editor icon (conflict/warning icon)
  - `src/web/components/layout/tab-bar.tsx` — Added conflict-editor icon (conflict/warning icon)

- **Services Modified:**
  - `src/services/extension-manifest.ts` — Added discoverBundledManifests() to scan packages/ext-* dirs
  - `src/services/extension.service.ts` — Added extensionPaths Map, bundledIds Set, isBundled() method; updated discover()/activate()/remove() to handle bundled extensions
  - `src/cli/commands/ext-cmd.ts` — Added "Source" column to `ppm ext list`, calls discover() to populate bundled info
  - `src/services/extension-rpc-handlers.ts` — Allow git operations in all registered project paths (not just CWD), improved path validation
  - `src/services/extension-host-worker.ts` — Enhanced error logging, localHandlers check, disposed flag fix for polling race conditions

- **Type Changes:**
  - New: `Stash` = { index, hash, message }
  - New: `MergeState` = { type: "merge" | "rebase" | "cherry-pick", progress?, message? }
  - New: `Worktree` = { path, branch, head, isMain, isDetached, locked, lockReason?, prunable }
  - Updated: `FileChange.status` now includes "U" for unmerged/conflicted entries (was "A" | "M" | "D" | "R" | "C")
  - Updated: `UncommittedData` now includes `conflicted: FileChange[]` and optional `mergeState: MergeState`
  - Updated: `RepoInfo` now includes `stashes: Stash[]` and `currentBranch: string`
  - Updated: `TabType` now includes "conflict-editor"

- **Git State Detection:**
  - Merge state determined by .git sentinel files: MERGE_HEAD (merge), rebase-merge/ (interactive rebase), CHERRY_PICK_HEAD (cherry-pick)
  - Progress tracked: "3/5" format from rebase-merge/msgnum and rebase-merge/end
  - Conflict detection: UU/AA/DD/AU/UA/DU/UD git status codes parsed as unmerged entries
  - Only detects merge state when conflicts exist (perf optimization)

- **Conflict Resolution Flow:**
  - User clicks conflicted file → opens conflict-editor tab
  - Component parses conflict markers (<<<<<<, =======, >>>>>>>) from file content
  - Displays visual highlighting + Accept buttons above each conflict region
  - Resolution applies edit via Monaco, saves file automatically, updates conflict counter
  - Conflict count reflects real-time resolution progress

- **Security:** Path validation ensures extensions can only operate on registered project paths
- **Breaking Changes:** None (backward compatible)
- **Test Coverage:** All changes maintain test suite passing

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
