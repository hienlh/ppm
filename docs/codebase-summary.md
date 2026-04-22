# PPM Codebase Summary

**Last Updated:** 2026-04-15
**Version:** 0.9.86
**Repository:** PPM (Project & Process Manager) — Multi-provider web IDE/project manager with Claude Agent SDK

**Core Statistics:**
- **366 files** across CLI, server, web, packages, and test layers
- **885,308 tokens** total codebase size (repomix)
- **500+ passing tests**
- **Tech Stack:** Bun (runtime), Hono (HTTP), React (UI), Claude Agent SDK (AI)

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
│   ├── cli-provider-base.ts     # Abstract base for CLI providers
│   ├── mock-provider.ts         # Test provider
│   └── registry.ts              # Provider routing (list() vs listAll())
├── services/                    # Business logic (30+ files)
│   ├── chat.service.ts          # Session/message streaming
│   ├── config.service.ts        # Config loading/persistence
│   ├── db.service.ts            # SQLite CRUD (schema migrations, extension_storage)
│   ├── file.service.ts          # File operations
│   ├── git.service.ts           # Git commands
│   ├── terminal.service.ts      # PTY management
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
│   ├── clawbot/                 # Legacy: Telegram bot service layer (deprecated v0.9.11)
│   │   ├── clawbot.service.ts   # (Original direct-chat model, replaced by coordinator)
│   │   └── ... (other files)
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
    │   ├── explorer/
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
│           ├── chat/                # Chat UI (12 files)
│           │   ├── chat-tab.tsx     # Main chat container, session picker, streaming
│           │   ├── chat-history-bar.tsx # Session history sidebar, inline rename
│           │   ├── chat-history-panel.tsx # Full session list modal
│           │   ├── message-list.tsx # Scrolling message view with tool results
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
│           │   ├── project-bar.tsx   # 52px sidebar with project avatars, share popover
│           │   ├── project-bottom-sheet.tsx # Mobile project switcher
│           │   ├── sidebar.tsx       # Left sidebar (Explorer/Git/Database/Settings tabs)
│           │   ├── tab-bar.tsx       # Tab bar with icons, connection color display (v0.9.85+: fallback guards)
│           │   ├── draggable-tab.tsx  # Draggable tab with context menu, rename, connection color
│           │   ├── tab-content.tsx    # Router for tab content (v0.9.85+: fallback guards)
│           │   ├── split-drop-overlay.tsx # Drop zone for tab splitting
│           │   ├── command-palette.tsx # Global command palette (Shift+Shift, DB table search)
│           │   ├── add-project-form.tsx # Modal form to add projects
│           │   ├── mobile-nav.tsx    # Bottom navigation for mobile (v0.9.85+: fallback guards)
│           │   └── mobile-drawer.tsx # Mobile overlay drawer
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
│               └── button, input, label, dialog, dropdown-menu, select, tabs, tooltip, etc.
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
├── scripts/
│   ├── build.ts                     # Build CLI binary (bun build --compile)
│   └── dev.ts                       # Dev server helpers
├── dist/                            # Build output
│   ├── ppm                          # Compiled CLI binary
│   └── web/                         # Frontend bundle
├── node_modules/
├── .env.example                     # Environment template
├── ppm.yaml                         # Auto-generated project config
├── tsconfig.json                    # TS config (strict mode, path aliases)
├── vite.config.ts                   # Vite config (React, PWA, proxy to :8080)
├── tailwind.config.ts               # Tailwind (dark mode, custom colors)
├── package.json                     # Dependencies
├── bunfig.toml                      # Bun config (root directory)
└── README.md                        # Project overview
```

## Key Module Responsibilities

### CLI Layer (src/cli/)
- **Responsibility:** Command-line interface for managing PPM
- **Key Functions:**
  - `start` — Start Hono server (background by default, --foreground/-f for foreground, --share/-s for tunnel)
  - `stop` — Stop daemon (reads status.json first, falls back to ppm.pid)
  - `open` — Launch browser to active server
  - `init` — Scan filesystem for git repos, create ppm.yaml
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
  - **ConfigService** — Config loading (YAML→SQLite migration)
  - **DbService** — SQLite persistence (9 tables, WAL mode, schema v5, connection/account CRUD, table cache)
  - **AccountService** — Multi-account management, token encryption/decryption
  - **AccountSelectorService** — Select active account based on config
  - **GitService** — Git commands via simple-git
  - **FileService** — File ops with path validation
  - **ProjectService** — Project CRUD, scanning, resolution
  - **TerminalService** — PTY lifecycle, shell spawning
  - **ClaudeUsageService** — Token tracking, cost calculation
  - **PushNotificationService** — Web push subscriptions
  - **SessionLogService** — Audit logs with sensitive data redaction
  - **CloudflaredService** — Download/cache cloudflared binary (platform-aware)
  - **TunnelService** — Spawn tunnel, extract URL, cleanup on exit
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
  - **PanelStore** — Grid layout, panel creation, keep-alive snapshots
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
| `Project` | types/project.ts | Project config (name, path) |
| `MergeState` | ext-git-graph/src/types.ts | Merge/rebase/cherry-pick state with progress tracking (v0.9.86+) |
| `TabType` | web/stores/tab-store.ts | "editor" \| "chat" \| "terminal" \| "database" \| "git-graph" \| "conflict-editor" \| "settings" (v0.9.86+) |

## External Dependencies

| Package | Purpose | Version |
|---------|---------|---------|
| hono | HTTP framework | 4.12.8 |
| simple-git | Git CLI wrapper | 3.33 |
| @monaco-editor/react | Code editor | 4.7.0 |
| xterm | Terminal emulator | 6.0 |
| zustand | State management | 5.0.11 |
| @anthropic-ai/claude-agent-sdk | AI provider | 0.2.81 |
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

## Multi-Provider Architecture (v0.8.60)

### Dynamic Model Listing Feature

**Problem:** Different AI providers expose different models. Claude has hardcoded models, but CLI-based providers (e.g., Cursor) discover models at runtime.

**Solution:** Optional `listModels()` method on `AIProvider` interface

### Provider Interface

```typescript
// src/types/chat.ts
export interface ModelOption {
  value: string;    // Model ID (e.g., "claude-sonnet-4-6")
  label: string;    // Display name (e.g., "Claude Sonnet 4.6")
}

