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
    return this.rpc.request<string | undefined>("window:showMessage", "warning", message, items);
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
    const item: StatusBarItem = {
      alignment: (alignment as StatusBarAlignment) ?? SBAlign.Left,
      priority,
      text: "",
      tooltip: undefined,
      color: undefined,
      command: undefined,
      show() { rpc.notify("window:statusBar:update", { id, ...serializeItem(item), visible: true }); },
      hide() { rpc.notify("window:statusBar:update", { id, visible: false }); },
      dispose() { rpc.notify("window:statusBar:dispose", { id }); },
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

  // --- Tree View (registration only — rendering in Phase 3) ---

  createTreeView(viewId: string, options: { treeDataProvider: unknown }): Disposable {
    this.rpc.notify("window:tree:register", { extId: this.extId, viewId });
    return new Disposable(() => {
      this.rpc.notify("window:tree:unregister", { viewId });
    });
  }

  // --- Webview Panel (stub — full impl in Phase 3) ---

  createWebviewPanel(viewType: string, title: string, showOptions: ViewColumn): unknown {
    this.rpc.notify("window:webview:create", { extId: this.extId, viewType, title, showOptions });
    // Full WebviewPanel implementation in Phase 3 (UI gaps)
    const onDidDispose = new EventEmitter<void>();
    return {
      viewType, title,
      webview: { html: "", options: {}, postMessage: async () => false, onDidReceiveMessage: new EventEmitter<unknown>().event, asWebviewUri: (uri: unknown) => uri },
      onDidDispose: onDidDispose.event,
      onDidChangeViewState: new EventEmitter().event,
      reveal() {},
      dispose() { onDidDispose.fire(); onDidDispose.dispose(); },
    };
  }
}

function serializeItem(item: StatusBarItem) {
  return { text: item.text, tooltip: item.tooltip, color: item.color, command: item.command, alignment: item.alignment, priority: item.priority };
}
