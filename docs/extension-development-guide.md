# PPM Extension Development Guide

Build extensions that add features to PPM. Extensions are TypeScript packages that hook into PPM's UI, commands, file system, and configuration.

---

## Extension Basics

### Structure

A PPM extension is a directory with `package.json` manifest and TypeScript entry point:

```
my-extension/
├── package.json
├── tsconfig.json
├── src/
│   └── extension.ts          # Entry point with activate() & deactivate()
├── webview/                  # Optional: webview HTML/CSS/JS
│   └── index.html
└── README.md
```

### Manifest (package.json)

```json
{
  "name": "@org/ext-myfeature",
  "version": "1.0.0",
  "main": "src/extension.ts",
  "engines": { "ppm": ">=0.9.0" },
  "activationEvents": [
    "onCommand:myext.doSomething",
    "onView:myext.sidebar"
  ],
  "contributes": {
    "commands": [
      { "command": "myext.doSomething", "title": "My Feature: Do Something" }
    ],
    "views": {
      "sidebar": [
        { "id": "myext.sidebar", "name": "My Sidebar", "type": "tree" }
      ]
    },
    "menus": {
      "commandPalette": [
        { "command": "myext.doSomething" }
      ]
    },
    "configuration": {
      "properties": {
        "myext.setting": { "type": "boolean", "default": true }
      }
    }
  },
  "ppm": {
    "displayName": "My Feature",
    "icon": "star",
    "webviewDir": "webview"
  }
}
```

**Key fields:**
- `main` — TypeScript file with `export function activate(context, vscode) {}`
- `engines.ppm` — minimum PPM version (not `vscode`)
- `activationEvents` — when extension loads (commands, views, or startup)
- `contributes` — UI elements: commands, views, menus, config
- `ppm.displayName` — human-readable name in extension UI
- `ppm.icon` — icon name (standard VSCode icon set)
- `ppm.webviewDir` — directory containing webview HTML

---

## Activation & Lifecycle

Extensions run in an isolated Bun Worker thread. The Worker receives `context` and `vscode` API:

```typescript
/** Runs when activation event fires */
export function activate(context: ExtensionContext, vscode: VscodeApi): void {
  console.log("Extension activated");
  
  // Register commands, listeners, views, etc.
  context.subscriptions.push(
    vscode.commands.registerCommand("myext.foo", () => {
      // ...
    })
  );
}

/** Cleanup on disable/uninstall */
export function deactivate(): void {
  console.log("Extension deactivated");
  // Browser/streams are auto-closed; use this for final logging
}
```

**Important:** Push ALL disposables (commands, listeners, panels, views) to `context.subscriptions` for automatic cleanup.

---

## API Surface

### Commands

Register and execute commands:

```typescript
// Register
const cmd = vscode.commands.registerCommand("myext.foo", (arg1, arg2) => {
  return "result";
});
context.subscriptions.push(cmd);

// Execute (from command palette or button click)
// vscode.commands.executeCommand("myext.foo", arg1, arg2);
```

### Messages (Dialogs)

```typescript
// Information
await vscode.window.showInformationMessage("Done!", "OK", "Cancel");

// Warning
await vscode.window.showWarningMessage("Are you sure?", "Yes", "No");

// Error
await vscode.window.showErrorMessage("Failed!", "Retry");
```

### Quick Pick

```typescript
const selected = await vscode.window.showQuickPick(
  [
    { label: "Option A", description: "First choice" },
    { label: "Option B", description: "Second choice" }
  ],
  {
    title: "Choose one",
    placeHolder: "Start typing to filter...",
    canPickMany: false,
    matchOnDescription: true
  }
);
```

### Input Box

```typescript
const input = await vscode.window.showInputBox({
  title: "Enter name",
  prompt: "What is your name?",
  placeHolder: "John Doe",
  password: false
});
```

### Status Bar

```typescript
const item = vscode.window.createStatusBarItem(
  vscode.StatusBarAlignment.Right,
  100  // priority
);
item.text = "⚙️ Status";
item.tooltip = "Click for menu";
item.command = "myext.openMenu";
item.show();
context.subscriptions.push(item);
```

### Tree View

Sidebar tree for displaying hierarchical data:

```typescript
class MyTreeProvider {
  getChildren(element?: NodeData): Promise<NodeData[]> {
    if (!element) {
      // Root items
      return [
        { id: "1", label: "Item 1" },
        { id: "2", label: "Item 2" }
      ];
    }
    // Children of element
    return [];
  }

  getTreeItem(element: NodeData) {
    return {
      id: element.id,
      label: element.label,
      collapsibleState: element.children?.length ? 
        vscode.TreeItemCollapsibleState.Collapsed : 
        vscode.TreeItemCollapsibleState.None,
      command: { command: "myext.selectNode", arguments: [element.id] }
    };
  }
}

const provider = new MyTreeProvider();
const tree = vscode.window.createTreeView("myext.tree", {
  treeDataProvider: provider
});
context.subscriptions.push(tree);
```

**viewId** must match the `contributes.views[].id` in package.json.

### Webview Panel

Sandboxed iframe for custom UI:

```typescript
const panel = vscode.window.createWebviewPanel(
  "myext.panel",        // viewType (unique)
  "My Panel",           // title (shown in tab)
  vscode.ViewColumn.Active
);

// Set HTML (scripts auto-sandboxed, allow-scripts only)
panel.webview.html = `
  <!DOCTYPE html>
  <html>
  <body>
    <button id="btn">Click me</button>
    <script>
      const vscode = acquireVsCodeApi();
      document.getElementById("btn").onclick = () => {
        vscode.postMessage({ type: "buttonClicked" });
      };
      
      window.addEventListener("message", (e) => {
        console.log("From extension:", e.data);
      });
    </script>
  </body>
  </html>
`;

// Receive messages from webview
panel.webview.onDidReceiveMessage(async (msg) => {
  if (msg.type === "buttonClicked") {
    await vscode.window.showInformationMessage("Button clicked!");
    await panel.webview.postMessage({ type: "response", data: "Hello from extension" });
  }
});

context.subscriptions.push(panel.onDidDispose(() => {
  console.log("Panel closed");
}));
```

### Configuration

```typescript
// Read
const config = vscode.workspace.getConfiguration("myext");
const timeout = config.get<number>("timeout", 5000);

// Update
await config.update("timeout", 10000, vscode.ConfigurationTarget.Global);
```

### Storage (Memento)

Persist data across sessions:

```typescript
// Global (user-wide)
await context.globalState.update("key", { foo: "bar" });
const value = context.globalState.get("key");

// Workspace-scoped
await context.workspaceState.update("project", "data");
```

### Process Spawning (Subprocess Execution)

Extensions needing to run external commands use the RPC `process:spawn` handler. This is essential for extensions that interact with CLIs (git, docker, node, etc.).

**Only `git`, `node`, `bun`, `npx` and `sqlite3` may be spawned.** Anything else — including
coreutils like `test` or `cat` — makes the call *throw*, not return a non-zero exit code. That
distinction matters: a `try/catch` around the call will swallow the failure and leave the feature
silently doing nothing. Check existence with `workspace.fs.stat` rather than shelling out to `test`.

`options.env` is merged over the host's environment, so `PATH` survives; `PATH`, `HOME`,
`LD_PRELOAD`, `DYLD_INSERT_LIBRARIES` and `LD_LIBRARY_PATH` cannot be overridden.

```typescript
// vscode.process.spawn(command, args, cwd, { timeout?, env? }) → { stdout, stderr, exitCode }
try {
  const { exitCode, stdout } = await vscode.process.spawn("git", ["log", "--oneline", "-n", "10"], projectPath, { timeout: 60_000 });
  if (exitCode !== 0) await vscode.window.showErrorMessage("git log failed");
  else render(stdout);
} catch (e) {
  // A command outside the allowlist or a cwd outside every project lands here.
  await vscode.window.showErrorMessage(`Cannot run git: ${e}`);
}
```

**Restrictions:**
- The allowlist above (`ALLOWED_SPAWN_COMMANDS` in `extension-rpc-handlers.ts`) is the whole list
- CWD limited to a registered project root (no path escaping)
- 30-second timeout by default, at most 15 minutes; the process is killed past it, and when the
  extension host restarts
- Stdout/stderr captured as strings
- A non-zero exit code is returned in `exitCode`, not thrown

`packages/ext-git-graph/` runs all its git commands this way.

### Long RPC calls