interface AIProvider {
  // Required methods
  createSession(): Promise<Session>;
  sendMessage(sessionId, message, context?): AsyncIterable<ChatEvent>;

  // Optional methods
  listModels?(): Promise<ModelOption[]>;
  isAvailable?(): Promise<boolean>;
  // ... (5 other optional methods)
}
```

### Provider Implementations

#### Claude (agent-sdk.ts)
- `listModels()` returns hardcoded 2 models: Sonnet 4.6, Opus 4.6
- Direct implementation (no subprocess)

#### Cursor (cursor-provider.ts)
- `listModels()` runs `cursor-agent --list-models` subprocess
- 5-minute TTL cache (prevents repeated subprocess calls)
- 10-second timeout (graceful fallback to empty list)
- Extends `CliProvider` abstract base

#### Mock (mock-provider.ts)
- For testing; returns canned models

### API Endpoints

**Global Models Endpoint** (`GET /api/settings/ai/providers/:id/models`)
```typescript
// Used in Settings UI (no project context needed)
settingsRoutes.get("/ai/providers/:id/models", async (c) => {
  const provider = providerRegistry.get(c.req.param("id"));
  const models = await provider.listModels?.() ?? [];
  return c.json(ok(models));
});
```

**Project-Scoped Models Endpoint** (`GET /api/project/:name/chat/providers/:providerId/models`)
```typescript
// Used in Chat tab (scoped to project for consistency)
chatRoutes.get("/providers/:providerId/models", async (c) => {
  const provider = providerRegistry.get(c.req.param("providerId"));
  const models = await provider.listModels?.() ?? [];
  return c.json(ok(models));
});
```

### Provider Registry Pattern

**list() — User-facing providers:**
```typescript
list(): ProviderInfo[] {
  return [
    { id: "claude", name: "Claude" },
    { id: "cursor", name: "Cursor" }
    // mock excluded
  ];
}
```

**listAll() — All providers (internal):**
```typescript
listAll(): ProviderInfo[] {
  return [..., { id: "mock", name: "Mock" }];
}
```

**Auto-Bootstrap:**
```typescript
// On startup, detect CLI providers
async bootstrapProviders() {
  const cursor = this.providers.get("cursor");
  if (cursor && await cursor.isAvailable?.()) {
    // Auto-create config entry if detected
    // Save config (only if new)
  }
}
```

### UI Components

#### AI Settings Section (ai-settings-section.tsx) — UPDATED
- Per-provider tabs (Claude, Cursor, etc.)
- Dynamic model dropdowns fetched from `/api/settings/ai/providers/:id/models`
- Fallback to hardcoded models if API call fails
- Provider-aware settings (SDK vs CLI options)

#### Chat History Bar (chat-history-bar.tsx) — ADDED
- Provider badges showing active provider for each session
- Provider-aware usage display:
  - **Claude:** Full stats `(tokens_in:X, tokens_out:Y, cost: $Z)`
  - **Other:** Context-only `(tokens: X)`

### Configuration

```yaml
ai:
  default_provider: claude
  providers:
    claude:
      type: agent-sdk
      model: claude-sonnet-4-6  # from listModels()
      effort: high
      max_turns: 100
    cursor:
      type: cli
      model: cursor-fast        # from listModels()
