# Extension System

> Part of the [PPM system architecture](../system-architecture.md).

## Extension System (v0.9.0+)

### Overview

PPM Extension System enables VSCode-compatible, npm-installable extensions that run in isolated Bun Worker threads. Crash-safe, permission-based, with RPC messaging between main process and worker, and WebSocket bridge for real-time UI updates.

**Architecture (3-tier):**
```
Extension Code (Bun Worker)        ← @ppm/vscode-compat API
  │ RPC (postMessage)
  ▼
Main Process (Hono/Bun)            ← extension-rpc-handlers.ts
  │ WebSocket (/ws/extensions)
  ▼
Browser (React)                    ← Zustand store + React components
```

**Key components:**
- **Package Format:** npm packages (`@ppm/ext-database`, `@ppm/ext-git-graph`, `@ppm/ext-docker`, etc.)
- **Installation:** `~/.ppm/extensions/node_modules/{id}/`
- **Lifecycle:** Install → Enable → Activate → Deactivate → Remove
- **Worker Isolation:** Each activated extension runs in a Bun Worker (crash-safe, 10s activation timeout)
- **Communication:** RPC (Worker↔Main) + WebSocket (Main↔Browser)
- **API Shim:** `@ppm/vscode-compat` — VSCode-compatible API (commands, window, workspace)
- **Subprocess Access:** RPC `process:spawn` handler for extensions needing CLI commands (git, docker, npm, python, etc.)
- **State Storage:** globalState + workspaceState in SQLite via Memento
- **UI Bridge:** StatusBar, TreeView, WebviewPanel, QuickPick, InputBox, Notifications
- **Contributions:** Commands, views, configuration contributed via manifest

**Official Extensions:**
- `@ppm/ext-database` — Database browser with SQLite/PostgreSQL support (tree view + query panel)
- `@ppm/ext-git-graph` — Git commit graph visualization (faithful vscode-git-graph SVG algorithm with Bézier curves, uses process:spawn for git CLI across registered projects)

### Manifest Format

Extension metadata defined in `package.json` under `ppm` key:

```json
{
  "name": "@ppm/ext-database",
  "version": "1.0.0",
  "main": "dist/extension.js",
  "ppm": {
    "displayName": "Database Browser",
    "description": "Browse and query databases",
    "icon": "database.svg",
    "engines": { "ppm": ">=0.9.0" },
    "activationEvents": ["onView:databases"],
    "contributes": {
      "commands": [
        {
          "command": "ppm.database.openConnection",
          "title": "Open Database Connection",
          "category": "Database"
        }
      ],
      "views": {
        "explorer": [
          {
            "id": "databases",
            "name": "Databases",
            "type": "tree"
          }
        ]
      },
      "configuration": {
        "properties": {
          "ppm.database.maxRows": {
            "type": "number",
            "default": 1000,
            "description": "Max rows to fetch per query"
          }
        }
      }
    }
  }
}
```

**Fields:**
- `engines.ppm` — PPM version requirement
- `activationEvents` — When extension activates (e.g., `onView:databases`, `onCommand:ext.activate`)
- `contributes` — UI elements + commands contributed by extension

### Installation & Lifecycle

**Installation** (`ppm ext install @ppm/ext-database`):
1. Fetch package from npm
2. Extract to `~/.ppm/extensions/node_modules/{id}/`
3. Parse manifest from `package.json`
4. Store in SQLite `extensions` table (enabled=1)
5. Discover contributions

**Activation** (`ppm ext enable @ppm/ext-database` or automatic):
1. Load manifest + entry point from disk
2. Spawn Bun Worker (process isolation)
3. Create scoped `@ppm/vscode-compat` API instance (RPC-backed)
4. Call `activate(context, vscodeApi)` with 10s timeout
5. Register contributions in `contributionRegistry`
6. Broadcast `contributions:update` via WS to all connected browsers
7. Mark as activated

**Deactivation:**
1. Unregister contributions
2. Terminate worker
3. Clear persisted state if needed

**Removal** (`ppm ext remove @ppm/ext-database`):
1. Deactivate if active
2. Delete from `~/.ppm/extensions/`
3. Remove from SQLite
4. Unregister contributions

### RPC Protocol (Extension ↔ Main Process)

**Message Types:**

1. **Request** (extension → main)
   ```json
   {
     "type": "request",
     "id": 1,
     "method": "storage:get",
     "params": ["extId", "global", "key"]
   }
   ```

2. **Response** (main → extension)
   ```json
   {
     "type": "response",
     "id": 1,
     "result": "value"
   }
   ```

3. **Event** (both directions)
   ```json
   {
     "type": "event",
     "event": "file:changed",
     "data": { "path": "/path/to/file" }
   }
   ```