Every call an extension makes is an RPC to PPM's main thread with a **10-second timeout** unless
the call names its own (`rpc.requestWithTimeout(method, ms, ...params)`). The dialogs (quick
pick, input box, composer) wait 600 s; `process.spawn` waits its own timeout plus 30 s; the
`ppm.*` calls below set theirs. A hand-rolled RPC that can outlast 10 s must use
`requestWithTimeout`, or it fails with `RPC timeout` while the work goes on.

All extensions share **one** host worker. PPM rebuilds it when it dies (at most 3 times in 5
minutes, then it gives up until restart) and re-activates every enabled extension, bundled ones
included. A rebuild **aborts every call the old worker started**: AI calls, spawned processes,
MCP tool calls and open dialogs, so a late answer never reaches the new worker. An uncaught
exception or unhandled rejection in an extension is logged and swallowed, so one forgotten
`.catch()` no longer takes the other extensions down.

### Composer and tree rows

`await vscode.window.showComposer({ title?, prompt?, value?, permissionMode?, model? })` shows
PPM's own chat composer (slash and file pickers, model, permission mode) and resolves with
`{ content, model?, effort?, thinking?, permissionMode }`, or `undefined` when the user
dismisses it. It sends nothing: the extension decides what to do with the message. It works on
the active project and fails at once when no browser is connected.

A tree item may carry PPM extras: `badge` (a short count or label at the row end), `actions`
(at most two inline buttons, each `{ icon: "refresh" | "edit" | "trash" | "plus" | "search",
tooltip, command, commandArgs? }`) and `commandArgs` (the arguments a row click passes, ahead
of `command.arguments`).

### Data directory

`context.globalStoragePath` is `<ppm dir>/extension-data/<id>` (`@scope/name` becomes
`__scope__name`), created before `activate()` runs. Keep databases and caches here, not in
`storagePath` (`<extension>/.storage`, which for a dev-linked extension is inside its source
repository). It **survives removing the extension**. `bun:sqlite` works inside the worker; open
one connection per worker life and set `busy_timeout` first. `workspace.fs` and
`process.spawn` cannot reach this folder; use Bun's own file APIs.

### Opening a panel as a window

`createWebviewPanel(viewType, title, column, { preferWindow: true })` opens the panel in a
floating window on a desktop browser. A phone, or a desktop at its window limit, gets an
ordinary tab, and only the browser that ran the command moves it.

A tab such a panel opens would otherwise land in the tab strip *behind* the panel's window.
`ppm.chat.openTab(sessionId, { preferWindow: true, beside: panel })` and
`window.openTab(tabType, title, projectId, metadata, { preferWindow: true, beside: panel })`
(`panel` is the object `createWebviewPanel` returned) ask a desktop for a floating window in
front instead, placed to the right of the panel's window when there is room, else to its left,
else over its right edge a titlebar lower. A tab already in a window has that window brought
forward (out of the dock if minimised); a docked tab moves into a window and goes back to its
place when the window is closed, while a tab opened just now closes with its window. Without
the option nothing changes. A phone keeps an ordinary tab. `window.openTab` reaches every
browser: one that does not show `beside` keeps an ordinary tab. A PPM without the option
ignores it and opens a tab as before.

### PPM's own API (`vscode.ppm`)

Beyond the VSCode API, the second argument of `activate` carries `ppm` (types exported from
`@ppm/vscode-compat`: `PpmChat`, `PpmAi`, `PpmMcp`, ...). The extension id travels with each
call. Every extension shares one worker, so PPM **cannot prove which extension sent a call**:
its ownership checks keep a mistaken extension to its own sessions and toolsets, not a hostile
one. Install only extensions you trust.

**Chat sessions (`ppm.chat`).** `createSession({ projectName, providerId, title?, accountId?,
model?, bindable? })` starts a chat in a registered project. `send(sessionId, { content,
model?, effort?, thinking?, permissionMode?, images?, timeoutMs?, notifyOnDone? })` starts a turn with nobody watching and answers as soon as it is
queued; poll `state()` or `waitForIdle()`, then read `lastAssistantText()`. Rules:

- An extension may send to and cancel only sessions it created.
- At most 4 sessions per extension with a turn running or queued (`TOO_MANY_HEADLESS_TURNS`).
- A message sent while a turn runs is queued as a turn of its own; it never changes the
  running one, a person's included. A Claude session asked for another model, effort or
  thinking while busy is refused (`BUSY_DIFFERENT_MODEL`).
