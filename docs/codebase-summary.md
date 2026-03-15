# PPM Codebase Summary

Generated from repomix analysis of 96 TypeScript files, 14K LOC, 194K tokens.

## Directory Structure

```
ppm/
├── src/
│   ├── index.ts                     # CLI entry point (Commander.js program)
│   ├── cli/
│   │   ├── commands/                # CLI command implementations (8 files, 907 LOC)
│   │   │   ├── start.ts             # Start server (Hono + Bun.serve)
│   │   │   ├── stop.ts              # Stop daemon (graceful shutdown)
│   │   │   ├── open.ts              # Open browser to http://localhost:PORT
│   │   │   ├── init.ts              # Initialize ppm.yaml config (scan git repos)
│   │   │   ├── projects.ts          # Add/remove/list projects
│   │   │   ├── config-cmd.ts        # View/set config values
│   │   │   ├── git-cmd.ts           # Git operations (status, diff, log, commit)
│   │   │   └── chat-cmd.ts          # Chat CLI (send messages, manage sessions)
│   │   └── utils/
│   │       └── project-resolver.ts  # Resolve project name -> path
│   ├── server/
│   │   ├── index.ts                 # Hono server setup, Bun.serve, WebSocket upgrade
│   │   ├── middleware/
│   │   │   └── auth.ts              # Token validation middleware
│   │   ├── routes/
│   │   │   ├── projects.ts          # GET/POST /api/projects, DELETE /:name
│   │   │   ├── project-scoped.ts    # Mount chat, git, files under /api/project/:name/*
│   │   │   ├── chat.ts              # GET/POST/DELETE sessions, GET messages, usage, slash-items
│   │   │   ├── git.ts               # GET status, diff, log, graph; POST commit, stage, discard
│   │   │   ├── files.ts             # GET tree, read, diff; PUT write; POST mkdir, delete
│   │   │   └── static.ts            # Serve dist/web/index.html (frontend)
│   │   ├── helpers/
│   │   │   └── resolve-project.ts   # Helper to resolve project from request params
│   │   └── ws/
│   │       ├── chat.ts              # WebSocket chat streaming (220 LOC)
│   │       └── terminal.ts          # WebSocket terminal I/O (terminal.service.ts integration)
│   ├── providers/                   # AI Provider adapters (7 files, 1444 LOC)
│   │   ├── provider.interface.ts    # AIProvider interface (createSession, sendMessage, onToolApproval)
│   │   ├── claude-agent-sdk.ts      # Primary: @anthropic-ai/claude-agent-sdk (444 LOC)
│   │   ├── claude-code-cli.ts       # Fallback: claude CLI binary (412 LOC)
│   │   ├── mock-provider.ts         # Test provider
│   │   ├── claude-binary-finder.ts  # Find claude CLI in PATH
│   │   ├── claude-process-registry.ts # Track running claude processes
│   │   └── registry.ts              # ProviderRegistry (singleton, router to active provider)
│   ├── services/                    # Business logic (9 files, 1561 LOC)
│   │   ├── chat.service.ts          # Session lifecycle, message streaming, streaming to clients
│   │   ├── git.service.ts           # Git operations (372 LOC): status, diff, log, graph, branches
│   │   ├── file.service.ts          # File ops (261 LOC): tree, read, write, delete, mkdir, path validation
│   │   ├── project.service.ts       # YAML project registry (108 LOC)
│   │   ├── terminal.service.ts      # PTY management (200+ LOC), Bun.spawn native shell
│   │   ├── config.service.ts        # YAML config loading (91 LOC)
│   │   ├── slash-items.service.ts   # /slash command detection & completion
│   │   ├── claude-usage.service.ts  # Token usage via ccburn library
│   │   └── git-dirs.service.ts      # Cached git directory discovery
│   ├── types/                       # TypeScript interfaces (6 files, 258 LOC)
│   │   ├── api.ts                   # ApiResponse envelope, WebSocket message types
│   │   ├── chat.ts                  # Session, Message, ChatEvent types
│   │   ├── config.ts                # Config schema
│   │   ├── git.ts                   # GitStatus, GitDiff, GitCommit types
│   │   ├── project.ts               # Project interface
│   │   └── terminal.ts              # Terminal types
│   └── web/                         # React frontend (Vite)
│       ├── main.tsx                 # React mount (<App> into #root)
│       ├── app.tsx                  # Root component (auth check, project load, theme)
│       ├── stores/                  # Zustand state stores (4 files, 383 LOC)
│       │   ├── project-store.ts     # Active project, projects list
│       │   ├── tab-store.ts         # Open tabs (chat, editor, git, terminal)
│       │   ├── file-store.ts        # Open files, selections
│       │   └── settings-store.ts    # Theme, auth token
│       ├── hooks/                   # Custom React hooks (4 files, 716 LOC)
│       │   ├── use-chat.ts          # Chat streaming, WebSocket, message history (420 LOC)
│       │   ├── use-websocket.ts     # Generic WebSocket adapter
│       │   ├── use-terminal.ts      # Terminal I/O over WebSocket
│       │   └── use-url-sync.ts      # Sync state to URL (project, tab, file selections)
│       ├── lib/                     # Utilities (4 files, 264 LOC)
│       │   ├── api-client.ts        # Fetch wrapper with auth token
│       │   ├── ws-client.ts         # WebSocket wrapper
│       │   ├── file-support.ts      # File type detection (language -> icon)
│       │   └── utils.ts             # Utility functions (clsx, classname merging)
│       ├── styles/
│       │   └── globals.css          # Tailwind directives, custom CSS
│       └── components/              # React components (organized by feature)
│           ├── auth/                # Login screen (88 LOC)
│           ├── chat/                # Chat UI (2202 LOC, 9 files)
│           │   ├── chat-tab.tsx     # Main chat interface
│           │   ├── message-list.tsx # Scrollable messages with tool display
│           │   ├── message-input.tsx # Input with file attach, slash command picker
│           │   ├── session-picker.tsx # Switch between sessions
│           │   ├── usage-badge.tsx  # Token usage display
│           │   └── ... 4 more
│           ├── editor/              # Code editor (615 LOC, 3 files)
│           │   ├── code-editor.tsx  # CodeMirror integration
│           │   ├── diff-viewer.tsx  # Diff2HTML for git diffs
│           │   └── editor-placeholder.tsx
│           ├── explorer/            # File tree (489 LOC, 2 files)
│           │   ├── file-tree.tsx    # Directory tree view
│           │   └── file-actions.tsx # Create/delete/rename context menu
│           ├── git/                 # Git UI (1632 LOC, 3 files)
│           │   ├── git-status-panel.tsx # Status, staging UI
│           │   ├── git-graph.tsx    # Mermaid-based commit graph
│           │   └── git-placeholder.tsx
│           ├── layout/              # Layout components (567 LOC, 5 files)
│           │   ├── sidebar.tsx      # Left sidebar (project, file tree, sections)
│           │   ├── tab-bar.tsx      # Top tab bar (chat, editor, git, terminal)
│           │   ├── tab-content.tsx  # Router for tab content
│           │   ├── mobile-nav.tsx   # Mobile hamburger navigation
│           │   └── mobile-drawer.tsx # Offcanvas drawer
│           ├── projects/            # Project management (339 LOC, 2 files)
│           ├── settings/            # Settings panel (57 LOC)
│           ├── terminal/            # xterm.js wrapper (143 LOC, 2 files)
│           └── ui/                  # Radix + shadcn primitives (1018 LOC, 10 files)
│               └── button.tsx, dialog.tsx, dropdown-menu.tsx, ... (base components)
├── tests/
│   ├── test-setup.ts                # Disable auth for tests
│   ├── unit/
│   │   ├── providers/               # Mock provider, SDK tests
│   │   └── services/                # Chat service tests
│   └── integration/
│       ├── claude-agent-sdk-integration.test.ts
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
  - `start` — Start Hono server on configurable port
  - `stop` — Graceful shutdown of daemon process
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
- **Responsibility:** Business logic, data operations
- **Services:**
  - **ChatService** — Session lifecycle, message queueing, streaming
  - **GitService** — Git commands via simple-git
  - **FileService** — File ops with path validation
  - **ProjectService** — YAML registry management
  - **TerminalService** — PTY lifecycle, shell spawning
  - **ConfigService** — Config file loading
- **Pattern:** Singleton services, dependency injection via imports

### Provider Layer (src/providers/)
- **Responsibility:** AI model abstraction
- **Providers:**
  - **claude-agent-sdk** — Primary (official SDK, streaming, tool use)
  - **claude-code-cli** — Fallback (subprocess-based)
  - **mock** — Test provider
- **Interface:** Async generator streaming, tool approval callback
- **Pattern:** Registry pattern for pluggable AI providers

### Frontend Layer (src/web/)
- **Responsibility:** React UI for project management, chat, terminal, editor
- **Key Stores:**
  - **ProjectStore** — Active project, project list
  - **TabStore** — Open tabs per project
  - **FileStore** — File selections
  - **SettingsStore** — Auth, theme
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
| @uiw/react-codemirror | Code editor | 4.25.8 |
| xterm | Terminal emulator | 6.0 |
| zustand | State management | 5.0.11 |
| @anthropic-ai/claude-agent-sdk | AI provider | 0.2.76 |
| vite | Frontend bundler | 8.0 |
| tailwindcss | Utility CSS | 4.2 |
| radix-ui | Accessible components | 1.4.3 |
| next-themes | Theme switcher | 0.4.6 |

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

