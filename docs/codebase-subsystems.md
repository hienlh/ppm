# Codebase Subsystems

> Deep dives into individual subsystems. The module map and directory layout live in
> [codebase-summary.md](codebase-summary.md).

## Multi-Provider Architecture (v0.8.60)

### Dynamic Model Listing Feature

**Problem:** Different AI providers expose different models. Claude has hardcoded models, but CLI-based providers (e.g., Cursor) discover models at runtime.

**Solution:** Optional `listModels()` method on `AIProvider` interface

### Provider Interface

```typescript
// src/types/chat.ts
export interface ModelOption {
  value: string;    // Model ID (e.g., "claude-fable-5")
  label: string;    // Display name (e.g., "Claude Fable 5 (flagship)")
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
- `listModels()` returns hardcoded models, power-sorted: Fable 5, Opus 4.8/4.7/4.6, Sonnet 4.6, Haiku 4.5
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

Stored as dotted keys in the `config` table; shown as a tree for readability:

```
ai.default_provider              claude
ai.providers.claude.type         agent-sdk
ai.providers.claude.model        claude-opus-5   # default; see listModels() for the full list
ai.providers.claude.effort       high            # low|medium|high|xhigh|max
ai.providers.claude.max_turns    1000
ai.providers.cursor.type         cli
ai.providers.cursor.model        cursor-fast     # from listModels()
```

### Testing

**New Integration Tests (13 tests):**
- `provider-models-api.test.ts` — Model API endpoints
- `chat-service-multi-provider.test.ts` — Multi-provider flows
- `cursor-provider.test.ts` — Subprocess TTL cache, timeout handling

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
