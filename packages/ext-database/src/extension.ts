/**
 * @ppm/ext-database — Database Viewer extension for PPM.
 * Provides a sidebar tree view of DB connections/tables/columns
 * and a full-featured table viewer webview with inline editing,
 * pagination, and SQL query panel.
 */
import type { ExtensionContext } from "@ppm/vscode-compat";
import { ConnectionTreeProvider } from "./connection-tree.ts";
import { getQueryPanelHtml } from "./query-panel.ts";
import { getTableViewerHtml } from "./table-viewer-panel.ts";

/** PPM vscode-compat API namespace (passed as second arg by Worker) */
interface VscodeApi {
  commands: {
    registerCommand(command: string, callback: (...args: unknown[]) => unknown): { dispose(): void };
  };
  window: {
    showInformationMessage(message: string, ...items: string[]): Promise<string | undefined>;
    showErrorMessage(message: string, ...items: string[]): Promise<string | undefined>;
    showQuickPick(items: string[], options?: { placeHolder?: string }): Promise<string | undefined>;
    showInputBox(options?: { prompt?: string; placeHolder?: string; value?: string }): Promise<string | undefined>;
    createTreeView(viewId: string, options: { treeDataProvider: unknown }): { dispose(): void };
    createWebviewPanel(viewType: string, title: string, showOptions: unknown): {
      webview: {
        html: string;
        onDidReceiveMessage: (listener: (msg: unknown) => void) => { dispose(): void };
        postMessage(message: unknown): Promise<boolean>;
      };
      onDidDispose: (listener: () => void) => { dispose(): void };
      dispose(): void;
    };
    createStatusBarItem(alignment?: unknown, priority?: number): {
      text: string; tooltip?: string; command?: string;
      show(): void; hide(): void; dispose(): void;
    };
  };
  EventEmitter: new <T>() => { fire(data?: T): void; event: unknown; dispose(): void };
  StatusBarAlignment: { Left: number; Right: number };
  ViewColumn: { Active: number };
}

// Server base URL for fetch() calls (set by Worker before activation)
let baseUrl = "";

