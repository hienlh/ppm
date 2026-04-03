/**
 * @ppm/ext-database — Database Viewer extension for PPM.
 * Provides a sidebar tree view of DB connections/tables/columns
 * and a query panel webview for executing SQL.
 */
import type { ExtensionContext } from "@ppm/vscode-compat";
import { ConnectionTreeProvider } from "./connection-tree.ts";
import { getQueryPanelHtml } from "./query-panel.ts";

/** PPM vscode-compat API namespace (passed as second arg by Worker) */
interface VscodeApi {
  commands: {
    registerCommand(command: string, callback: (...args: unknown[]) => unknown): { dispose(): void };
  };
  window: {
    showInformationMessage(message: string, ...items: string[]): Promise<string | undefined>;
    showErrorMessage(message: string, ...items: string[]): Promise<string | undefined>;
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

export function activate(context: ExtensionContext, vscode: VscodeApi): void {
  // --- Tree View ---
  const emitter = new vscode.EventEmitter<unknown>();
  const treeProvider = new ConnectionTreeProvider(
    { fire: (el?: unknown) => emitter.fire(el), event: emitter.event },
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
      openQueryPanel(vscode, context, connectionId, connectionName, tableName);
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

/** Open a query panel webview for a specific connection */
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

  // Handle messages from the webview iframe
  const msgDisposable = panel.webview.onDidReceiveMessage(async (raw: unknown) => {
    const msg = raw as { type: string; sql?: string };
    if (msg.type !== "executeQuery" || !msg.sql) return;

    try {
      const start = Date.now();
      const res = await fetch(`/api/db/connections/${connectionId}/query`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sql: msg.sql }),
      });
      const json = (await res.json()) as { ok: boolean; data?: unknown[]; error?: string };
      const duration = Date.now() - start;

      if (json.ok) {
        await panel.webview.postMessage({ type: "queryResult", rows: json.data ?? [], duration });
      } else {
        await panel.webview.postMessage({ type: "queryError", error: json.error ?? "Query failed" });
      }
    } catch (e: unknown) {
      const errMsg = e instanceof Error ? e.message : String(e);
      await panel.webview.postMessage({ type: "queryError", error: errMsg });
    }
  });
  context.subscriptions.push(msgDisposable);

  panel.onDidDispose(() => {
    msgDisposable.dispose();
  });
}