**Built-in Methods (vscode-compat API):**
- `commands:execute(command, ...args)` — Execute command
- `commands:list(filterInternal)` — List available commands
- `window:showMessage(level, message, items[])` — Show dialog with buttons
- `window:showQuickPick(items[], options)` — Quick pick menu
- `window:showInputBox(options)` — Text input dialog
- `window:webview:create(panelId, extensionId, viewType, title)` — Create webview panel
- `window:webview:html(panelId, html)` — Set webview content
- `window:webview:postMessage(panelId, message)` — Send message to webview
- `window:tree:update(viewId, items[])` — Update tree view items
- `window:tree:refresh(viewId)` — Refresh tree view
- `window:statusbar:update(item)` — Update/create status bar item
- `window:statusbar:remove(itemId)` — Remove status bar item
- `workspace:config:get(key)` — Read config value
- `workspace:config:update(key, value, target)` — Write config value
- `workspace:fs:readFile(filePath)` — Read file (base64 encoded)
- `workspace:fs:writeFile(filePath, base64Content)` — Write file
- `workspace:fs:stat(filePath)` — Get file metadata
- `workspace:fs:readDirectory(dirPath)` — List directory contents

**Subprocess Execution (extensions needing CLI access):**
- `process:spawn(command, args[], options)` — Execute external command
  - **Allowed commands:** git, node, bun, npm, yarn, pnpm, docker, psql, sqlite3, python3, python
  - **Options:** `{ cwd?: string, timeout?: number }` (default: 30s timeout, CWD must be within registered project paths, ~/.ppm/extensions/, or current process directory)
  - **Returns:** `{ code: number, stdout: string, stderr: string, error?: string }`
  - **Example:** See ext-git-graph for real-world usage (runs `git log --all` across any registered project via path-based CWD)

- Extension can define custom RPC methods via `rpc.onRequest(method, handler)`

### State Storage

**Database Schema:**

```sql
CREATE TABLE extension_storage (
  ext_id TEXT NOT NULL,
  scope TEXT NOT NULL,  -- 'global' | 'workspace'
  key TEXT NOT NULL,
  value TEXT,           -- JSON-serialized
  PRIMARY KEY (ext_id, scope, key)
);
```

**Scopes:**
- **globalState** — Persists across all projects (e.g., user settings, cache)
- **workspaceState** — Project-specific state (e.g., open panel state)

**API** (inside extension):
```typescript
// In activate(context: ExtensionContext)
const globalVal = context.globalState.get("lastConnection", "default");
await context.globalState.update("lastConnection", "my-db");

const wsVal = context.workspaceState.get("selectedTable");
await context.workspaceState.update("selectedTable", "users");
```

### WebSocket Bridge (Extension ↔ Browser)

Extensions interact with the browser UI via a dedicated WebSocket at `/ws/extensions`. The main process translates between Worker RPC and WS messages.

**Server → Client (ExtServerMsg):** `tree:update`, `tree:refresh`, `statusbar:update/remove`, `notification`, `quickpick:show`, `inputbox:show`, `webview:create/html/dispose/postMessage`, `contributions:update`

**Client → Server (ExtClientMsg):** `ready`, `command:execute`, `tree:expand/click`, `webview:message`, `quickpick:resolve`, `inputbox:resolve`, `notification:action`

**Message routing:**
- Extension calls `vscode.window.showInformationMessage()` → RPC → `extension-rpc-handlers.ts` → `broadcastExtMsg()` → WS → `use-extension-ws` hook → toast notification
- Browser user clicks tree item → WS `tree:click` → `extensions.ts` → Worker RPC `ext:command:execute` → CommandService → extension handler
- Webview iframe postMessage → parent → CustomEvent → WS `webview:message` → Worker RPC `ext:webview:message` → EventEmitter → extension's `onDidReceiveMessage` handler

**Request/response pattern:** QuickPick, InputBox, and notification actions use `requestFromBrowser(msg, trackingId, 30s timeout)` — sends WS message and awaits browser response via pending Promise map.

### UI Components

Extension UI state lives in Zustand (`extension-store.ts`) and renders via React:
- **StatusBar** — Fixed bottom bar with left/right aligned items
- **TreeView** — Recursive tree with expand/collapse, renders in sidebar for `ext:*` tabs
- **WebviewPanel** — Sandboxed iframe (`allow-scripts` only), `acquireVsCodeApi()` shim auto-injected
- **QuickPick** — Filterable picker with keyboard nav, bottom-sheet on mobile
- **InputBox** — Text input dialog with password mode support
- **Command Palette** — Extension commands merged with built-in commands

