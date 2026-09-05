# PPM Code Standards & Conventions

> PPM-specific implementation patterns (CLI design, tab IDs and URLs, the provider pattern) live in
> [code-patterns.md](code-patterns.md).

## File Naming

| File Type | Convention | Example | Purpose |
|-----------|-----------|---------|---------|
| CLI commands | kebab-case | `start-cmd.ts`, `init.ts` | Descriptive command names |
| Services | kebab-case | `chat.service.ts`, `file.service.ts` | `{feature}.service.ts` pattern |
| Providers | kebab-case | `claude-agent-sdk.ts`, `mock-provider.ts` | `{name}-provider.ts` or `{name}.ts` |
| Routes | kebab-case | `chat.ts`, `project-scoped.ts` | Describe HTTP route group |
| WebSocket | kebab-case | `chat.ts`, `terminal.ts` | Match feature area |
| Components | PascalCase | `ChatTab.tsx`, `FileTree.tsx` | React convention |
| Hooks | camelCase with `use` prefix | `useChat.ts`, `useTerminal.ts` | React hook convention |
| Stores | kebab-case | `chat-store.ts`, `project-store.ts` | Zustand store files |
| Utilities | kebab-case | `utils.ts`, `file-support.ts` | Grouped by function |
| Types | kebab-case | `api.ts`, `chat.ts` | Group related types together |
| Tests | kebab-case with `.test.ts` | `chat.service.test.ts` | Match source file name |

## TypeScript Conventions

### Strict Mode
All files use TypeScript strict mode (`tsconfig.json` `"strict": true`).

```typescript
// Required:
- Explicit return types on functions
- No `any` types (use `unknown` if necessary)
- No implicit `any` parameters
- Exhaustive type checking (switch, conditionals)
```

### Path Aliases
Use `@/*` alias for web layer imports (configured in `tsconfig.json`):

```typescript
// Good
import { useChat } from "@/hooks/use-chat";
import { chatStore } from "@/stores/chat-store";

// Avoid
import { useChat } from "../../hooks/use-chat";
```

### Type Definitions
Place types near usage. Group related types in single files:

```typescript
// Good: src/types/chat.ts
export interface Session { id: string; title: string; }
export interface Message { id: string; content: string; role: "user" | "assistant"; }
export type ChatEvent = { type: "text"; content: string } | { type: "done" };

// Avoid: spread across separate files
```

### Enums & Unions
Prefer discriminated unions over enums for better tree-shaking:

```typescript
// Good: Discriminated union
type ChatEvent =
  | { type: "text"; content: string }
  | { type: "tool_use"; tool: string; input: unknown }
  | { type: "done" };

// Avoid: Enum
enum MessageType {
  TEXT,
  TOOL_USE,
  DONE,
}
```

### Async/Await
Always use `async`/`await` over Promise chains. Use async generators for streaming:

```typescript
// Good: Async generator for streaming
async *streamMessages(input: string) {
  for await (const event of provider.sendMessage(input)) {
    yield event;
  }
}

// Avoid: Promise chains
provider.sendMessage(input).then(...)
```

### Long-Lived Streaming Sessions

For chat-like features, maintain persistent streaming sessions instead of per-query execution:

```typescript
// Good: Session-scoped streaming (v0.8.55+)
// Provider maintains AsyncGenerator per session
const streaming = provider.sendMessage(sessionId, content);
for await (const event of streaming) {
  // Handle event (can receive multiple messages from same generator)
  yield event;
}

// Avoid: Per-message query execution
for (const message of messages) {
  const result = await query(message); // Restarts SDK each time
  yield result;
}

// Key Pattern: Decoupled streaming loop
// Store streaming generator in session entry
// Follow-up messages push into existing generator
// FE disconnect ≠ abort (BE owns the connection)
```

### Error Handling
Use try-catch for async operations. Throw structured errors:

```typescript
// Good
try {
  const file = await FileService.read(path);
} catch (error) {
  const message = error instanceof Error ? error.message : "Unknown error";
  console.error(`Failed to read ${path}: ${message}`);
  throw new Error(`FileService.read failed: ${message}`);
}

// Avoid: Silent failures
const file = await FileService.read(path).catch(() => null);
```

## Component Patterns

### React Components
Use functional components with hooks. Keep components focused:

```typescript
// Good: Single responsibility
export function ChatTab() {
  const { messages, sendMessage } = useChat();
  return <div>/* Chat UI */</div>;
}

// Avoid: God component
export function ChatTab() {
  // File management, git status, terminal, chat
}
```

### Zustand Stores (useShallow)
Define stores as singleton exports. Use `useShallow` when destructuring state to prevent unnecessary re-renders:

```typescript
// Good: src/web/stores/chat-store.ts
export const chatStore = create<ChatState>((set) => ({
  messages: [],
  addMessage: (msg) => set((state) => ({ messages: [...state.messages, msg] })),
}));

// Usage with useShallow (avoids full re-render on object mutations)
const { messages, addMessage } = chatStore(useShallow((state) => ({
  messages: state.messages,
  addMessage: state.addMessage,
})));

// Single selector still works without useShallow
const messages = chatStore((state) => state.messages);
```

### Component Memoization (React.memo)
Memoize expensive components to prevent re-renders from parent updates:

```typescript
// Good: Memoized heavy component
export const CodeEditor = memo(function CodeEditor({ filePath }: Props) {
  return <MonacoEditor path={filePath} />;
});

// Memoized components: CodeEditor, MessageBubble, ProjectBar, ProjectAvatar, TerminalTab, PanelLayout, Sidebar, StatusBar, StatusBarEntry, TabBar, TreeNode
```

### Custom Hooks
Extract logic into hooks for reusability. Return stable references:

```typescript
// Good: useChat hook
export function useChat() {
  const [messages, setMessages] = useState<Message[]>([]);

  const sendMessage = useCallback(async (text: string) => {
    // Send logic
  }, []);

  return { messages, sendMessage };
}
```

### Lazy-Loaded Tab Content
Use React.lazy() for code splitting:

```typescript
// Good
const ChatTab = lazy(() => import("./chat-tab").then(m => ({ default: m.ChatTab })));

// In component
<Suspense fallback={<Spinner />}>
  <ChatTab />
</Suspense>
```

Every tab is additionally wrapped in a stable-container `createPortal` (`ReparentingTab`,
`src/web/components/layout/reparenting-tab.tsx`): the wrapper `div` is created once and never
replaced, so the portal never remounts the tab — that is what lets a panel move, split, dock, or
detach into a floating window/PiP without losing xterm scrollback, Monaco undo history, or a chat
stream. A tab's actual React ancestor is `ReparentingTab`, not whatever panel currently renders its
slot — a provider meant to reach a tab's content (e.g. a portal-container context) must be mounted
there, not around the panel/window body.

## Service Patterns

### Singleton Services
Services are singletons exported as functions or instances:

```typescript
// Good: services/chat.service.ts
export async function createSession(projectPath: string): Promise<Session> {
  // Shared logic across all callers
}

// Good: services/config.service.ts — config lives in SQLite, not a file
export const configService = {
  load: () => readConfigRows(getDb()),
  get: (key) => configCache[key],
  set: (key, value) => upsertConfigRow(getDb(), key, value),
};
```

### Dependency Injection
Services should receive dependencies as parameters or imports:

```typescript
// Good: Pass dependencies explicitly
export async function streamChat(
  session: Session,
  message: string,
  provider: AIProvider,  // Dependency
) {
  // Use provider
}

// Avoid: Implicit globals
import { globalProvider } from "./global"; // Hidden dependency
```

### Error Propagation
Services throw descriptive errors; routes catch and format:

```typescript
// Good: Service throws
export function validatePath(path: string) {
  if (path.includes("..")) {
    throw new Error(`Path traversal detected: ${path}`);
  }
}

// Good: Route catches and formats
try {
  const content = await FileService.read(path);
  res.json(ok(content));
} catch (error) {
  const msg = error instanceof Error ? error.message : "Unknown";
  res.json(err(msg));
  res.status(400);
}
```

### Query Audit Logging (Non-Breaking Pattern)

Query audit logs every SQL statement to a separate database (`~/.ppm/query-audit.db`), recording source (editor, grid, cli, filter), actor (human vs agent), operation type, and sample result rows. **Critical:** audit failures must never break a user query.

**Pattern** (`routes/database.ts`, `routes/sqlite.ts`):
```typescript
const startedAt = Date.now();
// Build the audit shape once — the blocked, ok and error branches all reuse it.
const audit = {
  ...connAudit(conn),                 // connectionId + connectionName + dbType
  source: "editor" as const,
  operation: detectOperation(body.sql),
  sql: body.sql,
};

if (conn.readonly && !isReadOnlyQuery(body.sql)) {
  logQuery(c, { ...audit, status: "blocked", error: message, durationMs: Date.now() - startedAt });
  return c.json(err(message), 403);
}

try {
  const result = await adapter.executeQuery(config, body.sql);
  logQuery(c, {
    ...audit,
    status: "ok",
    rows: result.rows,                // pass them all; truncateResult does the sampling
    rowCount: result.changeType === "select" ? result.rows.length : result.rowsAffected,
    durationMs: Date.now() - startedAt,
  });
  return c.json(ok(result));
} catch (e) {
  logQuery(c, { ...audit, status: "error", error: (e as Error).message, durationMs: Date.now() - startedAt });
  throw e;                            // outer catch produces the usual 500
}
```

`logQuery()` swallows its own failures and reports them through an `x-ppm-audit-error` response header, which `api-client.ts` turns into one toast per session. CLI paths call `logCliQuery()` instead — same rows with `source`/`actor` = `"cli"`, warning on stderr.

**Implementation Details:**
- `x-ppm-client: "web"` header (set by api-client.ts) determines `actor` (human vs agent). Client-supplied, so treat it as a hint, not attribution.
- Result sample = first 5 + last 5 rows sharing ONE 16KB budget (not 16KB each). `sql` and `params_json` are separately capped at 16KB.
- **PRAGMA auto_vacuum = INCREMENTAL must be set before the first CREATE TABLE** — otherwise deleted rows never return disk space and `incremental_vacuum` reclaims nothing (measured: 48.3MB stayed 48.3MB without it, dropped to 8.1MB with it).
- `source` values: `"editor"` (user-typed SQL), `"grid"` (cell/row mutations), `"cli"`, `"filter"` (column-filter UI, which reuses the `/query` endpoint).
- Browsing routes (`/tables`, `/schema`, `/data`) are intentionally NOT logged.

**Files:** `src/services/query-audit/`, `src/server/routes/query-audit-hook.ts`, `src/cli/commands/db-cmd-audit.ts`

### Provider Interface Pattern (Multi-Provider)

PPM supports multiple AI providers through an extensible interface pattern:

```typescript
// Core interface defines required methods + optional capability methods
interface AIProvider {
  id: string;
  name: string;

  // Required: All providers must implement these
  createSession(config: SessionConfig): Promise<Session>;
  resumeSession(sessionId: string): Promise<Session>;
  listSessions(): Promise<SessionInfo[]>;
  deleteSession(sessionId: string): Promise<void>;
  sendMessage(sessionId: string, message: string, opts?: SendMessageOpts): AsyncIterable<ChatEvent>;

  // Optional: Providers implement what they support
  abortQuery?(sessionId: string): void;
  getMessages?(sessionId: string): Promise<ChatMessage[]>;
  listSessionsByDir?(dir: string): Promise<SessionInfo[]>;
  ensureProjectPath?(sessionId: string, path: string): void;
  isAvailable?(): Promise<boolean>;
}
```

