# PPM Implementation Patterns

> Concrete, PPM-specific patterns. General language and style rules live in
> [code-standards.md](code-standards.md).

## CLI Design Patterns

### Command Option Handling
When adding new options to CLI commands (e.g., `ppm start`):

**Option Naming:**
- Use long form, with a short form only when it is common: `-p, --port <port>`
- Keep defaults sensible and make the default the no-flag path
- Retire flags by making them no-ops with a `(deprecated)` description rather than removing them —
  `-s, --share` still parses, it just no longer does anything (the tunnel is always on)
- Commander rejects unknown options, so a flag documented but not registered is a hard error, not a
  silently ignored argument. Never document a flag you have not added to the tree.

**Implementation Pattern:**
```typescript
program
  .command("start")
  .option("-p, --port <port>", "Port to listen on")
  .option("--profile <name>", "DB profile name (e.g. 'dev' → ppm.dev.db)")
  .option("-s, --share", "(deprecated) Tunnel is now always enabled")
  .action(async (options) => {
    // Lazy-import the implementation so `--help` stays fast and side-effect free
    const { startServer } = await import("./server/index.ts");
    await startServer(options);
  });
```

Command modules export a `register*Commands(program)` function that `buildProgram()` calls
(`src/index.ts`). `buildProgram()` assembles the tree **without** parsing argv or invoking any
action, so build-time tools can walk it — `scripts/lib/generate-cli-reference.ts` generates the
exported skill's CLI reference from exactly that tree. Keep it side-effect free.

**Server Handling:**

There is one mode: `startServer` spawns a supervisor + daemon child and returns. No foreground
branch exists, and no flag selects one.

```typescript
export async function startServer(options: {
  port?: string;
  share?: boolean;
  profile?: string;
}) {
  options.share = true;             // tunnel is unconditional
  // ... spawn supervisor + server child, wait for status.json, print URLs, exit 0
}
```

### Status File Format
The daemon communicates back via JSON at `~/.ppm/status.json` (inside `getPpmDir()`):

```json
{
  "pid": 12345,
  "port": 3210,
  "host": "0.0.0.0",
  "shareUrl": "https://abc-123.trycloudflare.com"
}
```

**Backward Compatibility:** Fallback to `~/.ppm/ppm.pid` for legacy support.

### Feature Service Loading (Lazy)
Services that require external dependencies (e.g., cloudflared) should be lazy-imported:

```typescript
// Example: lazy-import for optional features
{
  const { ensureCloudflared } = await import("../services/cloudflared.service.ts");
  await ensureCloudflared(); // Always runs in modern PPM (tunnel always enabled)
}
```

This keeps startup fast when features aren't used.

---

## Tab ID & URL Conventions (v0.8.77+)

### Deterministic Tab IDs

Tab IDs are derived from type + metadata, not random:

```typescript
// Format: "{type}:{identifier}" for most tabs, "{type}" for singletons
editor:src/index.ts           // Editor tab with file path
chat:claude/abc123            // Chat with provider/session ID
terminal:1                    // Terminal tab index
database:conn-1/users         // Database: connection ID / table
git-graph                      // Singleton: no identifier
settings                       // Singleton: no identifier

// Derivation in panel-utils.ts
export function deriveTabId(type: TabType, metadata?: Record<string, unknown>): string {
  switch (type) {
    case "editor":
      return `editor:${metadata?.filePath ?? "untitled"}`;
    case "chat": {
      const provider = metadata?.providerId ?? "default";
      return `chat:${provider}/${metadata?.sessionId ?? randomId()}`;
    }
    case "terminal":
      return `terminal:${metadata?.terminalIndex ?? 1}`;
    case "git-graph":
      return "git-graph"; // Singleton
    // ... other cases
  }
}
```

### URL Format

URLs are built from project name + deterministic tab ID:

```typescript
// Format: /project/{projectName}/{type}/{identifier}
/project/ppm                          // Project root (no active tab)
/project/ppm/editor/src/index.ts      // Open editor
/project/ppm/chat/claude/abc123       // Open chat
/project/ppm/terminal/1               // Open terminal
/project/ppm/database/conn-1/users    // Open database
/project/ppm/git-graph                // Git history (singleton)

// URL building in use-url-sync.ts
export function buildUrl(projectName: string, tabId: string | null): string {
  const colonIdx = tabId?.indexOf(":");
  if (colonIdx === -1) {
    // Singleton
    url += `/${tabId}`;
  } else {
    const [type, identifier] = tabId.split(":", 1);
    url += `/${type}/${identifier}`;
  }
  return url;
}
```

### Deep Linking

When user navigates to a URL, parse it and auto-create tabs:

```typescript
// In use-url-sync hook
export function parseUrlState(): UrlState {
  const match = path.match(/^\/project\/([^/]+)(?:\/([^/]+)(\/.*)?)?/);
  const [, projectName, tabType, tabIdentifierPath] = match;

  // Build tab metadata from URL
  const metadata = buildMetadataFromUrl(tabType, tabIdentifier, projectName);

  // Auto-open tab if it doesn't exist
  if (metadata) {
    panelStore.openTab({
      type: tabType,
      title: getTabTitle(tabType, metadata),
      metadata,
    });
  }
}
```

