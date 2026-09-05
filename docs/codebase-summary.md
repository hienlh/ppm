# PPM Codebase Summary

**Last Updated:** 2026-09-05
**Version:** 0.18.x
**Repository:** PPM (Project & Process Manager) — Multi-provider web IDE/project manager with Claude Agent SDK

**Core Statistics:**
- **~1,300 tracked files** — 897 under `src/`, 379 under `tests/`, 24 under `packages/`
- **~2,600 passing tests** (run in Docker; the host Bun build segfaults on the suite)
- **Tech Stack:** Bun (runtime), Hono (HTTP), React (UI), Claude Agent SDK + Codex + Cursor (AI)

> Subsystem deep dives (multi-provider, extensions, ext-git-graph, slash-discovery) live in
> [codebase-subsystems.md](codebase-subsystems.md).

---

## Directory Structure

```
src/
├── cli/
│   ├── commands/                # 16 CLI command groups (start, stop, init, config, chat, db, git, ext, jira, etc.)
│   │   ├── ext-cmd.ts           # Extension CLI (install/remove/list/enable/disable/dev)
│   │   ├── jira-cmd.ts          # Jira config commands (set, show, remove, test)
│   │   └── jira-watcher-cmd.ts  # Jira watcher commands (add, list, enable, disable, remove, test, pull)
│   └── utils/
│       └── project-resolver.ts  # Resolve project name -> path
├── server/
│   ├── index.ts                 # Hono server setup, Bun.serve, WebSocket upgrade
│   ├── middleware/
│   │   └── auth.ts              # Token validation middleware
│   ├── routes/
│   │   ├── settings.ts          # GET/PUT /api/settings/ai, GET /api/settings/ai/providers/:id/models
│   │   ├── chat.ts              # Sessions, messages, GET /chat/providers/:providerId/models
│   │   ├── projects.ts          # Project CRUD, reorder, color
│   │   ├── accounts.ts          # Account management (multi-account support)
│   │   ├── database.ts          # DB connection CRUD, schema management
│   │   ├── git.ts               # Git operations (status, commit, log, graph)
│   │   ├── files.ts             # File operations (read, write, tree)
│   │   ├── mcp.ts               # MCP server CRUD + import (GET, POST, PUT, DELETE)
│   │   ├── extensions.ts        # Extension install/remove/list/enable/disable, contributions
│   │   ├── upgrade.ts           # Version checking, upgrade
│   │   ├── jira.ts              # Jira routes barrel (config, watchers)
│   │   ├── jira-config-routes.ts # Jira config API (CRUD, test connection)
│   │   ├── jira-watcher-routes.ts # Jira watcher API (CRUD, poll, results, search, metadata)
│   │   └── static.ts            # Serve frontend (dist/web)
│   ├── helpers/
│   │   └── resolve-project.ts   # Resolve project from request params
│   └── ws/
│       ├── chat.ts              # WebSocket chat streaming
│       └── terminal.ts          # WebSocket terminal I/O
├── providers/                   # AI Provider adapters
│   ├── provider.interface.ts    # AIProvider interface (ADDED: listModels?())
│   ├── claude-agent-sdk.ts      # Primary provider (listModels: hardcoded 2 models)
│   ├── cursor-cli/
│   │   └── cursor-provider.ts   # CLI-based provider (listModels: subprocess with TTL cache)
│   ├── codex-app-server/        # Codex (OpenAI) provider — JSON-RPC over `codex app-server` stdio
│   │   ├── codex-provider.ts        # AIProvider impl: per-session live map, multi-turn, lifecycle
│   │   ├── codex-jsonrpc-client.ts  # NDJSON JSON-RPC client (id-safety, env allowlist, scoped spawn)
│   │   ├── codex-protocol.ts        # Hand-authored protocol subset (no vendored bindings)
│   │   ├── codex-permission-map.ts  # permissionMode → {sandbox, approvalPolicy}
│   │   ├── codex-event-mapper.ts    # notification → ChatEvent[] (usage cut)
│   │   ├── codex-approval-decision.ts # pure per-method approval decisions (dormant in MVP)
│   │   ├── codex-history.ts         # rollout JSONL parser + fail-closed cwd filter
│   │   ├── codex-model-parser.ts    # model/list → ModelOption[]
│   │   └── codex-redact.ts          # shared redact/truncate for logs + tool output
│   ├── cli-provider-base.ts     # Abstract base for CLI providers
│   ├── mock-provider.ts         # Test provider
│   └── registry.ts              # Provider routing (list() vs listAll())
├── services/                    # Business logic (30+ files)
│   ├── chat.service.ts          # Session/message streaming
│   ├── task-status-aggregator.ts # Rebuild Claude Task* state from session JSONL (TaskCreate/TaskUpdate/TaskStop tracking)
│   ├── config.service.ts        # Config loading/persistence
│   ├── db.service.ts            # SQLite CRUD (schema migrations, extension_storage)
│   ├── file.service.ts          # File operations
│   ├── git.service.ts           # Git commands
│   ├── terminal.service.ts      # PTY management
│   ├── avatar-storage.service.ts # Content-addressed avatar storage (~/.ppm/avatars/<sha256>.webp)
│   ├── account.service.ts       # Account CRUD & encryption
│   ├── upgrade.service.ts       # Version checking, installation
│   ├── mcp-config.service.ts    # MCP server CRUD (list, get, set, remove, import)
│   ├── extension.service.ts     # Extension lifecycle, activation, state management (bundled + user discovery)
│   ├── extension-installer.ts   # npm install, symlink, removal
│   ├── extension-manifest.ts    # Parse manifests + bundled discovery from packages/ext-*
│   ├── extension-rpc.ts         # RPC channel (request/response/events)
│   ├── extension-host-worker.ts # Worker-side extension loading
│   ├── contribution-registry.ts # Central registry for commands, views, config
│   ├── slash-discovery/         # Modular slash command discovery engine
│   │   ├── types.ts             # DefinitionSource, SkillRoot, SlashItem, DiscoveryResult types
│   │   ├── definition-source.ts # Priority ranking + scope mapping
│   │   ├── discover-skill-roots.ts # Ancestor walking, env vars, user-global, bundled roots
│   │   ├── skill-loader.ts      # SKILL.md + loose .md + commands parsing
│   │   ├── resolve-overrides.ts # Shadowing resolution
│   │   ├── fuzzy-search.ts      # Levenshtein-based fuzzy matching
│   │   ├── builtin-commands.ts  # Built-in command registry (9 commands)
│   │   ├── builtin-handlers.ts  # PPM-executed handlers (/skills, /version)
│   │   └── index.ts             # Main pipeline + exports
│   ├── ppmbot/                  # PPMBot coordinator service layer
│   │   ├── ppmbot-service.ts    # Main orchestrator (poller lifecycle, message routing)
│   │   ├── ppmbot-session.ts    # Coordinator session manager, project resolver
│   │   ├── ppmbot-telegram.ts   # Telegram API (long-polling, send, edit, typing)
│   │   ├── ppmbot-memory.ts     # SQLite memory (project memories, context recall)
│   │   ├── ppmbot-delegation.ts # Task execution (creates isolated session per project)
│   │   ├── ppmbot-formatter.ts  # Markdown → Telegram HTML, chunking
│   │   └── ppmbot-streamer.ts   # ChatEvent → progressive message edits
│   ├── group-chat/              # Native multi-agent group-chat engine
│   │   ├── group-chat.store.ts  # CRUD + windowed message-bus reads (schema v35)
│   │   ├── turn-engine.ts       # Provider-agnostic shared-channel turn loop (DI)
│   │   ├── context-window.ts    # Windowing + naive rolling summary (no API)
│   │   ├── agent-runner.ts      # Member turn (summary from full text) + parallel dispatch
│   │   ├── transcript-archive.ts# Option A+ archive-and-delete of member JSONLs
│   │   └── group-chat.service.ts# Live runtime: detached loop, abort, WS broadcast, stop/resume
│   ├── clawbot/                 # Legacy: Telegram bot service layer (deprecated v0.9.11)
│   │   ├── clawbot.service.ts   # (Original direct-chat model, replaced by coordinator)
│   │   └── ... (other files)
│   ├── query-audit/             # Database query audit log (separate SQLite db)
│   │   ├── query-audit-db.ts    # Connection + schema initialization
│   │   ├── query-audit.service.ts # Insert/list/count queries; detectOperation()
│   │   └── result-truncate.ts   # Truncate result rows (first 5 + last 5); cap sql/params at 16KB
│   ├── database/
│   │   ├── adapter-registry.ts  # SQLite/Postgres adapter registry
│   │   ├── sqlite-adapter.ts
│   │   ├── postgres-adapter.ts
│   │   └── readonly-check.ts    # CTE-safe readonly validation
│   ├── jira-api-client.ts       # Jira Cloud REST API v3 (search, getIssue, transitions)
│   ├── jira-config.service.ts   # Jira config CRUD, AES-256 token encryption
│   ├── jira-watcher-db.service.ts # Watchers + results table queries
│   ├── jira-watcher.service.ts  # Poll orchestrator, timer management, result sync
│   └── ... (16+ other services)
├── lib/
│   ├── account-crypto.ts        # AES-256 encryption
│   └── network-utils.ts
├── types/
│   ├── chat.ts                  # Session, Message, ChatEvent, ModelOption, AIProvider
│   ├── api.ts                   # ApiResponse envelope
│   ├── config.ts
│   ├── database.ts
│   ├── git.ts
│   ├── mcp.ts                   # McpServerConfig, McpTransportType, validation
│   ├── extension.ts             # ExtensionManifest, ExtensionInfo, RpcMessage, ExtensionContext
│   ├── ppmbot.ts                # BotTask, TelegramUpdate, PPMBotCommand (coordinator types)
│   ├── jira.ts                  # JiraConfig, JiraWatcher, JiraWatchResult, JiraIssue, JiraCredentials
│   ├── project.ts
│   └── terminal.ts
└── web/                         # React frontend (Vite + React 18)
    ├── app.tsx                  # Root component
    ├── stores/                  # Zustand state (7 stores)
    │   └── jira-store.ts         # ADDED: Jira config, watchers, results, filters state
    ├── hooks/                   # Custom hooks (9 hooks)
    ├── components/
    │   ├── chat/
    │   │   ├── chat-tab.tsx
    │   │   ├── message-list.tsx
    │   │   ├── message-input.tsx
    │   │   ├── provider-selector.tsx
    │   │   ├── chat-history-bar.tsx # ADDED: Provider badges, provider-aware usage
    │   │   └── ... (6 other chat components)
    │   ├── settings/
    │   │   ├── ai-settings-section.tsx # UPDATED: Per-provider tabs, dynamic model dropdowns
    │   │   ├── mcp-settings-section.tsx # ADDED: MCP servers tab (list, add, edit, delete)
    │   │   ├── mcp-server-dialog.tsx    # ADDED: Add/Edit MCP server dialog
    │   │   ├── settings-tab.tsx # UPDATED: Added Jira Watcher tab
    │   │   └── jira/                  # ADDED: Jira Watcher components
    │   │       ├── jira-settings-tab.tsx
    │   │       ├── jira-config-form.tsx
    │   │       ├── jira-filter-builder.tsx
    │   │       ├── jira-watcher-list.tsx
    │   │       ├── jira-results-panel.tsx
    │   │       └── jira-ticket-detail.tsx
    │   ├── database/
    │   ├── editor/
    │   ├── explorer/                # Project file tree (sidebar)
    │   ├── floating-window/         # Desktop window manager — drag/8-handle resize, z-band 30..38, persisted rects; one skinned chrome + frame-owned PiP for every window kind
    │   │   ├── window-skin-chrome.tsx       # Titlebar every window kind renders — resolves the active OS skin and delegates to it
    │   │   ├── use-window-body-element.ts   # Body element every window portals content into; publishes/detaches its PiP slot
    │   │   ├── window-pip-registry.ts       # Per-window PiP slot/handle registry — also read by TabPool for a detached tab's portal target
    │   │   ├── window-pip-placeholder.tsx   # "Playing in picture-in-picture" / "Bring back" shown by the frame while a window's body is popped out
    │   │   ├── tab-host-window-content.tsx  # tab-host window body — publishes the slot TabPool reparents a detached tab into
    │   │   └── pip/                          # Document Picture-in-Picture host (pip-host, pip-style-copy, pip-key-forward, pip-resize-signal, pip-geometry, pip-support, pip-focus-target, pip-caption-button — the shared titlebar PiP button every skin renders)
    │   ├── os-explorer/              # ADDED: OS File Explorer window body
    │   │   ├── views/                # List / Icons (thumbnails) / Column (Miller) view components
    │   │   ├── skins/                 # Windows 11 + macOS Finder chrome (worn by every floating-window kind, not just explorer), folder icons, [data-skin] CSS vars
    │   │   ├── mobile/                # Full-screen bottom-sheet variant (top bar, places strip, bottom toolbar)
    │   │   ├── dnd/                   # Entry drag-and-drop (explorer ↔ explorer ↔ project tree)
    │   │   └── actions/                # Disk mutations (cut/copy/paste/rename/trash/delete), collision prompt
    │   ├── git/
    │   ├── layout/
    │   ├── terminal/
    │   └── ui/
    └── lib/
│       │   ├── use-url-sync.ts      # Sync browser URL with active project/tab state
│       │   ├── use-tab-drag.ts      # Tab drag-and-drop logic
│       │   ├── use-global-keybindings.ts # Global shortcuts (Shift+Shift palette, Alt+[/] tab cycling)
│       │   ├── use-health-check.ts  # Detect server crashes/restarts via health endpoint
│       │   ├── use-usage.ts         # Fetch token usage from backend
│       │   └── use-push-notification.ts # Web push notifications via Service Worker
│       ├── lib/                     # Utilities (12 files)
│       │   ├── api-client.ts        # Fetch wrapper with auth token, envelope unwrapping
│       │   ├── api-settings.ts      # AI settings API client (GET/PUT /api/settings/ai)
│       │   ├── api-mcp.ts           # ADDED: MCP settings API client (CRUD + import)
│       │   ├── resize-image.ts      # Canvas center-crop to 128×128 webp 0.85 quality with type validation
│       │   ├── ws-client.ts         # WebSocket with exponential backoff + Cloudflare handshake
│       │   ├── file-support.ts      # File type detection (language, icons, preview)
│       │   ├── project-avatar.ts    # Smart project initials (collision resolution)
│       │   ├── project-palette.ts   # 12-color palette for project avatars
│       │   ├── use-monaco-theme.ts  # Sync Monaco Editor theme with app theme
│       │   ├── color-utils.ts       # WCAG color contrast helper
│       │   ├── csv-parser.ts        # CSV state-machine parser/serializer
│       │   └── utils.ts             # Helpers (cn, randomId, basename, etc.)
│       ├── styles/
│       │   └── globals.css          # Tailwind directives, custom CSS
│       └── components/              # React components (organized by feature)
│           ├── auth/                # Login screen (88 LOC)
│           ├── chat/                # Chat UI (13 files)
│           │   ├── chat-tab.tsx     # Main chat container, session picker, streaming
│           │   ├── chat-history-bar.tsx # Session history sidebar, inline rename
│           │   ├── chat-history-panel.tsx # Full session list modal
│           │   ├── message-list.tsx # Scrolling message view with tool results
│           │   ├── chat-scroll-nav.tsx # Collapsed puck to jump between your messages
│           │   ├── message-input.tsx # Textarea with attachments, @ slash commands
│           │   ├── session-picker.tsx # Dropdown to select/create session
│           │   ├── file-picker.tsx  # Filterable file tree picker
│           │   ├── slash-command-picker.tsx # Command palette for / prefix
│           │   ├── tool-cards.tsx   # Render SDK tool results/approvals
│           │   ├── usage-badge.tsx  # Token usage display
│           │   ├── attachment-chips.tsx # Display attached files
│           │   └── chat-placeholder.tsx # Empty state
│           ├── editor/              # Code editor (900+ LOC, 7 files)
│           │   ├── code-editor.tsx  # Monaco Editor integration (@monaco-editor/react, v2.0+)
│           │   ├── diff-viewer.tsx  # Monaco diff viewer for git diffs (v2.0+)
│           │   ├── conflict-editor.tsx # Inline conflict resolution (3-way markers, visual highlighting, v0.9.86+)
│           │   ├── editor-breadcrumb.tsx # VSCode-style breadcrumb with nested dropdown
│           │   ├── editor-toolbar.tsx # File-type contextual toolbar
│           │   ├── csv-preview.tsx  # CSV table viewer with @tanstack/react-table
│           │   └── editor-placeholder.tsx
│           ├── explorer/            # File tree (489 LOC, 2 files)
│           │   ├── file-tree.tsx    # Directory tree view
│           │   └── file-actions.tsx # Create/delete/rename context menu
│           ├── git/                 # Git UI (1632 LOC, 3 files)
│           │   ├── git-status-panel.tsx # Status, staging UI
│           │   ├── git-graph.tsx    # Mermaid-based commit graph
│           │   └── git-placeholder.tsx
│           ├── layout/              # Layout components (13 files)
│           │   ├── panel-layout.tsx  # Main grid layout (react-resizable-panels)
│           │   ├── editor-panel.tsx  # Wrapper for tab content within a panel (v0.9.85+: fallback guards)
│           │   ├── project-bar.tsx   # 52px sidebar with project avatars (color+initials, or custom image), share popover
│           │   ├── project-avatar.tsx # Shared avatar component: renders custom image (with token+cache-bust) or fallback to color+initials
│           │   ├── project-bottom-sheet.tsx # Mobile project switcher
│           │   ├── sidebar.tsx       # Left sidebar (Explorer/Git/Database/Settings tabs)
│           │   ├── tab-bar.tsx       # Tab bar with icons, connection color display (v0.9.85+: fallback guards)
│           │   ├── draggable-tab.tsx  # Draggable tab with context menu, rename, connection color
│           │   ├── tab-content.tsx    # Router for tab content (v0.9.85+: fallback guards)
│           │   ├── split-drop-overlay.tsx # Drop zone for tab splitting
│           │   ├── command-palette.tsx # Global command palette (Shift+Shift, DB table search, filter chips for Actions/Files/DB/Filesystem)
│           │   ├── command-palette-filter-chips.tsx # Presentational filter chip bar — group toggle buttons with count badges (hidden when ≤1 group)
│           │   ├── add-project-form.tsx # Modal form to add projects
│           │   ├── mobile-nav.tsx    # Bottom navigation for mobile (v0.9.85+: fallback guards)
│           │   ├── mobile-drawer.tsx # Mobile overlay drawer
│           │   ├── tab-pool.tsx      # ADDED: mounts every tab once, reparents its DOM wrapper into the focused panel/dock/window slot
│           │   ├── reparenting-tab.tsx # ADDED: per-tab stable-container createPortal wrapper — no-remount move across panels/windows/PiP
│           │   ├── tab-pool-registry.ts # ADDED: slotRegistry — panels/dock/windows publish the element their tab content lives in
│           │   ├── tab-pop-out-menu-item.tsx # ADDED: "Open in window" tab context-menu item (desktop only)
│           │   └── use-window-panel-reconcile.ts # ADDED: one-shot repair between persisted window panels and live floating windows
│           ├── database/            # Database management (5 files, 300+ LOC)
│           │   ├── database-sidebar.tsx # Sidebar tab container (connection list, form)
│           │   ├── connection-list.tsx # Connections list with actions, color badges
│           │   ├── connection-form-dialog.tsx # Create/edit connection form (SQLite/Postgres)
│           │   ├── connection-color-picker.tsx # WCAG contrast-aware color picker
│           │   └── use-connections.ts # Hook for connection CRUD operations
│           ├── projects/            # Project management (339 LOC, 2 files)
│           ├── settings/            # Settings panel (theme + AI provider + accounts config UI)
│           │   ├── settings-tab.tsx # Main settings panel with tabs
│           │   ├── ai-settings-section.tsx # AI provider configuration
│           │   └── accounts-settings-section.tsx # Multi-account management (add, edit, delete, activate)
│           ├── terminal/            # xterm.js wrapper (143 LOC, 2 files)
│           ├── shared/              # Shared components (2 files)
│           │   ├── markdown-renderer.tsx # Render Markdown with syntax highlighting
│           │   └── bug-report-popup.tsx  # Global bug report popup
│           ├── sqlite/              # SQLite viewer (unified connectionId API mode)
│           │   ├── sqlite-viewer.tsx # Display table data, execute queries
│           │   └── use-sqlite.ts    # Hook for SQLite operations via /api/db routes
│           ├── postgres/            # PostgreSQL viewer (unified connectionId API mode)
│           │   ├── postgres-viewer.tsx # Display table data, execute queries
│           │   └── use-postgres.ts  # Hook for Postgres operations via /api/db routes
│           └── ui/                  # Radix + shadcn primitives (14 files)
│               ├── button, input, label, dialog, dropdown-menu, select, tabs, tooltip, etc.
│               └── portal-container-context.tsx # ADDED: shared Radix portal target context — lets a tab's popped-out primitives render into the PiP document
├── tests/
│   ├── test-setup.ts                # Disable auth for tests
│   ├── unit/
│   │   ├── providers/               # Mock provider, SDK tests
│   │   ├── jira-watcher-poll.test.ts # ADDED: Jira watcher polling, rate limit backoff
│   │   └── services/                # Chat, config, db, session-log, push-notification tests
│   └── integration/
│       ├── claude-agent-sdk-integration.test.ts
│       ├── sqlite-migration.test.ts # SQLite migration validation
│       ├── jira-config.test.ts # ADDED: Jira config CRUD, token encryption
│       ├── jira-migration.test.ts # ADDED: Schema v18 migration validation
│       ├── jira-watcher-db.test.ts # ADDED: Watcher + result queries
│       ├── api/                     # Chat route tests
│       ├── api/jira-routes.test.ts # ADDED: Jira API endpoints
│       └── ws/                      # WebSocket tests
│   └── e2e/
│       └── tab-popout-pip-e2e.mjs   # ADDED: headed-Chrome CDP proof — pop-out → floating window → Document PiP round trip
├── scripts/
│   ├── build.ts                     # Build CLI binary (bun build --compile)
│   └── dev.ts                       # Dev server helpers
├── dist/                            # Build output
│   ├── ppm                          # Compiled CLI binary
│   └── web/                         # Frontend bundle
├── node_modules/
├── .env.example                     # Environment template
├── tsconfig.json                    # TS config (strict mode, path aliases)
├── vite.config.ts                   # Vite config (React, PWA, proxy to dev server :8081)
├── tailwind.config.ts               # Tailwind (dark mode, custom colors)
├── package.json                     # Dependencies
├── bunfig.toml                      # Bun config (root directory)
└── README.md                        # Project overview
```

