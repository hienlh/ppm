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

**Row extras** (PPM additions to the VSCode tree item). Each row is one line, so put the full
text in `tooltip`:

```typescript
getTreeItem(item: LooseEnd) {
  return {
    id: item.id,
    label: item.title,                       // one line, truncated in the sidebar
    tooltip: `${item.title}\n${item.reason} · ${item.project} · ${item.age}`, // line breaks kept
    description: item.age,                   // small text after the label
    iconPath: "git-pull-request",            // a name from the icon list below
    badge: 3,                                // small count at the row end
    url: item.url,                           // http(s) only: the label becomes a link
    actions: [                               // inline buttons, two at most
      { icon: "check", tooltip: "Done", command: "midday.done", commandArgs: [item.id] },
      { icon: "clock", tooltip: "Snooze", command: "midday.snooze", commandArgs: [item.id] },
    ],
  };
}
```

- **Tooltip** shows on hover. On a phone, a **long press** opens a sheet with the full label,
  `description` and `tooltip` on top, then each action as a full-width button, then **Open**.
  Right-clicking a row on a desktop shows the same menu. A tap still does what the row does.
- **Actions** show on hover or keyboard focus with a mouse, and always on touch.
- **url**: a worker cannot open a browser tab, so the row's label becomes a link that opens in a
  new tab on the device that was tapped. Anything but `http:`/`https:` is dropped.
- **Icon names** (row `iconPath` and action `icon`): `check`, `clock`, `question`, `shield`,
  `stop`, `hourglass`, `git-pull-request`, `ticket`, `message`, `sun`, `warning`, `x-circle`,
  `refresh`, `edit`, `trash`, `plus`, `search`, `git-branch`, `git-commit`, `git-compare`,
  `history`, `users`, `list-ordered`, `database`, `terminal`, `settings`, `file-code`, `globe`.
  An unknown action icon draws a refresh arrow, and an unknown row icon draws nothing.

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

Run a command-line tool on the host with `vscode.process.spawn` (the second argument of
`activate`). The main thread runs it with `Bun.spawn` and an argument array, never through a
shell, so arguments are passed as they are and nothing is ever interpreted by a shell.

```typescript
const result = await vscode.process.spawn(
  "gh",                                   // command: one of the allowlist below
  ["pr", "list", "--json", "number,title"], // arguments, one string each
  projectPath,                            // cwd (positional, required)
  {                                       // options (optional)
    timeout: 45_000,                      // kill the process after this long, in ms
    env: { GH_PROMPT_DISABLED: "1", NO_COLOR: "1" },
  },
);
// { stdout: string, stderr: string, exitCode: number }
if (result.exitCode !== 0) console.warn(result.stderr);
```

**Only `git`, `gh`, `node`, `bun`, `npx` and `sqlite3` may be spawned.** The command is matched
by its base name. Anything else, including coreutils like `test` or `cat`, makes the call
*throw*, not return a non-zero exit code. That matters: a `try/catch` around the call swallows
the failure and leaves the feature silently doing nothing. Check for a file with
`workspace.fs.stat` rather than shelling out to `test`. A command on the list that is not
installed on the host (`gh` often is not) also throws, with `process:spawn failed: …`.

`gh` runs under the host user's own GitHub login, the same trust as `git` with its credentials.
Pass `GH_PROMPT_DISABLED=1` so it never waits for an answer nobody can type.

Rules:

- **cwd** must be inside a registered project, PPM's working directory, or
  `<ppm dir>/extensions`. Anything else throws `Path outside allowed scope`.
- **env** is merged over the host's environment, so `PATH` survives. `PATH`, `HOME`,
  `LD_PRELOAD`, `DYLD_INSERT_LIBRARIES` and `LD_LIBRARY_PATH` cannot be overridden.
- **timeout** defaults to 30 s and is capped at 15 minutes, whatever you ask for. A process past
  its timeout is killed and reported with its exit code; it does not throw.
- The call waits the process's own timeout plus 30 s for the main thread's answer, so a command
  allowed to run for a minute is not cut off by the 10 s limit ordinary calls have.
- stdout and stderr come back whole, as strings. Keep the output bounded (`--limit`, `-n`).

**Example: listing commits**

```typescript
context.subscriptions.push(
  vscode.commands.registerCommand("myext.log", async (projectPath: string) => {
    const { stdout, exitCode, stderr } = await vscode.process.spawn("git", ["log", "--oneline", "-n", "10"], projectPath);
    if (exitCode !== 0) return vscode.window.showErrorMessage(`git failed: ${stderr}`);
    return stdout.split("\n").filter(Boolean);
  }),
);
```

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