### Server-Side Workspace Persistence

Tab layouts are persisted in the `workspace_state` SQLite table:

```typescript
// workspace.ts routes
GET  /api/project/:name/workspace  → { layout: PanelLayout, updatedAt: string }
PUT  /api/project/:name/workspace  → { updatedAt: string }

// PanelLayout structure
interface PanelLayout {
  panels: Record<string, Panel>;    // panelId → { tabs, activeTabId }
  grid: string[][];                 // Row/column grid of panel IDs
  focusedPanelId: string;
}

// Sync is debounced (1.5s) client-side after layout changes
// Latest-wins: server timestamp compared with client localStorage
```

### Migration from Random IDs

Old tab IDs (tab-xxxx) are automatically migrated to deterministic format:

```typescript
// In panel-utils.ts
export function migrateTabIdToDeterministic(tab: Tab): Tab {
  if (tab.id.startsWith("tab-")) {
    // Convert to deterministic ID
    return {
      ...tab,
      id: deriveTabId(tab.type, tab.metadata),
    };
  }
  return tab;
}
```

This happens on first load per project; old URLs redirect to project root.

---

## Provider Pattern (Multi-Provider Architecture)

### AIProvider Interface
All AI providers implement the `AIProvider` interface from `src/types/chat.ts`:

```typescript
interface AIProvider {
  // Required methods
  createSession(): Promise<Session>;
  sendMessage(sessionId: string, message: string, context?: FileContext[]): AsyncIterable<ChatEvent>;

  // Optional methods (v0.8.60+)
  listModels?(): Promise<ModelOption[]>;
  isAvailable?(): Promise<boolean>;
}

interface ModelOption {
  value: string;    // Model ID (e.g., "claude-fable-5")
  label: string;    // Display name (e.g., "Claude Fable 5 (flagship)")
}
```

### Adding a New Provider

**Step 1: Create provider file** (`src/providers/{name}-provider.ts`)
```typescript
export class MyProvider implements AIProvider {
  async createSession(): Promise<Session> {
    // Return { id: string; ... }
  }

  async *sendMessage(sessionId, message, context?) {
    // Stream ChatEvent objects
    yield { type: "text", content: "response" };
  }

  // Optional: Discover available models
  async listModels(): Promise<ModelOption[]> {
    return [
      { value: "model-1", label: "Model 1" },
      { value: "model-2", label: "Model 2" }
    ];
  }

  // Optional: Check provider availability
  async isAvailable(): Promise<boolean> {
    // Check binary exists, API key set, etc.
    return true;
  }
}
```

**Step 2: Register in ProviderRegistry** (`src/providers/registry.ts`)
```typescript
constructor() {
  this.providers.set("my-provider", {
    id: "my-provider",
    name: "My Provider",
    instance: new MyProvider()
  });
}
```

**Step 3: Add to config schema** (`schemas/ppm-config.schema.json`)
```json
{
  "ai.providers.my_provider": {
    "type": "object",
    "properties": {
      "type": { "const": "my-type" },
      "model": { "type": "string" }
    }
  }
}
```

### CLI Provider Pattern

For subprocess-based providers (e.g., Cursor), extend `CliProvider`:

```typescript
import { CliProvider } from "./cli-provider-base";

export class CursorProvider extends CliProvider {
  async listModels(): Promise<ModelOption[]> {
    // Cache result with TTL
    if (this.modelsCache && Date.now() < this.modelsCache.expiry) {
      return this.modelsCache.models;
    }

    try {
      // Execute subprocess with timeout
      const result = await this.executeWithTimeout(
        "cursor-agent --list-models",
        10000  // 10 second timeout
      );

      const models = JSON.parse(result);

      // Cache for 5 minutes
      this.modelsCache = {
        models,
        expiry: Date.now() + 5 * 60 * 1000
      };

      return models;
    } catch (error) {
      // Graceful fallback on timeout/error
      return [];
    }
  }
}
```

### Testing Providers

Mock for deterministic testing:

```typescript
// tests/unit/providers/my-provider.test.ts
describe("MyProvider", () => {
  it("should stream messages", async () => {
    const provider = new MyProvider();
    const session = await provider.createSession();

    const events: ChatEvent[] = [];
    for await (const event of provider.sendMessage(session.id, "test")) {
      events.push(event);
    }

    expect(events.length).toBeGreaterThan(0);
  });
});
```

### Provider Registry Usage

```typescript
// Get specific provider
const provider = providerRegistry.get("claude");

// Get user-facing providers (for dropdowns)
const providers = providerRegistry.list();

// Get all providers including mock (internal)
const allProviders = providerRegistry.listAll();

// Check if provider is available
const available = await provider.isAvailable?.();

// List models
const models = await provider.listModels?.() ?? [];
```