## Key Module Responsibilities

### CLI Layer (src/cli/)
- **Responsibility:** Command-line interface for managing PPM
- **Key Functions:**
  - `start` — Start the server as a supervised background daemon (the only mode); tunnel always enabled. Flags: `-p/--port`, `--profile`, deprecated `-s/--share`
  - `stop` / `down` — Stop the server keeping the supervisor + tunnel alive / full shutdown (reads status.json, falls back to ppm.pid)
  - `open` — Launch browser to active server
  - `init` — Scan filesystem for git repos, write config to `~/.ppm/ppm.db`
  - `projects` — Add/remove/list projects in config
  - `config` — View/edit config values
  - `git` — Run git operations on active project
  - `chat` — Send messages to chat session (CLI mode)
- **Pattern:** Command handler pattern (Commander.js)

### Server Layer (src/server/)
- **Responsibility:** HTTP REST API + WebSocket server
- **Key Routes:**
  - `/api/health` — Health check
  - `/api/auth/check` — Verify token validity
  - `/api/projects` — CRUD projects
  - `/api/project/:name/*` — Project-scoped routes (chat, git, files)
  - `/ws/project/:name/chat/:sessionId` — Chat streaming
  - `/ws/project/:name/terminal/:id` — Terminal I/O
- **Pattern:** Project-scoped routing via ProviderRegistry