### Contribution Registry

**Purpose:** Central registry of all extension contributions (commands, views, etc.)

**Storage:** In-memory map during runtime

**Endpoints:**
- `GET /api/extensions/contributions` — List all active contributions

**Contribution Types:**
1. **Commands** — Callable actions (e.g., `ppm.database.openConnection`)
   - Registered: `registry.registerCommand(extId, command)`
   - Invoked: `POST /api/extensions/{extId}/commands/{command}`

2. **Views** — Sidebar panels or tree views
   - Registered: `registry.registerView(extId, view)`
   - Rendered in UI based on `type` (tree, webview)

3. **Configuration** — Settings schema
   - Registered: `registry.registerConfig(extId, schema)`
   - Merged with global settings

### CLI Commands

```bash
ppm ext list                      # List installed extensions
ppm ext install @ppm/ext-database # Install from npm
ppm ext remove @ppm/ext-database  # Uninstall
ppm ext enable @ppm/ext-database  # Enable extension
ppm ext disable @ppm/ext-database # Disable extension
ppm ext dev /path/to/ext-src      # Symlink local extension for dev
ppm ext config <ext-id> <key> <value> # Set config value
```

**Dev Mode** (`ppm ext dev /path/to/src`):
- Symlinks local extension to `~/.ppm/extensions/node_modules/`
- Auto-reloads on file change
- Extension runs from source (TypeScript not compiled)

### REST API

**Endpoints** (`src/server/routes/extensions.ts`):

| Method | Endpoint | Description |
|--------|----------|-------------|
| **GET** | `/api/extensions` | List installed extensions |
| **POST** | `/api/extensions` | Install extension (body: {name, version?}) |
| **GET** | `/api/extensions/:id` | Get extension info (manifest, status) |
| **DELETE** | `/api/extensions/:id` | Remove extension |
| **PATCH** | `/api/extensions/:id` | Update extension (body: {enabled}) |
| **GET** | `/api/extensions/contributions` | List all contributions (commands, views, config) |
| **POST** | `/api/extensions/:id/commands/:cmd` | Invoke extension command |

**Example: Install Extension**
```bash
POST /api/extensions
Content-Type: application/json

{ "name": "@ppm/ext-database", "version": "1.0.0" }

# Response
{
  "ok": true,
  "data": {
    "id": "@ppm/ext-database",
    "version": "1.0.0",
    "displayName": "Database Browser",
    "enabled": true,
    "activated": false
  }
}
```

### Service Layer

**ExtensionService** (`src/services/extension.service.ts`):
- `discover()` — Scan `~/.ppm/extensions/` for installed packages
- `install(name)` — Fetch from npm, install locally
- `remove(id)` — Uninstall extension
- `activate(id)` — Load + run extension in worker
- `deactivate(id)` — Terminate worker, cleanup
- `parseManifest(pkg)` — Extract manifest from package.json
- `setExtensionState(extId, scope, key, value)` — Persist state

**ExtensionInstaller** (`src/services/extension-installer.ts`):
- `installExtension(name, dir)` — npm install + verify
- `removeExtension(id, dir)` — rm -rf extension directory
- `devLinkExtension(localPath)` — Symlink for local dev

**ExtensionManifest** (`src/services/extension-manifest.ts`):
- `parseManifest(pkg)` — Validate + parse ppm section
- `discoverManifests(dir)` — Scan all installed extensions

**RpcChannel** (`src/services/extension-rpc.ts`):
- Bidirectional RPC messaging
- Request/response matching by ID
- Event broadcasting
- Timeout handling

### Worker Integration

**ExtensionHostWorker** (`src/services/extension-host-worker.ts`):
- Worker-side code that loads + activates extension
- Loads extension code into worker context
- Exposes ExtensionContext API (globalState, workspaceState, subscriptions)
- Handles incoming RPC messages
- Communicates back to main process

**Design:**
```
Main Process                Worker
     ↓                         ↓
 ExtensionService    ExtensionHostWorker
     ↓                         ↓
 RpcChannel ←────────────→ RpcChannel
     ↓                         ↓
 Sends: {                Extension Code
   type: "request",      (User's ext.ts)
   method: "..."        ↓
 }                   activate(context)
     ↓                   ↓
 Handlers respond  context.storage.get()
     ↑                   ↑
     └─────────────────┘
```

### Dev Workflow

**Creating an Extension:**

1. Create npm package:
   ```bash
   npm init -y @ppm/ext-my-feature
   npm install @ppm/extension-api
   ```

