import { Disposable } from "./disposable.ts";
import { EventEmitter } from "./event-emitter.ts";
import type {
  RpcClient, StatusBarItem, StatusBarAlignment, QuickPickItem,
  QuickPickOptions, InputBoxOptions, OutputChannel, ViewColumn,
} from "./types.ts";
import { StatusBarAlignment as SBAlign } from "./types.ts";

/** VSCode-compatible window namespace — all UI ops go through RPC to main→browser */
export class WindowService {
  private rpc: RpcClient;
  private extId: string;

  constructor(rpc: RpcClient, extId: string) {
    this.rpc = rpc;
    this.extId = extId;
  }

  // --- Messages ---

  async showInformationMessage(message: string, ...items: string[]): Promise<string | undefined> {
    return this.rpc.request<string | undefined>("window:showMessage", "info", message, items);
  }

  async showWarningMessage(message: string, ...items: string[]): Promise<string | undefined> {
    return this.rpc.request<string | undefined>("window:showMessage", "warn", message, items);
  }

  async showErrorMessage(message: string, ...items: string[]): Promise<string | undefined> {
    return this.rpc.request<string | undefined>("window:showMessage", "error", message, items);
  }

  // --- Quick Pick / Input ---

  async showQuickPick(
    items: string[] | QuickPickItem[],
    options?: QuickPickOptions,
  ): Promise<string | QuickPickItem | undefined> {
    return this.rpc.request("window:showQuickPick", items, options ?? {});
  }

  async showInputBox(options?: InputBoxOptions): Promise<string | undefined> {
    // Remove non-serializable validateInput before sending over RPC
    const { validateInput, ...serializableOpts } = options ?? {};
    return this.rpc.request<string | undefined>("window:showInputBox", serializableOpts);
  }

  // --- Status Bar ---

  createStatusBarItem(alignment?: StatusBarAlignment, priority?: number): StatusBarItem {
    const id = `${this.extId}-sb-${Date.now()}`;
    const rpc = this.rpc;
    const extId = this.extId;
    const item: StatusBarItem = {
      alignment: (alignment as StatusBarAlignment) ?? SBAlign.Left,
      priority,
      text: "",
      tooltip: undefined,
      color: undefined,
      command: undefined,
      show() {
        rpc.request("window:statusbar:update", {
          id, text: item.text, tooltip: item.tooltip, command: item.command as string | undefined,
          alignment: item.alignment === SBAlign.Left ? "left" : "right",
          priority: item.priority ?? 0, extensionId: extId,
        });
      },
      hide() { rpc.request("window:statusbar:remove", id); },
      dispose() { rpc.request("window:statusbar:remove", id); },
    };
    return item;
  }

  // --- Output Channel ---

  createOutputChannel(name: string): OutputChannel {
    const rpc = this.rpc;
    const extId = this.extId;
    let buffer = "";
    return {
      name,
      append(value: string) { buffer += value; },
      appendLine(value: string) {
        buffer += value + "\n";
        rpc.notify("window:output:append", { extId, name, text: buffer });
        buffer = "";
      },
      clear() { rpc.notify("window:output:clear", { extId, name }); },
      show() { rpc.notify("window:output:show", { extId, name }); },
      hide() { rpc.notify("window:output:hide", { extId, name }); },
      dispose() { rpc.notify("window:output:dispose", { extId, name }); },
    };
  }

  // --- Tree View ---

  createTreeView(viewId: string, options: { treeDataProvider: unknown }): Disposable {
    const rpc = this.rpc;
    // Initial tree data push — if provider has getChildren
    const provider = options.treeDataProvider as { getChildren?: (el?: unknown) => unknown[] | Promise<unknown[]> };
    if (provider.getChildren) {
      Promise.resolve(provider.getChildren()).then((items) => {
        rpc.request("window:tree:update", viewId, items);
      }).catch(() => {});
    }
    return new Disposable(() => {
      rpc.request("window:tree:refresh", viewId);
    });
  }

  // --- Webview Panel ---

  createWebviewPanel(viewType: string, title: string, showOptions: ViewColumn): unknown {
    const panelId = `${this.extId}-wv-${Date.now()}`;
    const rpc = this.rpc;
    const extId = this.extId;
    rpc.request("window:webview:create", panelId, extId, viewType, title);

    const onDidDispose = new EventEmitter<void>();
    const onDidReceiveMessage = new EventEmitter<unknown>();

    let currentHtml = "";
    const webview = {
      get html() { return currentHtml; },
      set html(value: string) {
        currentHtml = value;
        rpc.request("window:webview:html", panelId, value);
      },
      options: {},
      async postMessage(message: unknown): Promise<boolean> {
        await rpc.request("window:webview:postMessage", panelId, message);
        return true;
      },
      onDidReceiveMessage: onDidReceiveMessage.event,
      asWebviewUri: (uri: unknown) => uri,
    };

    return {
      viewType, title, webview,
      onDidDispose: onDidDispose.event,
      onDidChangeViewState: new EventEmitter().event,
      reveal() {},
      dispose() {
        rpc.request("window:webview:dispose", panelId);
        onDidDispose.fire();
        onDidDispose.dispose();
        onDidReceiveMessage.dispose();
      },
    };
  }
}
