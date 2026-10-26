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
- **Subprocess Access:** `vscode.process.spawn` (RPC `process:spawn`) for extensions needing a CLI: `git`, `gh`, `node`, `bun`, `npx`, `sqlite3` only
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

**Discovery on start** (`discoverManifests` in `src/services/extension-manifest.ts`): user extensions live in `<ppm dir>/extensions/node_modules`. The candidates are the keys of `<ppm dir>/extensions/package.json` `dependencies` (installed) plus the symlinks in `node_modules`, `@scope/name` included (dev-linked), and a candidate counts only when its manifest has a `ppm`, `contributes` or `engines.ppm` field, so a transitive npm dependency is never registered. `startup()` deletes the record and stored state of any extension discovery does not find, so this list is what keeps a user extension's `globalState` across restarts.

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
- `process:spawn(command, args[], cwd, options?)`, called as `vscode.process.spawn(...)`
  - **Allowed commands:** `git`, `gh`, `node`, `bun`, `npx`, `sqlite3`, matched by base name (`ALLOWED_SPAWN_COMMANDS` in `extension-rpc-handlers.ts`). Anything else throws.
  - **cwd** (positional) must be inside a registered project, PPM's cwd or `<ppm dir>/extensions` (`assertSafePath`).
  - **Options:** `{ timeout?: number; env?: Record<string, string> }`. `timeout` defaults to 30 s and is capped at 15 minutes (`spawnTimeoutMs`); `env` is merged over the host's, with `PATH`, `HOME` and the loader variables blocked.
  - Run with `Bun.spawn([cmd, ...args])`, no shell. A binary that is not installed throws `process:spawn failed: …` instead of escaping as Bun's synchronous throw.
  - **Returns:** `{ stdout: string, stderr: string, exitCode: number }`. A process killed at its timeout returns; it does not throw.
  - The extension waits `min(timeout, 15 min) + 30 s` (`RpcClient.requestWithTimeout`), so the main thread's answer always arrives before the extension gives up.

**Per-request timeouts:** `RpcChannel.sendRequest` waits 10 s; `sendRequestWithTimeout(method, timeoutMs, params)` waits as long as the caller says (the CLI execute route passes its `timeoutMs`, up to 10 minutes). A disposed channel refuses new requests and drops answers to old ones.

