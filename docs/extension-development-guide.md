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

```typescript
// Inside your extension (via RPC)
const rpc = (context as any).rpc;

const result = await rpc.request("process:spawn", [
  "git",                    // command (must be in allowlist)
  ["log", "--oneline", "-n", "10"],  // args array
  { cwd: process.cwd() }    // options: { cwd?: string, timeout?: number }
]);

// Result structure
if (!result.error) {
  const { code, stdout, stderr } = result;
  console.log("Exit code:", code);
  console.log("Output:", stdout);
} else {
  console.error("Command failed:", result.error);
}
```

**Allowed Commands** (security allowlist):
- `git` — Version control operations
- `node`, `bun` — JavaScript runtimes
- `npm`, `yarn`, `pnpm` — Package managers
- `docker` — Container operations
- `psql` — PostgreSQL CLI
- `sqlite3` — SQLite CLI
- `python3`, `python` — Python runtime

**Restrictions:**
- CWD limited to current project root (no path escaping)
- 30-second timeout by default
- Stdout/stderr captured as strings
- Non-zero exit codes returned as error

**Example: Git Graph Extension**

```typescript
// In ext-git-graph, spawn git to fetch log
export async function activate(context: ExtensionContext, vscode: any) {
  const rpc = (context as any).rpc;
  
  context.subscriptions.push(
    vscode.commands.registerCommand("git-graph.view", async () => {
      try {
        const result = await rpc.request("process:spawn", [
          "git",
          ["log", "--all", "--oneline", "--graph"],
          { cwd: process.cwd() }
        ]);
        
        if (result.error) {
          await vscode.window.showErrorMessage(`Git error: ${result.error}`);
          return;
        }
        
        // Parse result.stdout and render graph in webview
        const commits = parseGitLog(result.stdout);
        const panel = vscode.window.createWebviewPanel("git-graph", "Git Graph", vscode.ViewColumn.Active);
        panel.webview.html = renderSvgGraph(commits);
      } catch (e) {
        await vscode.window.showErrorMessage(`Failed to load git graph: ${e}`);
      }
    })
  );
}
```

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
4. **Storage**: Use `Memento` for persistence, not file system (unless granted access).
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
| RPC timeout | Network issue or long-running request; add retry logic |
| Storage not persisted | Use `Memento.update()`, not local variables |
| Unsupported API error | Check API Support Matrix; file issue if critical |

---

## Learn More

- [VSCode Extension API](https://code.visualstudio.com/api) — reference (PPM subset)
- `packages/ext-database/` — working example
- `packages/vscode-compat/src/` — API implementation
- GitHub issues — feature requests & bugs
