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
│  │  ┌──────────────────┐  ┌──────────────────┐  ┌─────────────┐  │   │
│  │  │ /api/projects    │  │ /api/project/:n/ │  │ /api/health │  │   │
│  │  │ (CRUD projects)  │  │ (scoped routes)  │  │   (status)  │  │   │
│  │  └──────────────────┘  └──────────────────┘  └─────────────┘  │   │
│  ├────────────────────────────────────────────────────────────────┤   │
│  │  Services (src/services/)                                      │   │
│  │  ┌───────────────────────────────────────────────────────────┐│   │
│  │  │ ChatService │ GitService │ FileService │ TerminalService ││   │
│  │  │ (streaming  │ (simple-   │ (read/write │ (PTY/shell)     ││   │
│  │  │  messages)  │  git)      │  files)     │ (Bun.spawn)     ││   │
│  │  └───────────────────────────────────────────────────────────┘│   │
│  ├────────────────────────────────────────────────────────────────┤   │
│  │  Providers (src/providers/)                                    │   │
│  │  ┌──────────────────────────────────────────────────────────┐ │   │
│  │  │ ProviderRegistry (routes to active AI provider)         │ │   │
│  │  │ ┌───────────────────────┬──────────────────────────┐   │ │   │
│  │  │ │ claude-agent-sdk      │ claude-code-cli (CLI)   │   │ │   │
│  │  │ │ @anthropic/SDK (prim) │ Fallback subprocess    │   │ │   │
│  │  │ └───────────────────────┴──────────────────────────┘   │ │   │
│  │  └──────────────────────────────────────────────────────────┘ │   │
│  └────────────────────────────────────────────────────────────────┘   │
│                                                                        │
│  Config & State (src/services/)                                       │
│  ┌──────────────────┐  ┌──────────────────┐  ┌─────────────────┐    │
│  │ ppm.yaml         │  │ Git Repos        │  │ Session Storage │    │
│  │ (projects list)  │  │ (local disk)     │  │ (in-memory only)│    │
│  │ (auth token)     │  │                  │  │                 │    │
│  └──────────────────┘  └──────────────────┘  └─────────────────┘    │
└──────────────────────────────────────────────────────────────────────┘
        ↓↑
   ┌────────────────────────────────────────────────┐
   │  Filesystem Access (Local Only)                │
   │  • Project directories (git repos)             │
   │  • File read/write operations                  │
   │  • Config file (ppm.yaml)                      │
   └────────────────────────────────────────────────┘
```

## Layer Descriptions

### Presentation Layer (Browser/CLI)
**Components:** React frontend + CLI commands

**Responsibilities:**
- Render UI for file explorer, editor, terminal, chat
- Capture user input (text, file uploads, terminal commands)
- Display streaming responses, terminal output
- Handle authentication (token in localStorage)

**Key Files:**
- `src/web/app.tsx` — Root React component
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
POST   /api/projects            → Create project
GET    /api/projects            → List projects
DELETE /api/projects/:name      → Delete project
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
| **GitService** | Git command execution | status, diff, commit, stage, branch |
| **FileService** | File operations with validation | read, write, tree, delete, mkdir |
| **TerminalService** | PTY lifecycle, shell spawning | spawn, write, kill |
| **ProjectService** | Project registry (YAML) | add, remove, get, list |
| **ConfigService** | Config file management | load, save, getToken |
| **ProviderRegistry** | AI provider routing | getDefault, send (delegates) |

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
- **claude-agent-sdk** (Primary) — @anthropic-ai/claude-agent-sdk, streaming, tool use
- **claude-code-cli** (Fallback) — Claude CLI subprocess, for offline environments
- **mock-provider** (Testing) — Returns canned responses

---

### Data Access Layer (Filesystem + Git)
**Components:** Direct filesystem access, simple-git wrapper

**Responsibilities:**
- Read/write project files with path validation
- Execute git commands via simple-git
- Cache directory listings
- Enforce security (no parent directory access)

**Key Patterns:**
- Path validation: `projectPath/relativePath` only, reject `..`
- Caching: Directory trees cached with TTL
- Error handling: Descriptive messages (file not found, permission denied)

---

### State Management (Frontend)
**Component:** Zustand stores in browser

**Stores:**
- **projectStore** — Active project, project list
- **tabStore** — Open tabs (chat, editor, git, terminal)
- **fileStore** — Selected files, editor content
- **settingsStore** — Auth token, theme preference

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

## Deployment Architecture

### Single-Machine Deployment (Current)
```
Linux/macOS Host
  ├── ppm (compiled binary)
  │   └── Embeds: server code, frontend assets
  ├── ppm.yaml (config, auto-generated)
  └── ~/.ppm/ (optional: session cache, logs)
```

### Daemon Mode (Optional)
```
$ ppm start --daemon
  → Background process (nohup or systemd)
  → Logs to ~/.ppm/server.log
  → PID saved to ~/.ppm/server.pid

$ ppm stop
  → Reads PID
  → Sends SIGTERM
  → Graceful shutdown (close WS, cleanup PTY)
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