export function activate(context: ExtensionContext, vscode: VscodeApi): void {
  baseUrl = (globalThis as any).__PPM_BASE_URL__ || "";

  // --- Tree View ---
  const emitter = new vscode.EventEmitter<unknown>();
  const treeProvider = new ConnectionTreeProvider(
    { fire: (el?: unknown) => emitter.fire(el), event: emitter.event },
    baseUrl,
  );

  const treeView = vscode.window.createTreeView("ppm-db.connections", {
    treeDataProvider: treeProvider,
  });
  context.subscriptions.push(treeView);

  // --- Commands ---
  context.subscriptions.push(
    vscode.commands.registerCommand("ppm-db.openViewer", (...args: unknown[]) => {
      const connectionId = (args[0] as number) ?? 1;
      const connectionName = (args[1] as string) ?? "Database";
      const tableName = args[2] as string | undefined;
      const schemaName = (args[3] as string) ?? "public";
      if (tableName) {
        openTableViewer(vscode, context, connectionId, connectionName, tableName, schemaName);
      } else {
        openQueryPanel(vscode, context, connectionId, connectionName);
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("ppm-db.runQuery", () => {
      openQueryPanel(vscode, context, 1, "Default");
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("ppm-db.refreshConnections", () => {
      treeProvider.refresh();
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("ppm-db.refreshConnection", () => {
      treeProvider.refresh();
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("ppm-db.addConnection", async () => {
      await addConnection(vscode, treeProvider);
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("ppm-db.editConnection", async (...args: unknown[]) => {
      const connectionId = args[0] as number;
      if (connectionId) await editConnection(vscode, treeProvider, connectionId);
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("ppm-db.deleteConnection", async (...args: unknown[]) => {
      const connectionId = args[0] as number;
      const connectionName = (args[1] as string) ?? "this connection";
      if (!connectionId) return;
      const confirm = await vscode.window.showQuickPick(["Yes, delete", "Cancel"], {
        placeHolder: `Delete "${connectionName}"?`,
      });
      if (confirm !== "Yes, delete") return;
      try {
        const res = await fetch(`${baseUrl}/api/db/connections/${connectionId}`, { method: "DELETE" });
        const json = await res.json() as { ok: boolean; error?: string };
        if (json.ok) {
          await vscode.window.showInformationMessage(`Connection "${connectionName}" deleted`);
          treeProvider.refresh();
        } else {
          await vscode.window.showErrorMessage(json.error ?? "Failed to delete connection");
        }
      } catch (e) {
        await vscode.window.showErrorMessage(`Error: ${e instanceof Error ? e.message : String(e)}`);
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("ppm-db.testConnection", async (...args: unknown[]) => {
      const connectionId = args[0] as number;
      if (!connectionId) return;
      try {
        const res = await fetch(`${baseUrl}/api/db/connections/${connectionId}/test`, { method: "POST" });
        const json = await res.json() as { ok: boolean; data?: { ok: boolean; error?: string } };
        if (json.ok && json.data?.ok) {
          await vscode.window.showInformationMessage("Connection successful");
        } else {
          await vscode.window.showErrorMessage(`Connection failed: ${json.data?.error ?? "Unknown error"}`);
        }
      } catch (e) {
        await vscode.window.showErrorMessage(`Error: ${e instanceof Error ? e.message : String(e)}`);
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("ppm-db.exportConnections", async () => {
      await exportConnections(vscode);
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("ppm-db.importConnections", async () => {
      await importConnections(vscode, treeProvider);
    }),
  );

  // --- Status Bar ---
  const statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 10);
  statusItem.text = "DB";
  statusItem.tooltip = "Database Viewer";
  statusItem.command = "ppm-db.runQuery";
  statusItem.show();
  context.subscriptions.push(statusItem);

  console.log("[ext-database] activated");
}

export function deactivate(): void {
  console.log("[ext-database] deactivated");
}

// ---------------------------------------------------------------------------
// Table Viewer — full-featured data grid with inline editing & SQL panel
// ---------------------------------------------------------------------------

function openTableViewer(
  vscode: VscodeApi,
  context: ExtensionContext,
  connectionId: number,
  connectionName: string,
  tableName: string,
  schemaName: string,
): void {
  const panel = vscode.window.createWebviewPanel(
    "ppm-db.tableViewer",
    `${connectionName} · ${tableName}`,
    vscode.ViewColumn.Active,
  );

  panel.webview.html = getTableViewerHtml({ connectionId, connectionName, tableName, schemaName });

  const msgDisposable = panel.webview.onDidReceiveMessage(async (raw: unknown) => {
    const msg = raw as Record<string, unknown>;
    const connId = (msg.connectionId as number) ?? connectionId;
    const tbl = (msg.tableName as string) ?? tableName;
    const schema = (msg.schemaName as string) ?? schemaName;

    switch (msg.type) {
      case "init":
      case "refresh":
        await sendTableData(panel, connId, tbl, schema, (msg.page as number) ?? 1);
        break;

      case "fetchPage":
        await sendTableData(panel, connId, tbl, schema, (msg.page as number) ?? 1);
        break;

      case "executeQuery":
        await handleQuery(panel, connId, msg.sql as string);
        break;

      case "updateCell":
        await handleCellUpdate(panel, connId, tbl, schema, msg);
        break;
    }
  });
  context.subscriptions.push(msgDisposable);
  panel.onDidDispose(() => msgDisposable.dispose());
}

/** Fetch table data + schema and send to webview */
async function sendTableData(
  panel: ReturnType<VscodeApi["window"]["createWebviewPanel"]>,
  connectionId: number,
  tableName: string,
  schemaName: string,
  page: number,
): Promise<void> {
  try {
    const [dataRes, schemaRes] = await Promise.all([
      fetch(`${baseUrl}/api/db/connections/${connectionId}/data?table=${encodeURIComponent(tableName)}&schema=${schemaName}&page=${page}&limit=100`),
      fetch(`${baseUrl}/api/db/connections/${connectionId}/schema?table=${encodeURIComponent(tableName)}&schema=${schemaName}`),
    ]);
    const dataJson = await dataRes.json() as { ok: boolean; data?: { columns: string[]; rows: Record<string, unknown>[]; total: number; page: number; limit: number } };
    const schemaJson = await schemaRes.json() as { ok: boolean; data?: { name: string; type: string; nullable: boolean; pk: boolean; defaultValue: string | null }[] };

    if (!dataJson.ok) {
      await panel.webview.postMessage({ type: "error", message: "Failed to load table data" });
      return;
    }

    await panel.webview.postMessage({
      type: "tableData",
      columns: dataJson.data?.columns ?? [],
      rows: dataJson.data?.rows ?? [],
      total: dataJson.data?.total ?? 0,
      page: dataJson.data?.page ?? page,
      limit: dataJson.data?.limit ?? 100,
      schema: schemaJson.data ?? [],
    });
  } catch (e) {
    const errMsg = e instanceof Error ? e.message : String(e);
    await panel.webview.postMessage({ type: "error", message: errMsg });
  }
}

/** Execute SQL query and send result to webview */
async function handleQuery(
  panel: ReturnType<VscodeApi["window"]["createWebviewPanel"]>,
  connectionId: number,
  sql: string,
): Promise<void> {
  if (!sql) return;
  try {
    const start = Date.now();
    const res = await fetch(`${baseUrl}/api/db/connections/${connectionId}/query`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sql }),
    });
    const json = await res.json() as { ok: boolean; data?: { columns: string[]; rows: Record<string, unknown>[]; rowsAffected: number; changeType: string } };
    const duration = Date.now() - start;

    if (!json.ok) {
      await panel.webview.postMessage({ type: "queryError", error: (json as any).error ?? "Query failed" });
      return;
    }

    await panel.webview.postMessage({
      type: "queryResult",
      columns: json.data?.columns ?? [],
      rows: json.data?.rows ?? [],
      rowsAffected: json.data?.rowsAffected ?? 0,
      changeType: json.data?.changeType ?? "select",
      duration,
    });
  } catch (e) {
    const errMsg = e instanceof Error ? e.message : String(e);
    await panel.webview.postMessage({ type: "queryError", error: errMsg });
  }
}

/** Update a single cell value */
async function handleCellUpdate(
  panel: ReturnType<VscodeApi["window"]["createWebviewPanel"]>,
  connectionId: number,
  tableName: string,
  schemaName: string,
  msg: Record<string, unknown>,
): Promise<void> {
  try {
    const res = await fetch(`${baseUrl}/api/db/connections/${connectionId}/cell`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        table: tableName,
        schema: schemaName,
        pkColumn: msg.pkColumn,
        pkValue: msg.pkValue,
        column: msg.column,
        value: msg.value,
      }),
    });
    const json = await res.json() as { ok: boolean; error?: string };
    if (json.ok) {
      await panel.webview.postMessage({ type: "cellUpdated" });
    } else {
      await panel.webview.postMessage({ type: "error", message: json.error ?? "Cell update failed" });
    }
  } catch (e) {
    const errMsg = e instanceof Error ? e.message : String(e);
    await panel.webview.postMessage({ type: "error", message: errMsg });
  }
}

// ---------------------------------------------------------------------------
// Query Panel — standalone SQL editor (opened from status bar)
// ---------------------------------------------------------------------------

function openQueryPanel(
  vscode: VscodeApi,
  context: ExtensionContext,
  connectionId: number,
  connectionName: string,
  tableName?: string,
): void {
  const panel = vscode.window.createWebviewPanel(
    "ppm-db.queryPanel",
    `Query: ${connectionName}`,
    vscode.ViewColumn.Active,
  );

  panel.webview.html = getQueryPanelHtml(connectionName, tableName);

  const msgDisposable = panel.webview.onDidReceiveMessage(async (raw: unknown) => {
    const msg = raw as { type: string; sql?: string };
    if (msg.type !== "executeQuery" || !msg.sql) return;
    await handleQuery(panel, connectionId, msg.sql);
  });
  context.subscriptions.push(msgDisposable);
  panel.onDidDispose(() => msgDisposable.dispose());
}

// ---------------------------------------------------------------------------
// Add Connection — collect info via QuickPick + InputBox, then POST to API
// ---------------------------------------------------------------------------

/** Collect optional group/color/readonly via InputBox + QuickPick */
async function collectConnectionExtras(vscode: VscodeApi): Promise<{ groupName?: string; color?: string; readonly?: number } | null> {
  const groupName = await vscode.window.showInputBox({ prompt: "Group name (optional)", placeHolder: "e.g. Production" });
  if (groupName === undefined) return null; // cancelled

  const COLOR_OPTIONS = ["None", "#ef4444", "#f97316", "#eab308", "#22c55e", "#06b6d4", "#3b82f6", "#8b5cf6", "#ec4899"];
  const color = await vscode.window.showQuickPick(COLOR_OPTIONS, { placeHolder: "Pick a color (optional)" });
  if (color === undefined) return null;

  const readonlyChoice = await vscode.window.showQuickPick(["Yes (recommended)", "No"], {
    placeHolder: "Readonly mode? (blocks write queries)",
  });
  if (readonlyChoice === undefined) return null;

  return {
    groupName: groupName || undefined,
    color: color === "None" ? undefined : color,
    readonly: readonlyChoice.startsWith("Yes") ? 1 : 0,
  };
}

async function addConnection(
  vscode: VscodeApi,
  treeProvider: ConnectionTreeProvider,
): Promise<void> {
  // 1. Pick type
  const type = await vscode.window.showQuickPick(["postgres", "sqlite"], {
    placeHolder: "Select database type",
  }) as string | undefined;
  if (!type) return;

  // 2. Name
  const name = await vscode.window.showInputBox({ prompt: "Connection name", placeHolder: "e.g. Production DB" });
  if (!name) return;

  // 3. Connection config
  let connectionConfig: Record<string, string>;
  if (type === "sqlite") {
    const path = await vscode.window.showInputBox({ prompt: "SQLite file path", placeHolder: "/path/to/database.db" });
    if (!path) return;
    connectionConfig = { type: "sqlite", path };
  } else {
    const connStr = await vscode.window.showInputBox({
      prompt: "PostgreSQL connection string",
      placeHolder: "postgres://user:pass@host:5432/dbname",
    });
    if (!connStr) return;
    connectionConfig = { type: "postgres", connectionString: connStr };
  }

  // 4. Group, color, readonly
  const extras = await collectConnectionExtras(vscode);
  if (extras === null) return;

  // 5. Create via API
  try {
    const res = await fetch(`${baseUrl}/api/db/connections`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type, name, connectionConfig, ...extras }),
    });
    const json = await res.json() as { ok: boolean; error?: string };
    if (json.ok) {
      await vscode.window.showInformationMessage(`Connection "${name}" created`);
      treeProvider.refresh();
    } else {
      await vscode.window.showErrorMessage(json.error ?? "Failed to create connection");
    }
  } catch (e) {
    await vscode.window.showErrorMessage(`Error: ${e instanceof Error ? e.message : String(e)}`);
  }
}

// ---------------------------------------------------------------------------
// Edit Connection — update name, group, color, readonly via QuickPick/InputBox
// ---------------------------------------------------------------------------

async function editConnection(
  vscode: VscodeApi,
  treeProvider: ConnectionTreeProvider,
  connectionId: number,
): Promise<void> {
  // Fetch current connection data
  let conn: { id: number; name: string; type: string; group_name?: string; color?: string; readonly?: number };
  try {
    const res = await fetch(`${baseUrl}/api/db/connections/${connectionId}`);
    const json = await res.json() as { ok: boolean; data?: typeof conn };
    if (!json.ok || !json.data) {
      await vscode.window.showErrorMessage("Failed to load connection");
      return;
    }
    conn = json.data;
  } catch (e) {
    await vscode.window.showErrorMessage(`Error: ${e instanceof Error ? e.message : String(e)}`);
    return;
  }

  // Name
  const name = await vscode.window.showInputBox({ prompt: "Connection name", value: conn.name });
  if (name === undefined) return;

  // Connection config (optional update)
  let connectionConfig: Record<string, string> | undefined;
  const updateConfig = await vscode.window.showQuickPick(["Keep current", "Update connection config"], {
    placeHolder: "Connection config",
  });
  if (updateConfig === undefined) return;
  if (updateConfig === "Update connection config") {
    if (conn.type === "sqlite") {
      const path = await vscode.window.showInputBox({ prompt: "SQLite file path", placeHolder: "/path/to/database.db" });
      if (path === undefined) return;
      if (path) connectionConfig = { type: "sqlite", path };
    } else {
      const connStr = await vscode.window.showInputBox({ prompt: "PostgreSQL connection string", placeHolder: "postgres://user:pass@host:5432/dbname" });
      if (connStr === undefined) return;
      if (connStr) connectionConfig = { type: "postgres", connectionString: connStr };
    }
  }

  // Group, color, readonly
  const groupName = await vscode.window.showInputBox({ prompt: "Group name", value: conn.group_name ?? "" });
  if (groupName === undefined) return;

  const COLOR_OPTIONS = ["None", "#ef4444", "#f97316", "#eab308", "#22c55e", "#06b6d4", "#3b82f6", "#8b5cf6", "#ec4899"];
  const color = await vscode.window.showQuickPick(COLOR_OPTIONS, { placeHolder: `Current color: ${conn.color ?? "None"}` });
  if (color === undefined) return;

  const readonlyChoice = await vscode.window.showQuickPick(["Yes (recommended)", "No"], {
    placeHolder: `Readonly? (current: ${conn.readonly === 1 ? "Yes" : "No"})`,
  });
  if (readonlyChoice === undefined) return;

  // Update via API
  try {
    const body: Record<string, unknown> = {
      name: name || conn.name,
      groupName: groupName || null,
      color: color === "None" ? null : color,
      readonly: readonlyChoice.startsWith("Yes") ? 1 : 0,
    };
    if (connectionConfig) body.connectionConfig = connectionConfig;

    const res = await fetch(`${baseUrl}/api/db/connections/${connectionId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = await res.json() as { ok: boolean; error?: string };
    if (json.ok) {
      await vscode.window.showInformationMessage(`Connection "${name || conn.name}" updated`);
      treeProvider.refresh();
    } else {
      await vscode.window.showErrorMessage(json.error ?? "Failed to update connection");
    }
  } catch (e) {
    await vscode.window.showErrorMessage(`Error: ${e instanceof Error ? e.message : String(e)}`);
  }
}

// ---------------------------------------------------------------------------
// Export Connections — copy JSON to clipboard via showInformationMessage
// ---------------------------------------------------------------------------

async function exportConnections(vscode: VscodeApi): Promise<void> {
  try {
    const res = await fetch(`${baseUrl}/api/db/connections/export`);
    const json = await res.json() as { ok: boolean; data?: unknown };
    if (!json.ok || !json.data) {
      await vscode.window.showErrorMessage("Failed to export connections");
      return;
    }
    // In extension context, we can't write to clipboard directly — show data as info
    const data = json.data as { connections: unknown[] };
    await vscode.window.showInformationMessage(`Exported ${data.connections.length} connection(s). Use built-in UI for file export.`);
  } catch (e) {
    await vscode.window.showErrorMessage(`Error: ${e instanceof Error ? e.message : String(e)}`);
  }
}

// ---------------------------------------------------------------------------
// Import Connections — paste JSON via InputBox
// ---------------------------------------------------------------------------

async function importConnections(
  vscode: VscodeApi,
  treeProvider: ConnectionTreeProvider,
): Promise<void> {
  const jsonStr = await vscode.window.showInputBox({
    prompt: "Paste connections JSON (from export)",
    placeHolder: '{"connections": [...]}',
  });
  if (!jsonStr) return;

  try {
    const data = JSON.parse(jsonStr);
    const conns = data.connections ?? data;
    if (!Array.isArray(conns)) {
      await vscode.window.showErrorMessage("Invalid format: expected connections array");
      return;
    }
    const res = await fetch(`${baseUrl}/api/db/connections/import`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ connections: conns }),
    });
    const json = await res.json() as { ok: boolean; data?: { imported: number; skipped: number; errors: string[] } };
    if (json.ok && json.data) {
      let msg = `Imported ${json.data.imported} connection(s)`;
      if (json.data.skipped > 0) msg += `, ${json.data.skipped} skipped`;
      await vscode.window.showInformationMessage(msg);
      treeProvider.refresh();
    } else {
      await vscode.window.showErrorMessage("Import failed");
    }
  } catch (e) {
    await vscode.window.showErrorMessage(`Error: ${e instanceof Error ? e.message : String(e)}`);
  }
}
