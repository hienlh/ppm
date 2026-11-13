import { Disposable } from "./disposable.ts";
import { EventEmitter } from "./event-emitter.ts";
import type {
  RpcClient, StatusBarItem, StatusBarAlignment, QuickPickItem,
  QuickPickOptions, InputBoxOptions, OutputChannel, ViewColumn,
  ComposerOptions, ComposerResult,
} from "./types.ts";
import { StatusBarAlignment as SBAlign } from "./types.ts";
import { rememberWebviewPanelId, toWirePlacement, type TabPlacementOptions } from "./tab-placement.ts";

/** VSCode-compatible window namespace — all UI ops go through RPC to main→browser */
export class WindowService {
  private rpc: RpcClient;
  private extId: string;
  /** @internal Monotonic counter for unique panel/statusbar IDs */
  private _idCounter = 0;
  /** @internal Panel emitters keyed by panelId — for webview message delivery */
  private _panelEmitters = new Map<string, EventEmitter<unknown>>();
  /** @internal Panel dispose emitters keyed by panelId — for browser-initiated disposal */
  private _panelDisposeEmitters = new Map<string, EventEmitter<void>>();
  /** @internal Tree providers keyed by viewId — for tree expand/refresh */
  private _treeProviders = new Map<string, { provider: any }>();
  /** @internal Cache original tree elements by ID so getChildren receives the real object */
  private _treeElementCache = new Map<string, Map<string, unknown>>();

  constructor(rpc: RpcClient, extId: string) {
    this.rpc = rpc;
    this.extId = extId;
  }

  /** @internal Deliver a message from the WS bridge to a webview panel's onDidReceiveMessage */
  _deliverWebviewMessage(panelId: string, message: unknown): boolean {
    const emitter = this._panelEmitters.get(panelId);
    if (emitter) { emitter.fire(message); return true; }
    return false;
  }

  /** @internal Dispose a panel by ID (called when browser closes the tab) */
  _disposePanel(panelId: string): boolean {
    if (!this._panelEmitters.has(panelId)) return false;
    const disposeEvent = this._panelDisposeEmitters?.get(panelId);
    if (disposeEvent) { disposeEvent.fire(); disposeEvent.dispose(); }
    this._panelEmitters.delete(panelId);
    this._panelDisposeEmitters?.delete(panelId);
    return true;
  }

  /** @internal Get tree children for a viewId (used by Worker for tree:expand) */
  async _getTreeChildren(viewId: string, parentId?: string): Promise<unknown[]> {
    const entry = this._treeProviders.get(viewId);
    if (!entry) return [];
    const provider = entry.provider;
    // Resolve parentId → original cached element (or undefined for root)
    let parentElement: unknown = undefined;
    if (parentId) {
      const cache = this._treeElementCache.get(viewId);
      parentElement = cache?.get(parentId) ?? parentId;
    }
    const children = await Promise.resolve(provider.getChildren(parentElement));
    if (!children || !Array.isArray(children)) return [];
    return this._serializeTreeItems(provider, children, viewId);
  }

