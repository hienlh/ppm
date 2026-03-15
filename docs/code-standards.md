# PPM Code Standards & Conventions

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

### Zustand Stores
Define stores as singleton exports. Use selectors to subscribe to specific state:

```typescript
// Good: src/web/stores/chat-store.ts
export const chatStore = create<ChatState>((set) => ({
  messages: [],
  addMessage: (msg) => set((state) => ({ messages: [...state.messages, msg] })),
}));

// Usage with selector (avoids full re-render)
const messages = chatStore((state) => state.messages);
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

## Service Patterns

### Singleton Services
Services are singletons exported as functions or instances:

```typescript
// Good: services/chat.service.ts
export async function createSession(projectPath: string): Promise<Session> {
  // Shared logic across all callers
}

// Good: services/config.service.ts
export const ConfigService = {
  load: () => YAML.parse(configFile),
  save: (config) => YAML.stringify(config),
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
// Client -> Server (chat)
{ type: "message"; content: string }
{ type: "cancel" }
{ type: "approval_response"; requestId: string; approved: boolean }

// Server -> Client (chat)
{ type: "text"; content: string }
{ type: "tool_use"; tool: string; input: unknown }
{ type: "approval_request"; requestId: string; tool: string; input: unknown }
{ type: "done"; sessionId: string }
{ type: "error"; message: string }
```

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
Use React.lazy() for routes and heavy components:

```typescript
// Good: Lazy-load terminal component
const TerminalTab = lazy(() => import("./terminal-tab"));
```

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

## CLI Design Patterns

### Command Option Handling
When adding new options to CLI commands (e.g., `ppm start`):

**Option Naming:**
- Use long form: `--foreground`, `--share` (not short-only)
- Add short form if common: `-f`, `-s` (optional)
- Keep defaults sensible (e.g., daemon mode is default)

**Implementation Pattern:**
```typescript
program
  .command("start")
  .option("-p, --port <port>", "Port to listen on")
  .option("-f, --foreground", "Run in foreground")
  .option("-s, --share", "Enable public URL via tunnel")
  .action(async (options) => {
    // options.port, options.foreground, options.share as booleans
  });
```

**Server Handling:**
```typescript
export async function startServer(options: {
  port?: string;
  foreground?: boolean;
  share?: boolean;
  config?: string;
}) {
  const isDaemon = !options.foreground; // Explicit: daemon is default

  if (isDaemon) {
    // Spawn child process
    const child = Bun.spawn(/* ... */);
    // Poll for status.json, show URLs
  } else {
    // Foreground: serve with logs
    const server = Bun.serve(/* ... */);
  }

  if (options.share) {
    // Start tunnel (works in both daemon + foreground)
  }
}
```

### Status File Format
Daemon process communicates back via JSON file at `~/.ppm/status.json`:

```json
{
  "pid": 12345,
  "port": 8080,
  "host": "0.0.0.0",
  "shareUrl": "https://abc-123.trycloudflare.com"
}
```

**Backward Compatibility:** Fallback to `~/.ppm/ppm.pid` for legacy support.

### Feature Service Loading (Lazy)
Services that require external dependencies (e.g., cloudflared) should be lazy-imported:

```typescript
if (options.share) {
  // Only download cloudflared if --share was used
  const { ensureCloudflared } = await import("../services/cloudflared.service.ts");
  await ensureCloudflared();
}
```

This keeps startup fast when features aren't used.