A tree item may carry PPM extras: `badge` (a short count or label at the row end), `color` (a
CSS colour for the dot before the label), `actions` (at most two inline buttons, each
`{ icon, tooltip, command, commandArgs? }`, where `icon` is a name in
`src/web/lib/extension-icons.ts`; an unknown name draws a refresh arrow), `commandArgs` (the
arguments a row click passes, ahead of `command.arguments`), `url` (an http(s) page the row
opens in a new tab on the device that taps it) and `wrap` (the label wraps instead of being cut
short, for a row whose text is a sentence: a setup step, a warning).

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

- An extension may send to, cancel and read (`state()`, `lastAssistantText()`) only sessions it
  created.
- At most 4 sessions per extension with a turn running or queued (`TOO_MANY_HEADLESS_TURNS`).
- A message sent while a turn runs is queued as a turn of its own; it never changes the
  running one, a person's included, and never answers an approval waiting there. Only one
  message may wait for the next turn: when that turn already belongs to a person's queued
  message or another extension's, the call is refused (`BUSY_QUEUED`). A Claude session asked for another model, effort or
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
first `send`. A fork of a bound chat stays bound, and so does the new chat `/clear` starts: it
clears the context, not the binding, and is refused on a provider that cannot hold one.
Removing the extension **closes** its chats (every later turn is refused with the reason); a
folder PPM merely did not find at startup closes nothing.

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