```

### Testing

**New Integration Tests (13 tests):**
- `provider-models-api.test.ts` — Model API endpoints
- `chat-service-multi-provider.test.ts` — Multi-provider flows
- `cursor-provider.test.ts` — Subprocess TTL cache, timeout handling

---

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

## Extension System (v0.9.0+)

### Core Architecture

**Installation Directory:** `~/.ppm/extensions/node_modules/`
**State Storage:** SQLite `extension_storage` table (globalState + workspaceState)
**Worker Isolation:** Bun Worker threads per activated extension
**RPC Protocol:** Typed request/response/event messaging

### New Files & Services
- `src/types/extension.ts` — ExtensionManifest, ExtensionContext, RpcMessage types
- `src/server/routes/extensions.ts` — REST API (GET/POST/DELETE/PATCH)
- `src/services/extension.service.ts` — Lifecycle, activation, state management (120 LOC)
- `src/services/extension-installer.ts` — npm install, symlink, removal (100 LOC)
- `src/services/extension-manifest.ts` — Parse + discover manifests (70 LOC)
- `src/services/extension-rpc.ts` — RPC channel implementation (120 LOC)
- `src/services/extension-host-worker.ts` — Worker-side extension loading (150 LOC)
- `src/services/contribution-registry.ts` — Central command/view/config registry (80 LOC)
- `src/cli/commands/ext-cmd.ts` — Extension CLI commands (121 LOC)

### Manifest Example (package.json)
```json
{
  "name": "@ppm/ext-database",
  "ppm": {
    "displayName": "Database Browser",
    "main": "dist/extension.js",
    "activationEvents": ["onView:databases"],
    "contributes": {
      "commands": [{"command": "ppm.database.openConnection", "title": "..."}],
      "views": {"explorer": [{"id": "databases", "name": "Databases"}]},
      "configuration": {"properties": {"ppm.database.maxRows": {"type": "number"}}}
    }
  }
}
```

### REST API Endpoints
- `GET /api/extensions` — List installed
- `POST /api/extensions` — Install from npm
- `DELETE /api/extensions/:id` — Remove
- `PATCH /api/extensions/:id` — Enable/disable
- `GET /api/extensions/contributions` — List all contributions

### CLI Commands
```
ppm ext list                      # List extensions
ppm ext install @ppm/ext-db       # Install
ppm ext remove @ppm/ext-db        # Uninstall
ppm ext enable @ppm/ext-db        # Enable
ppm ext disable @ppm/ext-db       # Disable
ppm ext dev /path/to/src          # Dev symlink
```

### Bundled Extensions (v0.9.85+)

PPM ships with pre-built extensions in `packages/ext-*` that are auto-discovered and available out-of-the-box:

**Discovery:**
- `discoverBundledManifests()` scans `packages/` for directories matching `ext-*`
- Bundled extensions loaded during `discover()` before user-installed extensions
- User-installed extensions override bundled if same ID (user takes precedence)

**Behavior:**
- `ppm ext list` shows "Source" column: `bundled` (cyan) vs `user`
- Bundled extensions cannot be removed (`ppm ext remove` rejected with helpful message)
- Use `ppm ext disable` to turn off bundled extensions
- Removal protection prevents accidental deletion of core extensions

**Current Bundled Extensions:**
- `@ppm/ext-git-graph` — Interactive git history visualization with workflow actions

**Architecture:**
- Extension paths tracked in `extensionService.extensionPaths` (ID → directory)
- Bundled IDs tracked in `extensionService.bundledIds` Set
- `isBundled(id)` public method for checking extension source

---

## ext-git-graph Extension (Git History Visualization)

### Overview
The git-graph extension provides an interactive SVG visualization of repository commit history with comprehensive git workflow support. Implements the vscode-git-graph deterministic layout algorithm with faithful branch path rendering.

### Key Features

**Graph Visualization:**
- Single SVG model with continuous Bézier branch paths for smooth merge visualization
- Deterministic lane assignment algorithm with greedy color reuse for branch lanes
- Shadow lines for visual depth and branch continuity
- Proper HEAD/stash node rendering (hollow circle for HEAD, nested circles for stash)
- Mobile SVG alignment: gridY matches 44px CSS row height for responsive layouts

**Git Workflow Actions:**
- **File Operations:** Stage/unstage files, open in editor, discard changes
- **Commits:** Create commits directly from webview with message and file selection
- **Branch Operations:** Stash/reset/clean with context menu and safety warnings
- **Repository:** Auto-fetch with configurable interval, manual fetch button
- **Filters:** Branch/tag/remote filters, tree/list view toggle

**UI Components:**
- Resizable graph column for flexible workspace adjustment
- Branch filter dropdown for quick navigation
- Tree/list view toggle for different visualization modes
- Commit detail panel with file diffs and action buttons
- Context menus with destructive operation warnings

### Architecture

**Location:** `packages/ext-git-graph/`

**Files:**
- `extension.ts` (370 LOC) — RPC handlers, git operations, settings management
- `webview-html.ts` (443 additions) — Faithful SVG graph rendering with deterministic layout
- `types.ts` — Extension settings, message types, git operation definitions
- `git-log-parser.ts` — Parse git log with branches, tags, remotes, stashes
- `extension.test.ts` (230+ lines) — Integration tests for RPC handlers
- `webview-html.test.ts` — Graph rendering and layout tests

**RPC Protocol:**
- `gitStatus()` — Get current repo state
- `gitLog()` — Fetch commit history
- `stage(path)` / `unstage(path)` — File staging
- `commit(message, files)` — Create commit
- `stash()` / `reset(ref)` / `clean()` — Branch operations
- `openFile(path)` — Open in editor (IPC to main window)

**Settings:**
- `autoFetchInterval: number` — Seconds between auto-fetches (0 = disabled)

### Security

**Path Validation:**
- `assertSafePath()` in extension-rpc-handlers ensures git operations only on registered project paths
- Prevents directory traversal attacks
- Cross-project workspace safety via RPC sandboxing

**XSS Prevention:**
- `escHtml()` applied to parent hashes and file status in detail panel
- Sanitized commit messages and metadata display

### Mobile & Responsive

- Long-press support for context menus on touch devices
- Responsive CSS with flexible column sizing
- Dark/light theme support via CSS variables
- Touch-friendly button sizing (44px minimum)

### Testing

**62 unit tests** covering:
- Git log parsing (commits, branches, tags, stashes)
- Parser edge cases (merge commits, rebases, detached HEAD)
- RPC handler validation and error cases
- Webview HTML rendering and layout algorithms
- Integration with main extension lifecycle

---

## Slash-Discovery Module (Modular Command Engine)

### Overview
Modular discovery engine for slash commands and skills. Replaces monolithic `slash-items.service.ts` with composable, testable modules. Supports:
- Skill roots: user-global (`~/.claude/skills/`), env vars, bundled assets
- SKILL.md parsing + loose `.md` files + command registry
- Shadowing resolution (project > user > bundled)
- Fuzzy search via Levenshtein distance
- Built-in commands (9 commands: /skills, /version, /help, etc.)
- Server-side + client-side search

### Architecture
**Location:** `src/services/slash-discovery/`

**Core Modules:**
- `types.ts` — DefinitionSource, SkillRoot, SlashItem, DiscoveryResult
- `definition-source.ts` — Priority ranking (project > user > bundled), scope mapping
- `discover-skill-roots.ts` — Ancestor walking, env var expansion, root discovery
- `skill-loader.ts` — SKILL.md extraction, loose .md + commands parsing
- `resolve-overrides.ts` — Shadowing resolution logic
- `fuzzy-search.ts` — Levenshtein-based matching with configurable threshold
- `builtin-commands.ts` — 9 built-in commands + descriptions
- `builtin-handlers.ts` — PPM-side handlers (/skills list, /version)
- `index.ts` — Main pipeline, exports

### Key Features
**Skill Discovery:**
```
~/.claude/skills/ppm-guide/SKILL.md → Parse [ppm-guide] commands
$CLAUDE_SKILLS_PATH/custom/ → Env-var roots
assets/skills/bundled/ → Built-in (ppm-guide)
```

**Shadowing Resolution:**
- Project-level overrides user-level overrides bundled defaults
- Prevents duplicate entries, maintains priority order

**Fuzzy Matching:**
- Levenshtein distance algorithm
- Configurable tolerance for typo handling
- Powers `/skills search <query>`

### API & CLI

**REST API:**
- `GET /chat/slash-items?q=<query>` — Optional server-side fuzzy search
- Response includes `type: "builtin"` items

**CLI Commands:**
```
ppm skills list              # List discovered skills with source info
ppm skills search <query>    # Fuzzy search skills
ppm skills info <name>       # Detail view (name, description, source)
ppm skills --json            # Machine-readable output
ppm skills --project <path>  # Custom project scope
```

**WebSocket Interception:**
- Messages starting with `/skills` or `/version` intercepted by PPM before SDK
- Builtin handlers execute locally, reducing SDK subprocess overhead

### Bundled Guide Skill
- `assets/skills/ppm-guide/SKILL.md` — Auto-generated from `docs/`
- `scripts/generate-ppm-guide.ts` — Generator script
- `bun run generate:guide` — npm script to regenerate

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