- The turn is aborted past `timeoutMs` (default 30 min, 1 s to 24 h).
- Nobody may be there to approve a tool: an approval in an extension's turn is **denied at
  once** with no browser showing the chat, and after 120 s with one.
- The turn marks the chat unread; PPM's "Chat completed" push is sent only with
  `notifyOnDone: true`.
- `openTab(sessionId, options?)` opens the chat only in the browser that ran one of the
  extension's commands in the last 10 s, and answers `{ opened: false }` otherwise.
  `{ preferWindow: true, beside: panel }` puts it in a floating window beside that panel's (see
  "Opening a panel as a window").

The same turn is available over REST for callers outside the extension host:
`POST /api/project/:name/chat/sessions/:id/messages` (202; 409 busy, 429 over the cap) and
`.../cancel`.

**Binding a session.** A Claude session created with `bindable: true` can be bound by its
creator: `bind(sessionId, { instructions?, toolsets?, toolPolicy? })` (a field left out keeps
its value, `null` clears it), `unbind`, `getBinding`. Instructions (≤ 64 KB) are appended to
the system prompt. The binding applies from the next provider session: an idle chat is
restarted at once, a busy one when it is next idle (`pendingRestart: true`). Bind before the
first `send`. A fork of a bound chat stays bound; removing the extension **closes** its chats
(every later turn is refused with the reason).

A `toolPolicy` makes the chat's tools **exhaustive** — every call is allowed or denied, none
waits on an approval card:

- `Read`/`Glob`/`Grep` inside `readRoots`; `Write`/`Edit`/`MultiEdit`/`NotebookEdit` inside
  `writeRoots` (never through a symlink or hard link). Roots are absolute; a root at or above
  the home directory is not supported.
- Always refused for writes: `.git`, git hooks folders (including `core.hooksPath`),
  `package.json`, lockfiles, package-manager configs, `node_modules`, `CLAUDE.md`,
  `AGENTS.md`, `.claude/`, `.codex/`, `.mcp.json`, `.envrc`, `.vscode/`, `.github/`, plus
  your own `protectedPaths` (globs, matched at any depth).
- Always refused, even inside a root: PPM's directory and backups, `~/.claude`, `~/.codex`,
  `~/.ssh`, `~/.cloudflared`, git, npm, cloud and Docker credentials.
- Questions, plan approval, shell, subagents, web tools and every other MCP server are denied
  unless `allowTools` names them; the extension's own MCP tools and `ToolSearch` are allowed.
- The chat runs in `acceptEdits` (or `default`), never bypass, and gets no tab or database
  tools and none of the user's MCP servers.

**One-shot AI (`ppm.ai`).** `complete({ provider: "claude" | "codex", model, system, prompt,
jsonSchema?, webSearch?, accountId?, timeoutMs? }, { signal? })` answers one prompt with no
chat behind it: `{ text, json?, inputTokens, outputTokens, provider, model, accountId? }`.

- With `jsonSchema` the answer is validated (type, enum, const, properties, required,
  additionalProperties, items, lengths, `pattern`, bounds) and asked for once more on a miss;
  `json` is then always valid. A `pattern` that could backtrack without bound is refused.
- `webSearch`: Claude gets WebSearch only (no WebFetch); Codex gets live search with its
  shell, subagents, image generation, apps and plugins off.
- Without `accountId`, the usable account with the lowest 5-hour use answers; the chats'
  account rotation is never moved.
- 4 calls per extension at once, 32 waiting (60 s at most), 8 across all extensions.
- Aborting `signal` rejects with an `AbortError` and stops the provider call itself.
- Failures are `PpmAiError` with `code`: `BAD_REQUEST`, `NO_ACCOUNT`, `PROVIDER_UNAVAILABLE`,
  `QUEUE_FULL`, `QUEUE_TIMEOUT`, `BAD_JSON` (with `raw`), `RATE_LIMITED`, `TIMEOUT`,
  `ABORTED`, `PROVIDER_ERROR`. `listModels()` gives the model ids per provider.

**Usage and presence.** `ppm.usage.get()` gives each Claude and Codex account's 5-hour, weekly
and per-model weekly use (`usedPct`, `resetsAt`, `resetsInMs`, `ageMs`) under a neutral alias
("Claude 1"); never a label, email or token. `ppm.presence.get()` says whether a person touched
any PPM tab in the last 10 minutes. A webview counts only when it posts
`{ command: "__ppm.userActivity" }` from real input. Presence is a reason to pause, never a
permission to spend.