2. Write `src/extension.ts`:
   ```typescript
   import type { ExtensionContext } from "@ppm/extension-api";

   export async function activate(context: ExtensionContext) {
     console.log(`Extension ${context.extensionId} activated!`);
     
     const val = context.globalState.get("count", 0);
     await context.globalState.update("count", val + 1);
   }

   export function deactivate() {
     console.log("Extension deactivated");
   }
   ```

3. Add to `package.json`:
   ```json
   {
     "ppm": {
       "displayName": "My Feature",
       "main": "dist/extension.js",
       "contributes": {
         "commands": [...]
       }
     }
   }
   ```

4. Install locally for dev:
   ```bash
   ppm ext dev /path/to/ext-my-feature
   ```

5. Extension auto-activates based on `activationEvents`, state persists

### Error Handling & Debugging

**Activation Error Tracking:**
- `ExtensionService.activationErrors` Map tracks `extId → error message` for all failed activations
- Errors set during `activate()` if worker response indicates failure (`!result.ok`)
- Errors cleared on successful activation or worker termination
- Errors included in `contributions:update` message sent via WS to browser on client connect

**User Feedback (UI):**
- **Command Errors:** When extension command fails, toast shows "Extension command failed: {error}" with error details
- **Timeout Handling:** If webview panel doesn't load within 10s, fallback UI displays activation error (if available) + "Retry" button
- **Retry Button:** User can click to re-trigger the command without page reload (re-dispatches `ext:command:execute`)

**Breadcrumb Logging (Console):**
- **`[ExtService]`** — Main process lifecycle: activation start/success, worker lifecycle, contributions broadcast
- **`[ExtHost]`** — Worker-side execution: command routing, handler invocation, error context
- **`[ExtWS]`** — WebSocket bridge: client connect, message handling, error responses
- **Extension-specific tags** — e.g., `[ext-git-graph]` for extension-specific log context

**Example Log Flow (normal):**
```
[ExtService] startup: activating ext-git-graph...
[ExtWS] Client connected (1 total)
[ExtHost] activating ext-git-graph from dist/extension.js
[ExtHost] activated ext-git-graph (1 total)
[ExtService] activated ext-git-graph successfully
[ExtWS] command:execute "git-graph.view"
[ExtHost] command:execute "git-graph.view" (1 extensions active)
[ExtHost] routing "git-graph.view" → ext-git-graph
```

**Example Log Flow (error):**
```
[ExtService] startup: activating ext-git-graph...
[ExtHost] activating ext-git-graph from dist/extension.ts
[ExtHost] ERROR: Cannot find module 'missing-dep'
[ExtService] Failed to activate ext-git-graph on startup: Cannot find module 'missing-dep'
→ activationErrors["ext-git-graph"] = "Cannot find module 'missing-dep'"
→ browser receives { type: "contributions:update", activationErrors: {"ext-git-graph": "..."} }
→ user sees toast: "Extension "ext-git-graph" failed to activate: Cannot find module..."
```

### Crash Safety

**Worker Isolation:**
- Each extension in isolated Bun Worker thread
- Worker crash doesn't crash main process
- Error events logged, extension marked as failed
- Main process continues operating

**Cleanup:**
- Worker terminates → cleanup timer expires after 5min
- Persisted state preserved in SQLite (not lost on crash)
- Next activation reloads from disk, state auto-restored

### Future Enhancements (Phase 2+)

- **UI Webview Support** — Extensions define HTML/React UI panels
- **Extension Settings UI** — Auto-generate UI from `contributes.configuration`
- **Hot Reload** — Auto-reload extension on file change during dev
- **Marketplace** — Browse, rate, publish extensions (v1.0+)
- **Permissions** — User prompt for sensitive operations
- **Inter-Extension API** — Extensions can call each other via RPC

---

**Tool Allow List:**
- All MCP tools automatically allowed via wildcard `mcp__*`
- MCP server connection failures don't block chat (logged as warning)

### Import Flow

**Auto-import on first access:**
1. GET `/api/settings/mcp` called
2. If table is empty, read `~/.claude.json`
3. If `mcpServers` key exists, bulk import (validate + skip duplicates)
4. Return populated list

**Manual import:**
1. GET `/api/settings/mcp/import/preview` — show what's available
2. POST `/api/settings/mcp/import` — import validated servers
3. Returns `{ imported: N, skipped: M }`

### Error Handling

| Scenario | Response |
|----------|----------|
| Invalid name (non-alphanumeric) | 400 Bad Request |
| Invalid config (missing required fields) | 400 Bad Request |
| Duplicate name | 409 Conflict |
| Server not found (GET/:name, PUT/:name, DELETE/:name) | 404 Not Found |
| `~/.claude.json` not found (import) | 404 Not Found |
| Corrupt config JSON (recovery) | Log warning, skip entry, continue |
