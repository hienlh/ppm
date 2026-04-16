/**
 * Extension Host Worker — runs inside a Bun Worker thread.
 * Loads, activates, and deactivates extensions in isolation.
 * Communicates with the main process via typed RPC (postMessage).
 */
import { RpcChannel } from "./extension-rpc.ts";
import { createVscodeCompat } from "@ppm/vscode-compat";
import type { WindowService } from "@ppm/vscode-compat/src/window.ts";
import type { CommandService } from "@ppm/vscode-compat/src/commands.ts";
import type { Disposable, RpcMessage } from "../types/extension.ts";

// Active extension instances: id → { module, context, deactivate, services }
const activeExtensions = new Map<string, {
  deactivate?: () => void | Promise<void>;
  context: { subscriptions: Disposable[] };
  window?: WindowService;
  commands?: CommandService;
}>();

const rpc = new RpcChannel((msg) => postMessage(msg));

// Listen for messages from main process
declare const self: Worker;
self.addEventListener("message", (event: MessageEvent<RpcMessage>) => {
  rpc.handleMessage(event.data);
});

// --- RPC handlers ---

rpc.onRequest("ext:activate", async (params) => {
  const [extId, entryPath, extensionPath, storedState, baseUrl, authToken] = params as [string, string, string, Record<string, Record<string, string | null>>?, string?, string?];
  console.log(`[ExtHost] activating ${extId} from ${entryPath}`);
  if (activeExtensions.has(extId)) return { ok: true, already: true };

  // Expose server base URL and auth token so extensions can use fetch() with absolute URLs
  if (baseUrl) (globalThis as any).__PPM_BASE_URL__ = baseUrl;
  if (authToken) (globalThis as any).__PPM_AUTH_TOKEN__ = authToken;

  // Create RpcClient adapter for vscode-compat (Worker's RPC → vscode-compat interface)
  const rpcClient = {
    request: <T = unknown>(method: string, ...p: unknown[]) => rpc.sendRequest<T>(method, ...p),
    notify: (event: string, data: unknown) => rpc.sendEvent(event, data),
  };

  // Create vscode-compat API scoped to this extension
  const api = createVscodeCompat({
    extensionId: extId,
    extensionPath,
    storagePath: `${extensionPath}/.storage`,
    rpc: rpcClient,
    storedState: storedState as { global?: Record<string, string | null>; workspace?: Record<string, string | null> },
  });

  const context = api._createContext();

  try {
    const mod = await import(entryPath);
    const activateFn = mod.activate || mod.default?.activate;
    if (typeof activateFn === "function") {
      // Activation timeout: 10s max to prevent hanging extensions
      const activatePromise = Promise.resolve(activateFn(context, api));
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`Activation timeout (10s) for ${extId}`)), 10_000),
      );
      await Promise.race([activatePromise, timeoutPromise]);
    }
    activeExtensions.set(extId, {
      deactivate: mod.deactivate || mod.default?.deactivate,
      context,
      window: api.window as WindowService,
      commands: api.commands as CommandService,
    });
    console.log(`[ExtHost] activated ${extId} (${activeExtensions.size} total)`);
    return { ok: true };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[ExtHost] Failed to activate ${extId}:`, msg);
    return { ok: false, error: msg };
  }
});

rpc.onRequest("ext:deactivate", async (params) => {
  const [extId] = params as [string];
  const ext = activeExtensions.get(extId);
  if (!ext) return { ok: true, already: true };

  try {
    if (typeof ext.deactivate === "function") {
      await ext.deactivate();
    }
    // Dispose all subscriptions
    for (const sub of ext.context.subscriptions) {
      try { (sub as Disposable).dispose(); } catch {}
    }
    activeExtensions.delete(extId);
    return { ok: true };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[ExtHost] Failed to deactivate ${extId}:`, msg);
    activeExtensions.delete(extId);
    return { ok: false, error: msg };
  }
});

rpc.onRequest("ext:command:execute", async (params) => {
  const [command, ...args] = params as [string, ...unknown[]];
  console.log(`[ExtHost] command:execute "${command}" (${activeExtensions.size} extensions active)`);
  for (const [extId, ext] of activeExtensions) {
    if (ext.commands) {
      const hasLocal = (ext.commands as any).localHandlers?.has(command);
      if (!hasLocal) continue;
      console.log(`[ExtHost] routing "${command}" → ${extId}`);
      try {
        const result = await (ext.commands as any).executeCommand(command, ...args);
        return { ok: true, result };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error(`[ExtHost] command "${command}" in ${extId} threw:`, msg);
        return { ok: false, error: msg };
      }
    }
  }
  console.warn(`[ExtHost] command not found: "${command}"`);
  return { ok: false, error: `Command not found: ${command}` };
});

// Browser closed a webview panel tab → fire onDidDispose in the extension
rpc.onRequest("ext:webview:close", async (params) => {
  const [panelId] = params as [string];
  for (const [, ext] of activeExtensions) {
    if (!ext.window) continue;
    if ((ext.window as any)._disposePanel(panelId)) {
      return { ok: true };
    }
  }
  return { ok: false, error: `No panel found: ${panelId}` };
});

// Deliver webview messages from browser → extension's onDidReceiveMessage
rpc.onRequest("ext:webview:message", async (params) => {
  const [panelId, message] = params as [string, unknown];
  for (const [, ext] of activeExtensions) {
    if (!ext.window) continue;
    try {
      if ((ext.window as any)._deliverWebviewMessage(panelId, message)) {
        return { ok: true };
      }
    } catch (e) {
      console.error(`[ExtHost] webview:message error (${panelId}):`, e);
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }
  return { ok: false, error: `No handler for panel ${panelId}` };
});

// Handle tree:expand — get children for a tree node
rpc.onRequest("ext:tree:expand", async (params) => {
  const [viewId, itemId] = params as [string, string | undefined];
  for (const [, ext] of activeExtensions) {
    if (ext.window) {
      try {
        const items = await (ext.window as any)._getTreeChildren(viewId, itemId);
        if (items.length > 0) return { ok: true, items };
      } catch (e) {
        console.error(`[ExtHost] tree:expand error (${viewId}):`, e);
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    }
  }
  return { ok: true, items: [] };
});

rpc.onRequest("ext:list-active", () => {
  return [...activeExtensions.keys()];
});

rpc.onRequest("ext:ping", () => "pong");

// ExtensionContext is now created by @ppm/vscode-compat's createVscodeCompat()._createContext()

// Notify main process that worker is ready
rpc.sendEvent("worker:ready", {});