  /** @internal Serialize tree elements into TreeItemMsg-compatible objects */
  private async _serializeTreeItems(provider: any, elements: unknown[], viewId?: string): Promise<unknown[]> {
    const results: unknown[] = [];
    // Ensure element cache exists for this view
    if (viewId && !this._treeElementCache.has(viewId)) {
      this._treeElementCache.set(viewId, new Map());
    }
    const cache = viewId ? this._treeElementCache.get(viewId)! : null;

    for (const el of elements) {
      const treeItem = provider.getTreeItem ? await Promise.resolve(provider.getTreeItem(el)) : el;
      const id = treeItem.id ?? String(el);
      // Cache the original element so getChildren receives the real object on expand
      if (cache) cache.set(id, el);
      results.push({
        id,
        label: treeItem.label ?? String(el),
        description: treeItem.description,
        tooltip: treeItem.tooltip,
        icon: treeItem.iconPath?.id ?? treeItem.iconPath ?? undefined,
        collapsibleState: treeItem.collapsibleState === 0 ? "none" : treeItem.collapsibleState === 2 ? "expanded" : treeItem.collapsibleState === 1 ? "collapsed" : (treeItem.collapsibleState ?? "none"),
        command: typeof treeItem.command === "string" ? treeItem.command : treeItem.command?.command,
        commandArgs: treeItem.commandArgs ?? (typeof treeItem.command === "object" ? treeItem.command?.arguments : undefined),
        color: treeItem.color,
        badge: treeItem.badge,
        actions: treeItem.actions,
        contextValue: treeItem.contextValue,
      });
    }
    return results;
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

  // --- Quick Pick / Input / Composer ---
  //
  // These three verbs wait on a human in the browser, so they use a 600s timeout instead of
  // the RPC default (10s) — see sendRequestWithTimeout's ordering rule in extension-rpc.ts:
  // this worker-side timeout must stay >= whatever browser-side timeout the server passes to
  // requestFromBrowser for the same round trip.

  /**
   * VSCode contract: plain strings in → the chosen string out; objects in → the
   * chosen object out; `canPickMany` → an array of them. The browser dialog only
   * understands `{ label }` objects and always answers with an array, so both
   * directions are translated here rather than crashing the picker on a string.
   */
  async showQuickPick(
    items: string[] | QuickPickItem[],
    options?: QuickPickOptions,
  ): Promise<string | QuickPickItem | (string | QuickPickItem)[] | undefined> {
    const asStrings = items.every((item) => typeof item === "string");
    const wireItems: QuickPickItem[] = (items as (string | QuickPickItem)[]).map((item) =>
      typeof item === "string" ? { label: item } : item,
    );
    const selected = await this.rpc.requestWithTimeout<QuickPickItem[] | null | undefined>(
      "window:showQuickPick", 600_000, wireItems, options ?? {},
    );
    if (!selected || selected.length === 0) return undefined;

    // Hand back the caller's own objects (they may carry extra fields the wire dropped).
    const picked = selected.map((sel) => {
      const original = (items as (string | QuickPickItem)[]).find((item) =>
        typeof item === "string" ? item === sel.label : item.label === sel.label,
      );
      return original ?? (asStrings ? sel.label : sel);
    });
    return options?.canPickMany ? picked : picked[0];
  }

  async showInputBox(options?: InputBoxOptions): Promise<string | undefined> {
    // Remove non-serializable validateInput before sending over RPC
    const { validateInput, ...serializableOpts } = options ?? {};
    return this.rpc.requestWithTimeout<string | undefined>("window:showInputBox", 600_000, serializableOpts);
  }

  /**
   * Show the real chat composer (slash/file pickers, model, permission mode) and
   * return what the user composed, or `undefined` on cancel/dismiss/timeout.
   * Returns a message — it does not send one. Authors against the active
   * project; fails fast when no browser client is connected.
   */
  async showComposer(options?: ComposerOptions): Promise<ComposerResult | undefined> {
    return this.rpc.requestWithTimeout<ComposerResult | undefined>("window:showComposer", 600_000, options ?? {});
  }

  // --- Status Bar ---

  createStatusBarItem(alignment?: StatusBarAlignment, priority?: number): StatusBarItem {
    const id = `${this.extId}-sb-${++this._idCounter}`;
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
    const provider = options.treeDataProvider as any;
    this._treeProviders.set(viewId, { provider });
    // Initial tree data push — serialize via getTreeItem
    if (provider.getChildren) {
      this._getTreeChildren(viewId).then((items) => rpc.request("window:tree:update", viewId, items))
        .catch((e) => console.error(`[vscode-compat] tree init error (${viewId}):`, e));
    }
    // Subscribe to onDidChangeTreeData — re-push entire tree on change.
    // `Event<T>` is documented (and implemented by `vscode.EventEmitter`) to return
    // a `Disposable` object, not a bare unsubscribe function — a provider that
    // builds its event off `vscode.EventEmitter` hands back `{ dispose() }`, so
    // calling the result as a function throws at teardown. Accept either shape.
    let changeUnsub: (() => void) | { dispose(): void } | undefined;
    if (provider.onDidChangeTreeData) {
      changeUnsub = provider.onDidChangeTreeData(() => {
        this._getTreeChildren(viewId).then((items) => rpc.request("window:tree:update", viewId, items))
          .catch((e) => console.error(`[vscode-compat] tree refresh error (${viewId}):`, e));
      });
    }
    return new Disposable(() => {
      if (typeof changeUnsub === "function") changeUnsub();
      else changeUnsub?.dispose();
      this._treeProviders.delete(viewId);
      this._treeElementCache.delete(viewId);
      rpc.request("window:tree:refresh", viewId).catch(() => {});
    });
  }

  // --- Open PPM Tab ---

  /**
   * Opens a tab in every connected browser. `options.preferWindow` asks a desktop for a
   * floating window in front, placed beside the webview panel `options.beside`.
   */
  async openTab(tabType: string, title: string, projectId: string | null, metadata?: Record<string, unknown>, options?: TabPlacementOptions): Promise<void> {
    const placement = toWirePlacement(options);
    await this.rpc.request("window:openTab", tabType, title, projectId, metadata, ...(placement ? [placement] : []));
  }

  async switchProject(projectName: string): Promise<void> {
    await this.rpc.request("window:switchProject", projectName);
  }

  // --- Webview Panel ---

  /**
   * `preferWindow`: open the panel in a floating window on a desktop browser. A phone, or a
   * desktop already at its window limit, gets an ordinary tab. Only the browser tab that ran
   * the command opening the panel moves it.
   */
  createWebviewPanel(viewType: string, title: string, showOptions: ViewColumn, options?: { projectPath?: string; preferWindow?: boolean }): unknown {
    const panelId = `${this.extId}-wv-${++this._idCounter}`;
    const rpc = this.rpc;
    const extId = this.extId;
    rpc.request("window:webview:create", panelId, extId, viewType, title, options?.projectPath,
      ...(options?.preferWindow === true ? [true] : []));

    const onDidDispose = new EventEmitter<void>();
    const onDidReceiveMessage = new EventEmitter<unknown>();
    this._panelEmitters.set(panelId, onDidReceiveMessage);
    this._panelDisposeEmitters.set(panelId, onDidDispose);

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

    const panel = {
      viewType, title, webview,
      onDidDispose: onDidDispose.event,
      onDidChangeViewState: new EventEmitter().event,
      reveal() {},
      dispose: () => {
        this._panelEmitters.delete(panelId);
        this._panelDisposeEmitters.delete(panelId);
        rpc.request("window:webview:dispose", panelId);
        onDidDispose.fire();
        onDidDispose.dispose();
        onDidReceiveMessage.dispose();
      },
    };
    // So `openTab(..., { beside: panel })` can name this panel without the panel exposing an id.
    rememberWebviewPanelId(panel, panelId);
    return panel;
  }
}
