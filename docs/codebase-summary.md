# PPM Codebase Summary

**Last Updated:** 2026-03-26
**Version:** 0.8.60
**Repository:** PPM (Project & Process Manager) — Multi-provider web IDE/project manager with Claude Agent SDK

**Core Statistics:**
- **303 files** across CLI, server, web, and test layers
- **490,667 tokens** total codebase size
- **492 passing tests** (13 new tests for provider models API)
- **Tech Stack:** Bun (runtime), Hono (HTTP), React (UI), Claude Agent SDK (AI)

---

## Directory Structure

```
src/
├── cli/
│   ├── commands/                # 14 CLI commands (start, stop, init, config, chat, db, git, ext, etc.)
│   │   └── ext-cmd.ts           # Extension CLI (install/remove/list/enable/disable/dev)
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
│   ├── extension.service.ts     # Extension lifecycle, activation, state management
│   ├── extension-installer.ts   # npm install, symlink, removal
│   ├── extension-manifest.ts    # Parse + discover manifests
│   ├── extension-rpc.ts         # RPC channel (request/response/events)
│   ├── extension-host-worker.ts # Worker-side extension loading
│   ├── contribution-registry.ts # Central registry for commands, views, config
│   ├── database/
│   │   ├── adapter-registry.ts  # SQLite/Postgres adapter registry
│   │   ├── sqlite-adapter.ts
│   │   ├── postgres-adapter.ts
│   │   └── readonly-check.ts    # CTE-safe readonly validation
│   └── ... (20+ other services)
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
│   ├── project.ts
│   └── terminal.ts
└── web/                         # React frontend (Vite + React 18)
    ├── app.tsx                  # Root component
    ├── stores/                  # Zustand state (6 stores)
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
    │   │   └── mcp-server-dialog.tsx    # ADDED: Add/Edit MCP server dialog
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

---

## Recent Changes (v0.8.60+)

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