**PPM additions (`api.ppm`, answered in `src/services/extension-api/`):**
- `notify:send({ extensionId, title, body, projectName?, sessionId?, providerId?, path?, open? })` — `api.ppm.notify`. Sent under the `extension` notification event, 30 an hour per extension (sliding window), answered within about 2 s (`queued` while PPM's own delay is still deciding). `open` names the **calling** extension's own target: a view (a declared command; a panel's viewType equals its command) or a command it lists in `contributes.deepLinkCommands` (each entry also in `contributes.commands`; `checkNotifyOpen` in `extension-notify-open.ts` refuses any other command, since anyone holding the link can open it); it becomes an in-app path built by `src/shared/extension-deep-link.ts` (`/project/<p>?extCommand=…&extArgs=<base64url JSON>` or `extView=…`), so push, Telegram and ntfy share it.

**Events main → worker:**
- `client:timezone { timeZone, deviceId }` — a browser's IANA zone. The host keeps one `ClientTimeZoneState` for every extension: `vscode.env.clientTimeZone` and `onDidChangeClientTimeZone`, which fires only when the zone differs. Sent on each browser report and again to a rebuilt host on `worker:ready`.

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

**Client → Server (ExtClientMsg):** `ready`, `command:execute`, `tree:expand/click`, `webview:message`, `quickpick:resolve`, `inputbox:resolve`, `notification:action`, `client:timezone`

**Client time zone:** on every connect, and again when the page comes back into view with a different zone (`src/web/lib/client-timezone-reporter.ts`), the browser sends `{ type: "client:timezone", timeZone, deviceId }` (`Intl.DateTimeFormat().resolvedOptions().timeZone`, and the device id the session trace uses). The server keeps the last report whose zone passes a `new Intl.DateTimeFormat(undefined, { timeZone })` probe, in memory only (`src/services/client-timezone.ts`), and forwards it to the host.

**Message routing:**
- Extension calls `vscode.window.showInformationMessage()` → RPC → `extension-rpc-handlers.ts` → `broadcastExtMsg()` → WS → `use-extension-ws` hook → toast notification
- Browser user clicks tree item → WS `tree:click` → `extensions.ts` → Worker RPC `ext:command:execute` → CommandService → extension handler
- Webview iframe postMessage → parent → CustomEvent → WS `webview:message` → Worker RPC `ext:webview:message` → EventEmitter → extension's `onDidReceiveMessage` handler

**Request/response pattern:** QuickPick, InputBox, and notification actions use `requestFromBrowser(msg, trackingId, 30s timeout)` — sends WS message and awaits browser response via pending Promise map.

### UI Components

Extension UI state lives in Zustand (`extension-store.ts`) and renders via React:
- **StatusBar** — Fixed bottom bar with left/right aligned items
- **TreeView** — Recursive tree with expand/collapse, renders in sidebar for `ext:*` tabs. A row (`extension-tree-node.tsx`) is one line: chevron, `icon` (a name in `src/web/lib/extension-icons.ts`), colour dot, label, `description`, `badge`, then inline `actions` (on hover or keyboard focus with a mouse, always on touch). `tooltip` shows on hover with its line breaks. The row is an `adaptive-context-menu` trigger: right-click on a desktop, long press on a phone opens a sheet with the full label, description and tooltip (`ContextMenuLabel`), each action as a full-width item, and Open (`extension-tree-row-menu.tsx`). Rows are `select-none` with no touch callout; the press is the adaptive menu's, which disarms on `touchcancel`. A row with an http(s) `url` renders its label as `<a target="_blank" rel="noopener noreferrer">`, because a worker cannot open a tab; the scheme is checked by vscode-compat and again by the renderer.
- **Deep links** — a notification's `extCommand`/`extView` link is read on boot (`app.tsx`, removed from the URL at once with `replaceState`) and on a service-worker click into an open window (`use-notification-clicks.ts`, which switches project first). `src/web/lib/extension-deep-link-runner.ts` waits up to 20 s for an active extension to list the command, then dispatches `ext:command:execute` locally, so the panel gets a tab on the device that was tapped (a view opens a tab with no panel, which the webview host's recovery dispatch fills). A command runs only if an active extension lists it in `deepLinkCommands`, which `contributionRegistry.getAll()` publishes (filtered to declared commands by `deepLinkableCommands` in `src/shared/extension-deep-link.ts`): a declared but unlisted command is refused at once, even from a hand-made URL, because the browser cannot tell a link PPM built from one anyone typed. A view needs no entry. A target nothing declares is dropped with a warning after the wait.
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
   - Registered from the manifest on activation (`contributionRegistry.register`)
   - Invoked from the browser over `/ws/extensions` (`command:execute`), or from the CLI with `POST /api/extensions/commands/execute`

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
ppm ext run [--json] [--timeout <ms>] <command> [args…]  # Run a declared command on the running server
ppm <alias> [args…]               # An alias an enabled extension contributes (contributes.cli)
```

**Talking to the running server** (`src/cli/utils/server-client.ts`): the port comes from `<ppm dir>/status.json` (written by the supervisor), else the `port` setting; the host is always `127.0.0.1`; `Authorization: Bearer <auth.token>` is sent when auth is on. A `/api/health` probe with a 3 s limit decides "not running" before the real call. `schedule run-now` and `projects add`/`remove` use it too: the server holds projects in memory, so the CLI goes through its API when it answers and writes the database only when nothing does.

**`ppm ext run`**: tokens after the command are spread as arguments (`handler(...tokens)`); `--json` and `--timeout` belong to `ext run` wherever they appear (`--` passes them through).

**Extension aliases** (`contributes.cli: [{ name, description?, command }]`): registered in `src/index.ts`'s CLI branch, outside `buildProgram()`, so the generated `ppm` skill never lists one user's extensions. They are read only when `argv[2]` is absent, `help`/`--help`/`-h`, or not a built-in name (`shouldLoadAliases`), from manifests on disk plus the `extensions` table's enabled flag, without starting a worker (`src/services/extension-cli-aliases.ts`). Refused: a name failing `^[a-z][a-z0-9-]{1,30}$`, one in `BUILTIN_CLI_COMMANDS` (`src/shared/cli-builtin-commands.ts`, kept equal to `buildProgram()` by a test) or `help`, a `command` the same manifest does not declare, and a duplicate (the id sorting first wins). `PPM_DEBUG=1` prints refusals. Each alias forwards every token after its name, `--json` and `--help` included, as one array: `handler(argv)`, timeout 60 s. Aliases need Commander's positional options, which are switched on only when an alias is registered.

**Output and exit codes** (`src/cli/utils/run-extension-command.ts`): a string result prints as it is, another value as indented JSON, `null` as nothing; `ext run --json` prints one line of JSON. Machine-facing commands (`src/cli/utils/machine-facing-commands.ts`) print no `PPM vX` banner. Exit 0 success, 1 server down or token refused, 2 `BAD_REQUEST`/`ORIGIN_REFUSED`/`NOT_FOUND`/`NOT_ACTIVE`/`HOST_NOT_READY`, 3 `COMMAND_FAILED`/`TIMEOUT`. Errors go to stderr.

**AI hint:** every Claude and Codex chat gets one server-built line naming the enabled aliases (`src/services/extension-cli-hint.ts`, cached, invalidated on install/remove/enable/disable/activate): Claude appends it to the system prompt after the design block, Codex joins it to `developerInstructions`. A warm Claude spare is spawned with the same line so the first turn can take it over.

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
| **POST** | `/api/extensions/commands/execute` | Run a declared command for the CLI (below) |
| **GET** | `/api/chat/sessions/status` | Every recent session's waiting/stopped/reply state, across projects (below) |

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

**`POST /api/extensions/commands/execute`** (`src/server/routes/extension-command-execute-route.ts`, logic in `src/services/extension-command-executor.ts`): body `{ command, args?, timeoutMs? }`. `command` 1–200 characters and declared in an installed extension's `contributes.commands`; `args` a JSON array spread as `handler(...args)`; `timeoutMs` default 60,000, clamped to 1,000–600,000; body at most 256 KB, counted as it arrives. Behind the app's Bearer auth, plus a refusal of any request carrying an `Origin`: CORS is open app-wide, so without it a web page could drive commands on an instance with auth off; the CLI never sends one. Success: `{ ok: true, data: { command, extensionId, result, durationMs } }`, `undefined` as `null`. Errors: `{ ok: false, error, code }`.

| HTTP | `code` | When |
|---|---|---|
| 400 | `BAD_REQUEST` | Not JSON, `command` missing or too long, `args` not an array, body too large |
| 403 | `ORIGIN_REFUSED` | The request carried an `Origin` |
| 403 | `NOT_ACTIVE` | Declared by an installed extension that is disabled or failed to activate |
| 404 | `NOT_FOUND` | No installed extension declares it, or the worker has no handler (`code: "NOT_FOUND"` from `ext:command:execute`) |
| 503 | `HOST_NOT_READY` | No worker yet, no `worker:ready`, the worker exited, or the declaring extension is enabled but its activation has not run yet (PPM still starting) |
| 500 | `COMMAND_FAILED` | The handler threw, or returned a value structured clone cannot carry |
| 504 | `TIMEOUT` | No answer within `timeoutMs`; the handler may still be running |

One INFO line per call: `ext command=<id> ext=<extId> ms=<n> outcome=<ok|code>`, never the arguments or the result.

**`GET /api/chat/sessions/status?sinceHours=336&project=<name>`** (`src/server/routes/chat-global.ts`, `src/services/chat-session-status.service.ts`): every session with trace activity in the window (1–2160 hours), in registered projects, newest first. Per session: `sessionId` (after migration), `providerId`, `projectName`, `title`, `updatedAt` (newest trace row), `phase` and `pending` (`{ kind: "question" | "approval", tool, requestId, since }`, from the chat socket's memory, so lost on restart), `lastTurn` (`running` while the socket's phase is not idle or this process runs a turn of it without a socket (scheduler, Jira, bots: `isTurnRunning` in `trace-recorder.ts`), and for two minutes after the newest row of a turn another process is writing; else `cancelled` for the user's Stop inside the turn, `max_turns`/`error` with the message, `error` "The turn ended without finishing" for a turn whose rows stop mid-turn with nothing running it, and `done`), `lastAnswerAt` and `lastUserMessageAt` (the newest top-level `done` and `user_message`, read exactly however long the turn), `userRepliedSinceAnswer`, `unreadType`. Read from `session-trace.db` (`readTurnStatusForTrace` in `turn-stop-reader.ts`, which tells a `ws_cancel` abort inside a turn from PPM's own aborts and from a Stop after the turn's `done`), `ppm.db` `session_metadata`, and `listSessionLiveState()` in `ws/chat.ts`. Never reads a transcript, never marks anything read.

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