**SDK-based Providers (Claude):**
- Use Anthropic SDK for advanced features
- Implement all optional methods
- Streaming via SDK async generators

**CLI-based Providers (Cursor, Codex, Gemini):**
- Extend `CliProvider` abstract class
- Implement: `buildArgs()`, `mapEvent()`, `extractSessionId()`, `isAvailable()`
- Shared: spawn, parse NDJSON, abort, cleanup
- Override `spawnProcess()` for provider-specific quirks (e.g., workspace trust)
- Override `listSessions()` to read native provider history (e.g., SQLite)

**Usage Pattern (Type-Safe Optional Calls):**
```typescript
// Good: Optional chaining for capabilities
await provider.abortQuery?.(sessionId); // Silently skips if not implemented
const messages = await provider.getMessages?.(sessionId) ?? [];

// Avoid: Duck-typing checks (old pattern)
if ("abortQuery" in provider) {
  (provider as any).abortQuery(sessionId); // Not type-safe
}
```

**Adding New Providers:**
1. Create provider class implementing/extending AIProvider or CliProvider
2. Implement `isAvailable()` for optional registration
3. Register in `ProviderRegistry` via `bootstrapProviders()` if binary available
4. Add event mapper if CLI-based (NDJSON → ChatEvent)
5. ~100-150 lines per provider (extends CliProvider)

## API Conventions

### Response Envelope
All REST responses use the `ApiResponse<T>` envelope:

```typescript
// Good
{ ok: true, data: { /* payload */ } }
{ ok: false, error: "descriptive error message" }

// Avoid: Inconsistent shapes
{ success: true, result: { } }
{ error: "error message" } // No shape contract
```

### Project-Scoped Routes
All project-specific endpoints use the pattern `/api/project/:name/*`:

```
GET    /api/projects                  # List all projects
POST   /api/projects                  # Create project
DELETE /api/projects/:name            # Delete project
GET    /api/project/:name/chat/...    # Chat (project-scoped)
GET    /api/project/:name/git/...     # Git (project-scoped)
GET    /api/project/:name/files/...   # Files (project-scoped)
```

### WebSocket Message Formats
Structure WebSocket messages as typed JSON objects:

```typescript
// Client -> Server (chat, v0.8.55+)
{ type: "message"; content: string; priority?: "now"|"next"|"later"; images?: {id: string; data: string}[] }
{ type: "cancel" }
{ type: "approval_response"; requestId: string; approved: boolean; reason?: string; data?: unknown }
{ type: "ready" }  // FE handshake after WS open

// Server -> Client (chat)
{ type: "text"; content: string; parentToolUseId?: string }
{ type: "thinking"; content: string; parentToolUseId?: string }
{ type: "tool_use"; tool: string; input: unknown; toolUseId?: string; parentToolUseId?: string }
{ type: "tool_result"; output: string; isError?: boolean; toolUseId?: string; parentToolUseId?: string }
{ type: "approval_request"; requestId: string; tool: string; input: unknown }
{ type: "done"; sessionId: string; contextWindowPct?: number; resultSubtype?: string }
{ type: "error"; message: string }
{ type: "account_info"; accountId: string; accountLabel: string }
{ type: "phase_changed"; phase: SessionPhase; elapsed?: number }
{ type: "session_state"; sessionId: string; phase: SessionPhase; pendingApproval: {...}|null; sessionTitle: string|null }
{ type: "turn_events"; events: unknown[] }  // Buffered events on reconnect
{ type: "title_updated"; title: string }
{ type: "ping" }  // Server keepalive
```

**New Fields (v0.8.55+):**
- `priority` — Message priority for queue ordering (future: "now" interrupts, "next" queues first, "later" queues at end)
- `images` — Image attachments sent with message
- `phase_changed` — Phase transitions (initializing → connecting → thinking/streaming → idle)
- `session_state` — Session state snapshot on WS open/ready (includes current phase and pending approval)
- `turn_events` — Buffered events sent on reconnection for sync
- `parentToolUseId` — Hierarchical tool call support (nested tool results)