**Notifications (`ppm.notify`)**: see [Notifications](#notifications-apippmnotify) below.

`tests/e2e/extension-ai-core-e2e.mjs` drives most of this through a probe extension
(`tests/e2e/fixtures/ext-ai-probe/`), a useful minimal example.

### Notifications (`api.ppm.notify`)

Tell the person something through PPM's own channels (push to their phone, Telegram, ntfy), under
the **Extensions** switch in Settings → Notifications. `ppm` is a PPM addition to the API object
your `activate(context, api)` receives; an older PPM has none, so feature-detect it:

```typescript
if (typeof api.ppm?.notify === "function") {
  const outcome = await api.ppm.notify({
    title: "Midday check-in",                 // 1–120 characters, shown as "<displayName>: <title>"
    body: "3 things done this morning",       // at most 1,000 characters
    projectName: "ppm",                       // optional: a registered project, opened first
    open: { view: "midday.checkIn" },         // optional: what a tap opens (here, a panel)
  });
  // "sent" | "off" | "replaced" | "seen" | "queued"
} else {
  await vscode.window.showInformationMessage("3 things done this morning"); // a toast only
}
```

- **What a tap opens**: give at most one of `open`, `sessionId` (a chat) or `path` (an in-app
  path starting with `/`). `open` is `{ view }` or `{ command, args? }`, and either one must be
  listed in **`contributes.deepLinkCommands`** (each entry must also be in `contributes.commands`).
  - `{ view }` opens one of **your own** panels: a webview panel's viewType equals the command
    that opens it, so `{ view: "midday.checkIn" }` opens that panel. A view is no exception to
    the list, because the tab it opens runs the command of that name.
  - `{ command, args? }` runs the command. `args` holds at most 8 strings, numbers, booleans or
    nulls, 1 KB as JSON.
  - Anything not listed is refused when you call `notify` (`BAD_REQUEST`), and the browser refuses
    it again, even from a URL typed by hand. A tab saved in the layout from such a link never runs
    its command on a reload either: a tab only reopens its panel when the extension that owns the
    command recorded itself on the tab (any panel you open yourself, or `window.openTab` from your
    extension) or when the command is in `deepLinkCommands`.
  - The link is `/project/<projectName>?extCommand=<command>&extArgs=<base64url JSON>` (or
    `extView=`), so it works the same from push, Telegram and ntfy. The app runs it on the device
    that was tapped, once your extension is active (it waits up to 20 s), and removes it from the
    address bar.
- **List only commands that open something**: anyone who receives the notification, or types the
  URL, can open it, and opening it twice runs it twice. Never list an action that changes data
  (marking an item done, snoozing it): put that on a button inside the panel the link opens.

  ```json
  "contributes": {
    "commands": [
      { "command": "midday.checkIn", "title": "Midday: Check-in" },
      { "command": "midday.showItem", "title": "Midday: Show item" },
      { "command": "midday.done", "title": "Midday: Done" }
    ],
    "deepLinkCommands": ["midday.checkIn", "midday.showItem"]
  }
  ```
- **Outcome**: the call answers within about 2 s. `queued` means PPM's notification delay
  (Settings, 60 s by default) had not decided yet; the notification is still sent unless the
  person saw the thing meanwhile. `off` means the Extensions switch is off.
- **Limits**: 30 notifications an hour per extension. Beyond that, and for a bad request, the call
  throws a `PpmNotifyError` whose `code` is `RATE_LIMITED` or `BAD_REQUEST`.

### Commands from the CLI

An extension command can be run from a terminal, by the user or by an AI agent through its shell.

**`ppm ext run <command> [args…]`** runs any command your extension declares in
`contributes.commands`, on the running server. Each token after the command is passed as its own
argument, so the handler is called as `handler(...tokens)`. `--json` (print the result as one
line of JSON) and `--timeout <ms>` (1,000 to 600,000; default 60,000) belong to `ext run`
wherever they appear; put them after `--` to pass them through.

**Your own top-level command**: declare it in the manifest and `ppm <name> …` forwards every
token after the name, `--json` and `--help` included, as one array:

```json
"contributes": {
  "commands": [{ "command": "midday.cli", "title": "Midday: CLI" }],
  "cli": [{ "name": "midday", "description": "Loose ends, noon check-in and weekly review", "command": "midday.cli" }]
}
```

```typescript
vscode.commands.registerCommand("midday.cli", async (argv: string[]) => {
  if (argv.includes("--help")) return "Usage: ppm midday list [--json] …";
  const items = await cachedItems();
  return argv.includes("--json") ? items : items.map((i) => `- ${i.title}`).join("\n");
});
```

- `name` matches `^[a-z][a-z0-9-]{1,30}$` and can never be a built-in command (`start`, `stop`,
  `projects`, `ext`, `help`, …). `command` must be declared in the same manifest. When two enabled
  extensions claim one name, the extension id that sorts first keeps it. Only enabled extensions
  count, and the CLI reads the manifests from disk without starting your extension.
- **Output**: a string result is printed as it is, with a newline added; any other value as
  indented JSON; `null`/`undefined` prints nothing. `ppm ext run --json` always prints one line of
  JSON. Neither prints the `PPM vX` banner, so `--json` output can be piped.
- **Exit codes**: 0 success; 1 the server is not running or refused the token; 2 the command
  never ran (not declared, extension not active, host not ready); 3 it threw or timed out. The
  error goes to stderr.
- **Never open a dialog from a CLI handler** (`showQuickPick`, `showInputBox`): no browser is
  waiting for it, and the call times out. **Answer within the timeout** (60 s for an alias): serve
  from a cache and refresh in the background.
- The handler's result crosses to the server by structured clone and then JSON, so return plain
  data. A value that cannot be cloned (a function, a class with methods) fails the command.
- Every chat's AI is told which `ppm <name>` commands enabled extensions provide, with your
  `description`, so keep it short and plain.

### The user's time zone (`vscode.env.clientTimeZone`)

PPM often runs on a machine in another country from the person using it, so the host's own zone
is the wrong one for anything shown or scheduled for them. The browser reports its IANA zone
(`Europe/London`) each time it connects; read it as `vscode.env.clientTimeZone`, which is
`undefined` until a browser connects after PPM starts:

```typescript
const zone = vscode.env.clientTimeZone;            // "Europe/London" | undefined
context.subscriptions.push(
  vscode.env.onDidChangeClientTimeZone(({ timeZone, deviceId }) => {
    // Fires only when a browser reports a zone different from the last one.
  }),
);
```

Store the zone your extension uses in its own settings and ask before switching: a person opening
PPM on a laptop still set to another zone should not move their reminders silently.

### Restart survival

Installed (`ppm ext install`) and dev-linked (`ppm ext dev`) extensions are rediscovered from
`<ppm dir>/extensions/node_modules` on every start, and keep their `globalState` and
`workspaceState`. Discovery only accepts a package whose `package.json` has a `ppm`,
`contributes` or `engines.ppm` field, so a dependency of your extension is never registered as an
extension itself; a package without any of the three is skipped with a warning in the log.

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
| **Process Spawn** | ✅ Supported | `git`, `gh`, `node`, `bun`, `npx`, `sqlite3` only |
| **Notifications** | ✅ PPM addition | `api.ppm.notify`, with a deep link to your own command or panel |
| **CLI commands** | ✅ PPM addition | `ppm ext run`, `contributes.cli` aliases |
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
| **Environment** | ✅ Supported | App name, machine ID, `clientTimeZone` (PPM addition) |
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
| RPC timeout | A call ran past its limit: 10 s for ordinary calls, the process timeout + 30 s for `process.spawn`. Use `requestWithTimeout` for a long call of your own (see Long RPC calls), raise `timeout` on a spawn, or answer from a cache |
| `ppm <name>` says the command does not exist | The extension is disabled, its `cli` entry was refused (name taken by a built-in or another extension, `command` not declared): run `PPM_DEBUG=1 ppm --help` |
| Storage not persisted | Use `Memento.update()`, not local variables |
| Unsupported API error | Check API Support Matrix; file issue if critical |

---

## Learn More

- [VSCode Extension API](https://code.visualstudio.com/api) — reference (PPM subset)
- `packages/ext-database/` — working example
- `packages/vscode-compat/src/` — API implementation
- GitHub issues — feature requests & bugs
