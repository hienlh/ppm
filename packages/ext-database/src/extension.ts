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

  // 4. Create via API
  try {
    const res = await fetch(`${baseUrl}/api/db/connections`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type, name, connectionConfig }),
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