### Status Codes
Use standard HTTP status codes:

```typescript
// Success
200 OK           - GET successful, POST/PUT/DELETE with response body
201 Created      - POST created resource
204 No Content   - DELETE successful

// Client error
400 Bad Request  - Invalid input, validation failure
401 Unauthorized - Missing/invalid auth token
403 Forbidden    - Authenticated but not authorized (rare in PPM)
404 Not Found    - Project/file/session not found

// Server error
500 Internal Error - Unexpected exception
```

## Import/Export Conventions

### Named Exports (Preferred)
Use named exports for better tree-shaking and clarity:

```typescript
// Good: services/file.service.ts
export async function read(path: string): Promise<string> { }
export async function write(path: string, content: string): Promise<void> { }

// Usage
import { read, write } from "./services/file.service";
```

### Default Exports (React Components Only)
Use default exports for React components (enables lazy loading):

```typescript
// Good: components/chat/chat-tab.tsx
export default function ChatTab() { }

// Usage
const ChatTab = lazy(() => import("./components/chat/chat-tab"));
```

### Wildcard Imports (Avoid)
Avoid wildcard imports except for types:

```typescript
// Good: Explicit imports
import { send, receive } from "./ws-client";

// Good: Type wildcard (rare)
import type * as Types from "./types";

// Avoid: Implicit exports
import * as WsClient from "./ws-client";
WsClient.send(); // Unclear what's exported
```

## Error Handling Patterns

### Service Layer
Throw descriptive errors with context:

```typescript
// Good
throw new Error(`GitService.commit failed: ${error.message}`);
throw new Error(`FileService: path traversal detected: ${path}`);

// Avoid: Generic errors
throw new Error("Failed");
throw error; // Re-throw loses context
```

### Route Layer
Catch, format, and return `ApiResponse` with error:

```typescript
// Good
try {
  const result = await service.doSomething();
  return res.json(ok(result));
} catch (error) {
  const message = error instanceof Error ? error.message : "Unknown error";
  res.status(400);
  return res.json(err(message));
}
```

### Component Layer
Handle errors from API calls with user-friendly messages:

```typescript
// Good
try {
  const response = await api.post("/...");
  if (!response.ok) {
    setError(response.error);
    return;
  }
  setState(response.data);
} catch (error) {
  setError("Network error. Please try again.");
}
```

## Testing Conventions

### Test File Location
Tests colocate with source files or in `tests/` directory:

```
src/services/chat.service.ts
tests/unit/services/chat.service.test.ts  ← Match path, add .test suffix

src/web/hooks/use-chat.ts
tests/unit/hooks/use-chat.test.ts
```

### Test Structure
Use AAA pattern (Arrange, Act, Assert):

```typescript
describe("ChatService", () => {
  it("should create session with unique ID", () => {
    // Arrange
    const projectPath = "/tmp/project";

    // Act
    const session = ChatService.createSession(projectPath);
    const session2 = ChatService.createSession(projectPath);

    // Assert
    expect(session.id).not.toBe(session2.id);
  });
});
```

### Mocking
Mock external dependencies (providers, file system):

```typescript
// Good: Mock provider
const mockProvider = {
  createSession: () => ({ id: "test-id" }),
  sendMessage: async function*() { yield { type: "text", content: "response" }; },
};

// Avoid: Mock implementation details
jest.spyOn(fs, "readFile").mockResolvedValue("content");
```

## Security Conventions

### Path Traversal Protection
Always validate file paths before operations:

```typescript
// Good: Validate before file access
export function validatePath(path: string) {
  const normalized = Path.normalize(path);
  if (normalized.startsWith("..")) {
    throw new Error("Path traversal detected");
  }
  if (!normalized.startsWith(projectPath)) {
    throw new Error("Access denied: outside project directory");
  }
}
```

### Token-Based Auth
Every API route requires token validation via middleware:

```typescript
// Good: Middleware validates token
app.use("/api", authMiddleware);

// In middleware
const token = req.header("Authorization");
if (!token || token !== config.auth.token) {
  res.status(401);
  res.json(err("Unauthorized"));
}
```

### Input Validation
Validate all user input (file paths, command arguments, message content):

```typescript
// Good: Validate before processing
if (!path || typeof path !== "string") {
  throw new Error("Invalid path");
}

if (message.length > 10000) {
  throw new Error("Message too long");
}
```

## Documentation Conventions

### Inline Comments
Use comments for **why**, not **what**. Let code speak for itself:

```typescript
// Good: Explain intent
// Expand node lazily to avoid blocking on large directories
async function loadChildren(node: TreeNode) {
  // ...
}

// Avoid: Obvious comments
// Set messages to empty array
const [messages, setMessages] = useState([]);
```

### JSDoc for Public APIs
Document exported functions with JSDoc:

```typescript
/**
 * Stream chat messages from AI provider.
 *
 * @param sessionId - Chat session ID
 * @param message - User message text
 * @param provider - AI provider (defaults to registry.default)
 * @yields ChatEvent objects (text, tool_use, approval_request, done)
 * @throws Error if session not found or provider fails
 */
export async *streamMessages(
  sessionId: string,
  message: string,
  provider?: AIProvider,
) {
  // ...
}
```

### Type Comments
Use type comments for complex types:

```typescript
// File status with git tracking info
type FileStatus =
  | { status: "modified" }
  | { status: "untracked" }
  | { status: "staged"; originalPath?: string };
```

## Performance Conventions

### Code Splitting
Use `React.lazy()` + `Suspense` for routes, tab components, and heavy renderers:

```typescript
// Good: Lazy-load terminal component
const TerminalTab = lazy(() => import("./terminal-tab"));

// Good: Lazy-load markdown renderer on 3+ sites
const MarkdownRenderer = lazy(() => import("./markdown-renderer"));
```

### Vendor Chunk Splitting (vite.config.ts)
Manually split large vendor libraries into separate chunks for better caching:

```typescript
// Chunks: vendor-monaco, vendor-mermaid, vendor-xterm, vendor-markdown, vendor-ui
manualChunks(id: string) {
  if (id.includes("node_modules/monaco-editor")) return "vendor-monaco";
  if (id.includes("node_modules/mermaid")) return "vendor-mermaid";
  if (id.includes("node_modules/@xterm")) return "vendor-xterm";
  // ... etc
}
```

### Dynamic Imports (On-Demand Loading)
Load heavy libraries only when needed:

```typescript
// Good: Mermaid diagram support on-demand in markdown
let mermaidPromise: Promise<typeof import("mermaid")> | null = null;
async function loadMermaid() {
  if (!mermaidPromise) {
    mermaidPromise = import("mermaid").then((mod) => mod.default);
  }
  return mermaidPromise;
}
```

### Chat Pagination & Message Caps
- **Chat history:** Load 50 messages per page with load-more button
- **Team activity:** Cap `teamActivityRef` at 500 messages to prevent unbounded growth

### Memoization
Memoize expensive computations and callbacks:

```typescript
// Good: Memoize filter result
const filteredFiles = useMemo(
  () => files.filter(f => f.name.includes(query)),
  [files, query]
);

// Good: Stable callback reference
const handleClick = useCallback(() => {
  // ...
}, [dependencies]);
```

### Bundle Analysis
Monitor bundle size growth:

```bash
# Check bundle stats
bun run build && ls -lh dist/web/assets/
```

## Git Conventions

### Commit Messages
Use conventional commit format:

```
feat: add file attachment support to chat
fix: resolve WebSocket reconnection issue
refactor: simplify GitService.status method
docs: update deployment guide
test: add chat-service unit tests
chore: upgrade TypeScript to 5.9.3
```

### Branch Names
Use descriptive kebab-case names:

```
feature/chat-file-attachments
fix/websocket-reconnect
refactor/service-layer-cleanup
docs/deployment-guide
```