### Service Layer (src/services/)
- **Responsibility:** Business logic, data operations, infrastructure (tunneling, database connections)
- **Services:**
  - **ChatService** — Session lifecycle, message queueing, streaming
  - **ConfigService** — Config in SQLite (dotted keys, typed cache)
  - **DbService** — SQLite persistence (WAL mode, schema v41, connection/account CRUD, table cache)
  - **AccountService** — Multi-account management, token encryption/decryption
  - **AccountSelectorService** — Select active account based on config
  - **GitService** — Git commands via simple-git
  - **FileService** — File ops with path validation
  - **fs-ops/** (ADDED) — Whole-disk filesystem ops for the OS Explorer window (`fs-path-guard.service.ts`, `fs-core-ops.ts`, `fs-ops-{stat,copy-move,mutate,trash,read-write}.service.ts`) — every route refuses the PPM dir/protected roots, `lstat`s links (never follows), async + bounded concurrency
  - **host-info/** (ADDED) — Per-OS drives/known-folders/pinned-folders providers behind a 60s in-flight-deduped cache (`host-info.service.ts`), backing `/api/system/host`
  - **media-transcode/** — Optional ffmpeg integration for the video viewer: `ffmpeg-capabilities.ts` (detect binaries + test-encode to pick `h264_nvenc`/`qsv`/`amf`/`videotoolbox`/`libx264`, cached), `media-probe.ts` (ffprobe duration/codecs), `transcode-stream.ts` (spawn → fragmented-MP4 pipe, `-ss` seek, max 3 concurrent, PID-scoped kill on client disconnect). Exposed as `…/files/{probe,transcode}` and `/api/fs/{probe,transcode}` via `src/server/helpers/media-route-handlers.ts`. `/files/raw` and `/api/fs/raw` serve HTTP Range (206) through `src/server/helpers/range-file-response.ts` so `<video>`/`<audio>` stream and seek without a blob. Player UI: `src/web/components/editor/video-player/` (native + transcode modes, rotate/flip, speed, volume, keyboard shortcuts).
  - **ProjectService** — Project CRUD, scanning, resolution
  - **TerminalService** — PTY lifecycle, shell spawning
  - **ClaudeUsageService** — Token tracking, cost calculation
  - **PushNotificationService** — Web push subscriptions
  - **SessionLogService** — Audit logs with sensitive data redaction
  - **CloudflaredService** — Download/cache cloudflared binary (platform-aware)
  - **TunnelService** — Spawn tunnel, extract URL, cleanup on exit
  - **named-tunnel/** (ADDED) — Named-tunnel (stable custom-domain) setup + runtime, orchestrated from
    the server, spawned/probed by the supervisor: `cloudflared-cert.ts` (parse-based `~/.cloudflared/cert.pem`
    state, never a bare `existsSync`), `cloudflared-login.service.ts` (login session state machine —
    60s slow banner, 5min kill, uncapped retry), `named-tunnel-setup.service.ts` (zone → precheck →
    create → route → token → persist, background-confirmed via `retunnel`), `named-tunnel-args.ts`
    (argv builders — run token via `--token-file` only, never argv), `named-tunnel-probe-state.ts`
    (pure restart-once-then-warn decision function for the supervisor's health probe),
    `hostname-rules.ts` (one label above the zone, no apex/`www`), `cloudflare-zone-api.ts` /
    `cloudflare-dns-api.ts` (Cloudflare REST lookups for zone name + DNS collision precheck).
    Routes: `src/server/routes/named-tunnel.ts` (`/api/tunnel/named/*`; mutations 403 unless PPM auth
    is enabled). UI: `src/web/components/tunnels/named-tunnel/` (first-run popup + permanent Tunnel
    Manager section, sharing one step-reducer-driven flow).
  - **fs-credential-path-guard.ts** (ADDED) — Refuses `~/.cloudflared` (Cloudflare login cert)
    alongside the PPM dir on every fs read/write/transfer door, symlink-resolved
  - **config-secret-keys.ts** (ADDED) — Denylist + deep redaction for config-dump surfaces
    (`ppm config get`, extension RPC `workspace:config:get`) — masks a secret leaf even when the
    caller asked for an ancestor object (e.g. `get tunnel` still masks `namedTunnelToken`)
  - **TableCacheService** — Cache table metadata across connections, search tables by name
  - **DatabaseAdapterRegistry** — Register/retrieve DatabaseAdapter implementations (extensible pattern)
  - **SQLiteAdapter** — SQLite connection/query execution with readonly checks
  - **PostgresAdapter** — PostgreSQL connection/query execution with readonly checks
  - **PPMBotService** — Coordinator orchestrator (startup, shutdown, message routing, task polling)
  - **PPMBotSessionManager** — Coordinator session per chat in ~/.ppm/bot/, project resolver
  - **PPMBotTelegramService** — Telegram API (long-polling, send, edit, typing, command handling)
  - **PPMBotMemoryService** — SQLite memory persistence (save, recall, project-aware search)
  - **executeDelegation()** — Task execution (creates isolated session, runs prompt, captures result)
  - **PPMBotFormatterService** — Markdown → Telegram HTML, message chunking (4096 char limit)
  - **PPMBotStreamerService** — ChatEvent streaming → progressive Telegram message editing
  - **ClawBotService** — Legacy Telegram bot (deprecated v0.9.11, replaced by PPMBot coordinator)
  - **ClawBotTelegramService** — Legacy Telegram API
  - **ClawBotSessionService** — Legacy session mapping
  - **ClawBotMemoryService** — Legacy memory service
  - **ClawBotFormatterService** — Legacy formatter
  - **ClawBotStreamerService** — Legacy streamer
- **Pattern:** Singleton services, dependency injection via imports, adapter registry for extensibility

### Provider Layer (src/providers/)
- **Responsibility:** AI model abstraction, config-driven initialization
- **Providers:**
  - **claude-agent-sdk** — Primary (official SDK, streaming, tool use). Reads model/effort/maxTurns/budget/thinking from config.
  - **mock** — Test provider (ignores config)
- **Interface:** Async generator streaming, tool approval callback
- **Pattern:** Registry pattern for pluggable AI providers. Config read fresh per query (configService integration).

### Frontend Layer (src/web/)
- **Responsibility:** React UI for project management, chat, terminal, editor
- **Key Stores:**
  - **ProjectStore** — Active project, project list, localStorage persistence
  - **TabStore** — Tab facade, delegates to panel-store
  - **PanelStore** — Grid layout, panel creation, keep-alive snapshots; `window-panel-actions.ts`/`window-panel-persistence.ts`/`window-panel-reconcile.ts` (ADDED) — pop a tab out to a floating window (off-grid `__win__:` panel) and reconcile it against live windows on reload
  - **FileStore** — File cache
  - **SettingsStore** — Theme, sidebar, git view, device name
  - **CompareStore** — File compare selection (path, project, dirty content); persists to localStorage with >500KB guard; auto-clears on project switch
  - **KeybindingsStore** — Custom keybinding overrides (includes `compare-files` action with default `Mod+Alt+D`)
- **Pattern:** Zustand for state, React.lazy() for tab content splitting

## Data Flow Diagrams

### Chat Streaming Flow
```
User types message
    ↓
MessageInput captures text
    ↓
useChat hook calls POST /api/project/:name/chat/sessions/:id/messages
    ↓
ChatService streams AI response
    ↓
WebSocket connection streams ChatEvent objects
    ↓
useChat accumulates message
    ↓
MessageList renders streamed content
    ↓
User approves tool use (if needed)
    ↓
ChatWsClientMessage sent with approval_response
```

### Terminal I/O Flow
```
User types in terminal
    ↓
xterm.js captures keypress
    ↓
useTerminal sends {type: "input", data: "..."} via WebSocket
    ↓
TerminalService writes to PTY stdin
    ↓
Shell output captured from PTY stdout
    ↓
{type: "output", data: "..."} sent back via WebSocket
    ↓
xterm.js renders output
```

### Git Operation Flow
```
User stages file in UI
    ↓
FileActions calls POST /api/project/:name/git/stage
    ↓
GitService runs git add <file>
    ↓
GitStatusPanel refreshes: GET /api/project/:name/git/status
    ↓
UI updates staged/unstaged lists
```

### Git Workflow Enhancements (v0.9.86+)

**Stash Management:**
- Toolbar popover lists all stashes (index, abbreviated hash, message)
- Apply/Pop/Drop actions per stash with visual feedback
- "Stash Changes" button saves uncommitted work to stash list
- Stash state integrated into RepoInfo and refreshed on status changes

**Conflict Detection & Resolution:**
- Detects merge/rebase/cherry-pick state from .git sentinel files (MERGE_HEAD, rebase-merge/, CHERRY_PICK_HEAD)
- Parses git status UU/AA/DD/AU/UA/DU/UD codes for unmerged entries
- Conflict state banner shows state type, progress (e.g., "3/5" for rebase), and Continue/Skip/Abort actions
- New `conflict-editor` tab type with Monaco-based visual conflict resolution
  - Parses 3-way conflict markers (<<<<<<, =======, >>>>>>>)
  - Highlights current (green), incoming (blue), and marker lines (gray)
  - Accept buttons for Current / Incoming / Both with automatic save
  - Real-time conflict counter: "N conflicts remaining" → "All resolved"

**Rebase from Context Menu:**
- Right-click commits to open rebase menu
- Confirmation dialog with branch/target selection
- Rebase state tracking and progress display during operation

**Worktree Management:**
- Popover UI for listing, creating, removing, pruning worktrees
- Current worktree highlighted with active badge
- "Create Worktree Here..." option in commit context menu
- Auto-add unregistered worktrees as projects with confirmation
- Branch-already-exists handling with force-replace option

### Tab System Safety (v0.9.85+)

All tab routing and rendering components now include fallback guards for unknown tab types:

**Components Updated:**
- `tab-bar.tsx` — Tab item rendering with fallback icon/label
- `mobile-nav.tsx` — Mobile tab selection with fallback handling
- `tab-content.tsx` — Content router with "Unknown tab type" fallback
- `editor-panel.tsx` — Panel wrapper with graceful unknown type handling

**Behavior:**
- Unknown tab types no longer crash the UI
- Fallback displays icon + tab identifier
- Users can still close/manage unknown tabs
- Enables safe extension tab additions without core UI changes

**Motivation:** Support future extension-contributed tab types without requiring core UI updates.

---

## Critical Types

| Type | Location | Purpose |
|---|---|---|
| `ApiResponse<T>` | types/api.ts | Standard envelope for all REST responses |
| `AIProvider` | providers/provider.interface.ts | Interface for AI model adapters |
| `ChatEvent` | types/chat.ts | Union of streaming message types |
| `GitStatus` | types/git.ts | Current branch, staged, unstaged, untracked files (includes conflicted field v0.9.86+) |
| `Session` | types/chat.ts | Chat session with ID, projectName, title, createdAt |
| `Project` | types/project.ts | Project config (name, path, color, image?) |
| `ProjectConfig` | types/config.ts | Persisted project config (includes image?: string for avatar) |
| `MergeState` | ext-git-graph/src/types.ts | Merge/rebase/cherry-pick state with progress tracking (v0.9.86+) |
| `TabType` | web/stores/tab-store.ts | "editor" \| "chat" \| "terminal" \| "database" \| "git-graph" \| "conflict-editor" \| "settings" (v0.9.86+) |

## External Dependencies

| Package | Purpose | Version |
|---------|---------|---------|
| hono | HTTP framework | 4.12.8 |
| simple-git | Git CLI wrapper | 3.33 |
| @monaco-editor/react | Code editor | 4.7.0 |
| @xterm/xterm | Terminal emulator | 6.1.0-beta.285 |
| zustand | State management | 5.0.11 |
| @anthropic-ai/claude-agent-sdk | AI provider | 0.3.251 (pinned) |
| vite | Frontend bundler | 8.0 |
| tailwindcss | Utility CSS | 4.2 |
| radix-ui | Accessible components | 1.4.3 |
| next-themes | Theme switcher | 0.4.6 |
| @tanstack/react-table | Table library | 8.21.3 |
| @tanstack/react-virtual | Virtual scrolling | 3.13.23 |

## Build Output

**CLI Binary:** `dist/ppm` (compiled via `bun build --compile`)
- Single-file executable
- Includes embedded server + frontend assets
- Runnable on Linux/macOS without Bun installed

**Frontend:** `dist/web/` (Vite bundle)
- index.html + chunks
- PWA manifest, service worker
- Assets (~500KB gzipped)

## Testing Strategy

| Test Type | Location | Coverage |
|-----------|----------|----------|
| Unit | tests/unit/ | Services, utilities |
| Integration | tests/integration/ | API routes, WebSocket, provider models |
| E2E | None yet | Planned for v3 |

**Key Gotchas:**
- Test DB isolated per test (never writes to ~/.ppm/ppm.db)
- Auth disabled in test mode (test-setup.ts)
- Mock provider used for deterministic responses
- 492 passing tests (0 failures, v0.8.60)

---

## Recent Changes (v0.9.0+)

### v0.9.11 (PPMBot Coordinator Redesign)
- **Architecture Shift** — PPMBot transformed from direct AI chat executor to intelligent coordinator/team leader
  - Single persistent coordinator session per chat in `~/.ppm/bot/` workspace
  - Delegates project-specific tasks to subagents (spawns fresh PPM sessions per project)
  - Decision framework: Answer directly if no project context needed, delegate if file access required
  - Telegram commands reduced from 13 to 3 public (/start, /help, /status) + 1 hidden (/restart)
- **Delegation Flow**
  - CLI: `ppm bot delegate --chat <id> --project <name> --prompt "<enriched>"` creates task
  - Background task poller (5s interval) executes pending tasks
  - Task execution: Creates isolated session, runs async generator, captures result summary
  - UI: Settings panel shows delegated tasks with auto-refresh
  - Abort/timeout handling: 900s default timeout per task
- **Database Schema v14** — New `bot_tasks` table (taskId, chatId, projectName, prompt, status, result, error, timeout)
- **Coordinator Identity** — `coordinator.md` replaces per-session identity, loaded from `~/.ppm/bot/coordinator.md`
  - Cross-provider identity via XML context block injected into SDK subprocess
  - Coordinator tools: bash-accessible `ppm bot` CLI commands (delegate, task-status, task-result, tasks)
- **CLI Expansion** — New `ppm bot` command group
  - Delegation: `delegate`, `task-status`, `task-result`, `tasks`
  - Project management: `project list`, `project current`, `project switch`
  - Session mgmt: `session new`, `session list`, `session resume`, `session stop`
  - Status/help: `status`, `version`, `restart`, `help`
- **Files Created:**
  - `src/services/ppmbot/ppmbot-delegation.ts` — Delegation execution + result capture
  - Updated: `src/services/ppmbot/ppmbot-service.ts` (task poller lifecycle)
  - Updated: `src/cli/commands/bot-cmd.ts` (delegation + project/session commands)
  - Updated: `src/services/db.service.ts` (bot_tasks table, schema v14 migration)

### v0.9.10 (ClawBot Telegram Integration)
- **Telegram Bot Service** — Long-polling Telegram bot with message routing
  - Session mapping: chatID → PPM sessionID (per-user thread isolation)
  - Pairing system: Code-based device pairing with owner approval in web UI
  - Message queue: Handle concurrent Telegram messages without race conditions
- **Memory System** — FTS5 persistent conversation memory
  - Hybrid extraction: AI extraction (primary) + regex fallback
  - Cross-project search: Auto-detect project name mentions → include memories
  - Decay/supersede: Memory relevance based on age + custom decay factors
- **Response Streaming** — Progressive Telegram message editing
  - ChatEvent streaming with 1s throttle
  - Markdown → Telegram HTML formatting with chunking (4096 char limit)
- **Settings & History**
  - Settings UI: Enable/disable, paired devices, default project, system prompt, display toggles, debounce config
  - Chat history: [Claw] prefix sessions with robot icon for easy identification
- **Database Schema v13** — `clawbot_sessions`, `clawbot_memories` (FTS5), `clawbot_paired_chats` tables

### v0.9.0 (Extension System Phase 1)
- **Extension Framework** — VSCode-compatible npm-installable extensions
- **Worker Isolation** — Crash-safe extension execution in Bun Workers
- **RPC Protocol** — Bidirectional messaging (request/response/events)
- **State Management** — globalState + workspaceState persistence in SQLite
- **Contribution Registry** — Commands, views, configuration registry
- **CLI Support** — `ppm ext` commands for lifecycle management
- **Dev Mode** — Symlink local extensions for development

### v0.8.60
- **Dynamic Model Listing** — `listModels?()` on AIProvider interface
- **Provider Models APIs** — Global and project-scoped endpoints
- **AI Settings UI** — Per-provider tabs with dynamic model dropdowns
- **Chat History Badges** — Provider-aware usage display
- **13 new integration tests** for provider models API

---


