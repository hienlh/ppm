# PPM Codebase Summary

Generated from codebase analysis of 135+ TypeScript files, ~22.5K LOC (including multi-account feature).

## Directory Structure

```
ppm/
├── src/
│   ├── index.ts                     # CLI entry point (Commander.js program)
│   ├── cli/
│   │   ├── commands/                # CLI command implementations (14 files, 1700 LOC)
│   │   │   ├── start.ts             # Start server (background by default, --foreground/-f, --share/-s for tunnel)
│   │   │   ├── stop.ts              # Stop daemon (reads status.json or ppm.pid, graceful shutdown)
│   │   │   ├── restart.ts           # Restart daemon (keeps tunnel alive)
│   │   │   ├── status.ts            # Show daemon status
│   │   │   ├── open.ts              # Open browser to http://localhost:PORT
│   │   │   ├── logs.ts              # Tail daemon logs
│   │   │   ├── report.ts            # File bug report on GitHub
│   │   │   ├── init.ts              # Initialize config (scan git repos, DB profile support)
│   │   │   ├── projects.ts          # Add/remove/list/scan projects
│   │   │   ├── config-cmd.ts        # View/set config values
│   │   │   ├── git-cmd.ts           # Git operations (status, diff, log, commit)
│   │   │   ├── chat-cmd.ts          # Chat CLI (send messages, manage sessions)
│   │   │   └── db-cmd.ts            # Database CLI (list, query, manage connections)
│   │   └── utils/
│   │       └── project-resolver.ts  # Resolve project name -> path
│   ├── server/
│   │   ├── index.ts                 # Hono server setup, Bun.serve, WebSocket upgrade
│   │   ├── middleware/
│   │   │   └── auth.ts              # Token validation middleware
│   │   ├── routes/
│   │   │   ├── settings.ts          # GET/PUT /api/settings/ai (AI provider config)
│   │   │   ├── projects.ts          # GET/POST /api/projects, DELETE /:name
│   │   │   ├── accounts.ts          # GET/POST/PUT/DELETE /api/accounts, POST activate
│   │   │   ├── project-scoped.ts    # Mount chat, git, files under /api/project/:name/*
│   │   │   ├── chat.ts              # GET/POST/DELETE sessions, GET messages, usage, slash-items
│   │   │   ├── git.ts               # GET status, diff, log, graph; POST commit, stage, discard
│   │   │   ├── files.ts             # GET tree, read, diff; PUT write; POST mkdir, delete
│   │   │   ├── database.ts          # GET/POST/PUT/DELETE /api/db/connections (CRUD), query execution
│   │   │   └── static.ts            # Serve dist/web/index.html (frontend)
│   │   ├── helpers/
│   │   │   └── resolve-project.ts   # Helper to resolve project from request params
│   │   └── ws/
│   │       ├── chat.ts              # WebSocket chat streaming (220 LOC)
│   │       └── terminal.ts          # WebSocket terminal I/O (terminal.service.ts integration)
│   ├── providers/                   # AI Provider adapters (4 files, 1190 LOC)
│   │   ├── provider.interface.ts    # AIProvider interface (createSession, sendMessage, onToolApproval)
│   │   ├── claude-agent-sdk.ts      # Primary: SDK integration, tool approval, Windows CLI fallback, .env poisoning mitigation
│   │   ├── mock-provider.ts         # Test provider (ignores config)
│   │   └── registry.ts              # ProviderRegistry (singleton, router to active provider)
│   ├── services/                    # Business logic (20 files, 3300+ LOC)
│   │   ├── chat.service.ts          # Session lifecycle, message streaming
│   │   ├── config.service.ts        # Config loading (YAML→SQLite migration)
│   │   ├── db.service.ts            # SQLite persistence (schema v5, WAL mode, 9 tables, connection/account CRUD)
│   │   ├── account.service.ts       # Account CRUD, token encryption/decryption, active selection
│   │   ├── account-selector.service.ts # Select active account based on config
│   │   ├── project.service.ts       # Project CRUD, scanning, resolution
│   │   ├── file.service.ts          # File ops with path validation
│   │   ├── git.service.ts           # Git operations (status, diff, log, graph)
│   │   ├── terminal.service.ts      # PTY management, Bun.spawn native shell
│   │   ├── claude-usage.service.ts  # Token tracking, cost calculation
│   │   ├── push-notification.service.ts # Web push subscriptions
│   │   ├── session-log.service.ts   # Session audit logs with redaction
│   │   ├── slash-items.service.ts   # /slash command detection & completion
│   │   ├── git-dirs.service.ts      # Cached git directory discovery
│   │   ├── cloudflared.service.ts   # Download cloudflared binary (platform-specific)
│   │   ├── tunnel.service.ts        # Cloudflare Quick Tunnel lifecycle
│   │   ├── table-cache.service.ts   # Table metadata cache & search for DB connections
│   │   └── database/                # Database adapters & registry
│   │       ├── adapter-registry.ts  # DatabaseAdapter registry (extensible)
│   │       ├── sqlite-adapter.ts    # SQLite connection, query execution
│   │       ├── postgres-adapter.ts  # PostgreSQL connection, query execution
│   │       ├── init-adapters.ts     # Initialize adapters at server start
│   │       └── readonly-check.ts    # isReadOnlyQuery() safety regex (CTE-safe)
│   ├── lib/                         # Shared utilities (2 files)
│   │   ├── account-crypto.ts        # AES-256 encryption/decryption for API keys
│   │   └── network-utils.ts         # Network utility helpers
│   ├── types/                       # TypeScript interfaces (7 files, 450 LOC)
│   │   ├── api.ts                   # ApiResponse envelope, WebSocket message types
│   │   ├── chat.ts                  # Session, Message, ChatEvent types
│   │   ├── config.ts                # Config schema
│   │   ├── database.ts              # DatabaseAdapter, DbConnectionConfig, DbTableInfo, etc.
│   │   ├── git.ts                   # GitStatus, GitDiff, GitCommit types
│   │   ├── project.ts               # Project interface
│   │   └── terminal.ts              # Terminal types
│   └── web/                         # React frontend (Vite)
│       ├── main.tsx                 # React mount (<App> into #root)
│       ├── app.tsx                  # Root component (auth check, project load, theme)
│       ├── stores/                  # Zustand state stores (6 files)
│       │   ├── project-store.ts     # Active project, projects list, localStorage persistence
│       │   ├── tab-store.ts         # Tab facade, delegates to panel-store
│       │   ├── panel-store.ts       # Grid layout, panel creation/movement, keep-alive snapshots
│       │   ├── panel-utils.ts       # Layout algorithm helpers, grid manipulation
│       │   ├── file-store.ts        # File cache
│       │   └── settings-store.ts    # Theme, sidebar state, git view mode, device name
│       ├── hooks/                   # Custom React hooks (9 files)
│       │   ├── use-chat.ts          # Chat streaming, messages, approvals, context window tracking
│       │   ├── use-websocket.ts     # WebSocket connection with auto-reconnect
│       │   ├── use-terminal.ts      # Terminal connection and streaming
│       │   ├── use-url-sync.ts      # Sync browser URL with active project/tab state
│       │   ├── use-tab-drag.ts      # Tab drag-and-drop logic
│       │   ├── use-global-keybindings.ts # Global shortcuts (Shift+Shift palette, Alt+[/] tab cycling)
│       │   ├── use-health-check.ts  # Detect server crashes/restarts via health endpoint
│       │   ├── use-usage.ts         # Fetch token usage from backend
│       │   └── use-push-notification.ts # Web push notifications via Service Worker
│       ├── lib/                     # Utilities (12 files)
│       │   ├── api-client.ts        # Fetch wrapper with auth token, envelope unwrapping
│       │   ├── api-settings.ts      # AI settings API client (GET/PUT /api/settings/ai)
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
│           ├── editor/              # Code editor (800+ LOC, 6 files)
│           │   ├── code-editor.tsx  # Monaco Editor integration (@monaco-editor/react, v2.0+)
│           │   ├── diff-viewer.tsx  # Monaco diff viewer for git diffs (v2.0+)
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
│           │   ├── editor-panel.tsx  # Wrapper for tab content within a panel
│           │   ├── project-bar.tsx   # 52px sidebar with project avatars, share popover
│           │   ├── project-bottom-sheet.tsx # Mobile project switcher
│           │   ├── sidebar.tsx       # Left sidebar (Explorer/Git/Database/Settings tabs)
│           │   ├── tab-bar.tsx       # Tab bar with icons, connection color display
│           │   ├── draggable-tab.tsx  # Draggable tab with context menu, rename, connection color
│           │   ├── tab-content.tsx    # Router for tab content
│           │   ├── split-drop-overlay.tsx # Drop zone for tab splitting
│           │   ├── command-palette.tsx # Global command palette (Shift+Shift, DB table search)
│           │   ├── add-project-form.tsx # Modal form to add projects
│           │   ├── mobile-nav.tsx    # Bottom navigation for mobile
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
│   │   └── services/                # Chat, config, db, session-log, push-notification tests
│   └── integration/
│       ├── claude-agent-sdk-integration.test.ts
│       ├── sqlite-migration.test.ts # SQLite migration validation
│       ├── api/                     # Chat route tests
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

## Critical Types

| Type | Location | Purpose |
|---|---|---|
| `ApiResponse<T>` | types/api.ts | Standard envelope for all REST responses |
| `AIProvider` | providers/provider.interface.ts | Interface for AI model adapters |
| `ChatEvent` | types/chat.ts | Union of streaming message types |
| `GitStatus` | types/git.ts | Current branch, staged, unstaged, untracked files |
| `Session` | types/chat.ts | Chat session with ID, projectName, title, createdAt |
| `Project` | types/project.ts | Project config (name, path) |

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

## Testing Strategy

| Test Type | Location | Coverage |
|-----------|----------|----------|
| Unit | tests/unit/ | Services, utilities |
| Integration | tests/integration/ | API routes, WebSocket |
| E2E | None yet | Planned for v3 |