**MCP tools (`ppm.mcp`).** `registerToolset({ id, title, tools: [{ name, description,
inputSchema }] }, handler)` serves tools to the chats bound to that toolset (`bind(...,
{ toolsets: [id] })`); the agent sees `mcp__ppm-ext__<id>_<name>`. Register inside `activate()`
and `await registration.registered` (the exposed names, or why it was refused).

- `id`: 2–16 lowercase letters or digits; 1–40 tools; `<id>_<name>` at most **50 characters**
  (Claude refuses a tool name over 64, and with it the whole request).
- `inputSchema` is a JSON Schema of type `object`, ≤ 16 KB, local `$ref` only.
- `handler(name, args, { sessionId, turnOrigin, signal })` returns `{ text, isError? }`.
  `turnOrigin` is `"ws"` when a person typed the message, `"extension"` for a headless turn.
- A call may run 10 minutes; `signal` aborts when the model gives up, the time runs out or the
  host restarts. Start long work and return; let the model poll a status tool. Answers over
  200 KB are cut.
- While the extension is down, chats still list its last registered tools and a call answers
  "starting"; a disabled extension's tools answer that it is off.

**Notifications (`ppm.notify`).** `notify({ title, body, sessionId?, projectName?, path? })`
goes out through PPM's own channels (push, Telegram, ntfy) under Settings → Notifications →
Extensions, titled "<display name>: <title>". Title 1–120 characters, body up to 1,000; a tap
opens the session, the project or an in-app `path`. 30 per hour per extension; refusals are
`PpmNotifyError` (`BAD_REQUEST`, `RATE_LIMITED`). The call answers within ~2s — well inside the
10s RPC limit — resolving `"sent" | "off" | "replaced" | "seen"` when that is already known, else
`"queued"` while the real send (which can wait out PPM's own notification delay, 60s by default)
keeps running in the background.

`tests/e2e/extension-ai-core-e2e.mjs` drives most of this through a probe extension
(`tests/e2e/fixtures/ext-ai-probe/`), a useful minimal example.

### Utilities

```typescript
// URI
const uri = vscode.Uri.file("/path/to/file");
const webUri = panel.webview.asWebviewUri(uri);

// Disposable
const disposable = vscode.Disposable.from(
  vscode.commands.registerCommand("a", () => {}),
  vscode.commands.registerCommand("b", () => {})
);

// EventEmitter
const emitter = new vscode.EventEmitter<string>();
emitter.fire("event data");  // Notify listeners
// const unsub = emitter.event((data) => {});
```

---

## API Support Matrix

| Feature | Status | Notes |
|---------|--------|-------|
| **Commands** | ✅ Supported | `registerCommand`, `executeCommand` |
| **Messages** | ✅ Supported | Info, warning, error dialogs |
| **Quick Pick** | ✅ Supported | Single/multi-select, filtering |
| **Input Box** | ✅ Supported | Text input with validation (client-side) |
| **Status Bar** | ✅ Supported | Left/right alignment, priority, commands |
| **Tree View** | ✅ Supported | Hierarchical sidebar trees |
| **Webview Panel** | ✅ Supported | Sandboxed iframe, 2-way messaging |
| **Workspace Config** | ✅ Supported | Read/write user & workspace settings |
| **Workspace FS** | ⚠️ Partial | Read, write, stat, readDirectory (no watch) |
| **Process Spawn** | ✅ Supported | Run external commands (git, npm, etc.) |
| **Storage (Memento)** | ✅ Supported | Global & workspace state, auto-persisted |
| **Data directory** | ✅ PPM | `context.globalStoragePath`, survives removal |
| **Composer** | ✅ PPM | `window.showComposer` returns what the user wrote |
| **Window placement** | ✅ PPM | `createWebviewPanel(..., { preferWindow })` |
| **Chat sessions** | ✅ PPM | `ppm.chat`: headless turns, binding, tool policy (binding: Claude only) |
| **One-shot AI** | ✅ PPM | `ppm.ai.complete` (Claude, Codex), JSON Schema, cancel |
| **Usage / presence** | ✅ PPM | `ppm.usage`, `ppm.presence` — read-only |
| **MCP tools** | ✅ PPM | `ppm.mcp.registerToolset`, served to bound Claude chats |
| **Notifications** | ✅ PPM | `ppm.notify`, 30 per hour |
| **Uri** | ✅ Supported | File/webview URI utilities |
| **EventEmitter** | ✅ Supported | Custom event streams |
| **Disposable** | ✅ Supported | Cleanup & resource management |
| **Environment** | ✅ Supported | App name, machine ID |
| **Languages** | ❌ Not supported | Syntax highlighting, language services |
| **Debug** | ❌ Not supported | Debugger integration |
| **Tasks** | ❌ Not supported | Task provider, task execution |
| **SCM** | ❌ Not supported | Source control providers |
| **Notebooks** | ❌ Not supported | Notebook editing |
| **Authentication** | ❌ Not supported | Auth provider, sessions |
| **Tests** | ❌ Not supported | Test controller |

---

## Webview Details

### Sandbox

Webviews run in a sandboxed iframe with **`allow-scripts` only** — no inline styles, event handlers, or external scripts. Use a bundler or inline `<style>` tags.

`allow-scripts` alone also means **no `alert`, `confirm` or `prompt`**. The sandbox blocks every
modal API, and a blocked `prompt()` simply returns `null` — no exception, no console warning — so a
"Name the new branch" flow written that way looks fine in review and does nothing at runtime.
Collect the answer in the panel instead: an inline row with an `<input>` and a confirm button, or a
dialog you render yourself. The reflog panel's `confirmHtml`
(`packages/ext-git-graph/src/reflog-view.ts`) is the pattern.

### Backticks in webview scripts

Panel HTML is built inside a TypeScript template literal, so **anything in that string that contains
a backtick ends the literal early**. A `` `code span` `` in a JS comment is the usual culprit, and
the resulting error points at whatever token happens to follow — `TS1005: ',' expected` a hundred
lines away — never at the comment. Write those comments without backticks.

### Panels need a tab, and only the frontend can create one

`createWebviewPanel` makes a panel on the server. The frontend only creates a *tab* for it when
that browser tab is the one that dispatched the command. So a panel your extension opens on its
own initiative — say, one view navigating to another — exists with nothing to display it.

To open one of your panels from another, ask the frontend for the tab instead:

```typescript
await vscode.window.openTab("extension", "Blame: app.ts", projectName, {
  viewType: "my-ext.blame",       // must equal the command that opens it
  extensionId: context.extensionId,
  projectName,
});
```

The frontend then notices a tab with no panel and dispatches `my-ext.blame` itself, which *is* a
local dispatch, so the panel binds to the tab. That recovery dispatch passes only the project path,
so anything else the target panel needs (a file, a pair of refs) must be stashed in the extension
and picked up when the panel opens.

**The command id and the viewType must be identical.** The frontend derives a tab slug from each by
stripping a trailing `.view`; if the two slugs differ, no tab is ever created and nothing reports an
error. One command per viewType, always.

### Communication

**From webview to extension:**
```typescript
const vscode = acquireVsCodeApi();
vscode.postMessage({ type: "action", data: "..." });
```

**From extension to webview:**
```typescript
panel.webview.postMessage({ type: "update", data: "..." });
panel.webview.onDidReceiveMessage((msg) => {
  console.log("From webview:", msg);
});
```

### HTML Setup

```html
<!DOCTYPE html>
<html>
<head>
  <style>
    body { font-family: sans-serif; padding: 20px; }
    button { padding: 8px 16px; cursor: pointer; }
  </style>
</head>
<body>
  <h1>My Webview</h1>
  <button id="btn">Send Message</button>
  
  <script>
    const vscode = acquireVsCodeApi();
    
    document.getElementById("btn").onclick = () => {
      vscode.postMessage({ type: "click", time: Date.now() });
    };
    
    window.addEventListener("message", (e) => {
      const { type, data } = e.data;
      if (type === "update") {
        document.body.innerHTML += `<p>${data}</p>`;
      }
    });
  </script>
</body>
</html>
```

---

## Porting from VSCode

PPM uses the same API shape as VSCode. Porting is straightforward:

### 1. Update imports

**Before (VSCode):**
```typescript
import * as vscode from "vscode";

export function activate(context: vscode.ExtensionContext) {
  // ...
}
```

**After (PPM):**
```typescript
import type { ExtensionContext } from "@ppm/vscode-compat";

export function activate(context: ExtensionContext, vscode: any) {
  // vscode is passed as 2nd argument
  // ...
}
```

Or import for type checking:
```typescript
import * as vscode from "@ppm/vscode-compat";

export function activate(context: ExtensionContext, _vscode: typeof vscode) {
  // ...
}
```

### 2. Update package.json

```json
{
  "engines": { "ppm": ">=0.9.0" }  // was vscode
}
```

### 3. Check API support

Verify unsupported features aren't used (see API Support Matrix above).

### 4. Test

```bash
ppm ext dev ./path/to/extension
```

---

## Examples

### Database Viewer

See `packages/ext-database/` in the PPM repo for a complete reference extension:

- **Tree view** of database connections
- **Commands** to open query panel
- **Webview panel** for SQL editor
- **Status bar** icon
- **Configuration** (maxRows, autoConnect)
- **RPC to backend** for queries

```typescript
export function activate(context: ExtensionContext, vscode: any) {
  // Tree view
  const provider = new ConnectionTreeProvider();
  const tree = vscode.window.createTreeView("ppm-db.connections", {
    treeDataProvider: provider
  });
  context.subscriptions.push(tree);

  // Command
  context.subscriptions.push(
    vscode.commands.registerCommand("ppm-db.openViewer", (connId) => {
      const panel = vscode.window.createWebviewPanel(
        "ppm-db.query",
        "Query",
        vscode.ViewColumn.Active
      );
      panel.webview.html = `...`;
      panel.webview.onDidReceiveMessage(async (msg) => {
        if (msg.type === "query") {
          const res = await fetch(`/api/db/${connId}/query`, {
            method: "POST",
            body: JSON.stringify({ sql: msg.sql })
          });
          await panel.webview.postMessage(await res.json());
        }
      });
    })
  );

  // Status bar
  const status = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right
  );
  status.text = "DB";
  status.show();
  context.subscriptions.push(status);
}
```

### Git Graph

See `packages/ext-git-graph/` for an extension using **process:spawn** to run git commands:

- **Process spawning** via RPC to execute `git log` across any registered project
- **SVG graph rendering** faithful port of vscode-git-graph algorithm:
  - Single SVG overlay with continuous branch paths (Bézier curves)
  - Shadow lines for visual depth
  - HEAD and stash node indicators
  - Color-coded column tracking for branch visualization
- **Webview panel** for interactive visualization with scrolling commit list
- **Commit details** panel with author, date, message, and file changes
- **Context menu** for actions (checkout, cherry-pick, etc.)
- **Search/find** widget with navigation within the graph

Key patterns:
- Use `process:spawn` RPC to safely run git commands from any registered project root
- Parse git log output and compute graph coordinates (row, column, edge routing)
- Render single SVG overlay synchronized with commit list rows
- Implement custom graph rendering algorithm (path computation, Bézier curves, node placement)
- Two-way messaging between extension and webview for interactions and detail panel updates

---

## Best Practices

1. **Cleanup**: Always push disposables to `context.subscriptions`.
2. **Errors**: Catch and show errors via `showErrorMessage()`.
3. **Async**: Use `await` for RPC calls; block UI during long operations.
4. **Storage**: Use `Memento` for small settings, `context.globalStoragePath` for anything larger.
5. **Webview Security**: Never use `eval()`, `innerHTML` with user input, or external CDNs.
6. **Activation**: Lazy-load expensive code via activation events, not on require.
7. **Testing**: Use `ppm ext dev` to load locally before publishing.

---

## Publishing

Register your extension with PPM's extension registry (coming in v0.9). For now, distribute via npm or GitHub.

---

## Troubleshooting

| Issue | Solution |
|-------|----------|
| Extension doesn't activate | Check `activationEvents` in package.json matches your commands/views |
| Command not found | Verify `contributes.commands[].command` id |
| Tree view empty | Implement `getChildren()` and `getTreeItem()` in provider |
| Webview blank | Check `panel.webview.html` is valid HTML; test in browser first |
| RPC timeout | A call ran past the 10 s default; use `requestWithTimeout` (see Long RPC calls) |
| Storage not persisted | Use `Memento.update()`, not local variables |
| Unsupported API error | Check API Support Matrix; file issue if critical |

---

## Learn More

- [VSCode Extension API](https://code.visualstudio.com/api) — reference (PPM subset)
- `packages/ext-database/` — working example
- `packages/vscode-compat/src/` — API implementation
- GitHub issues — feature requests & bugs
