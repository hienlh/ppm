/**
 * Extension Host Worker — runs inside a Bun Worker thread.
 * Loads, activates, and deactivates extensions in isolation.
 * Communicates with the main process via typed RPC (postMessage).
 */
import { RpcChannel } from "./extension-rpc.ts";
import type { ExtensionContext, StateStore, Disposable, RpcMessage } from "../types/extension.ts";

// Active extension instances: id → { module, context, deactivate }
const activeExtensions = new Map<string, {
  deactivate?: () => void | Promise<void>;
  context: ExtensionContext;
}>();

const rpc = new RpcChannel((msg) => postMessage(msg));

// Listen for messages from main process
declare const self: Worker;
self.addEventListener("message", (event: MessageEvent<RpcMessage>) => {
  rpc.handleMessage(event.data);
});

// --- RPC handlers ---

rpc.onRequest("ext:activate", async (params) => {
  const [extId, entryPath, extensionPath, storedState] = params as [string, string, string, Record<string, Record<string, string | null>>?];
  if (activeExtensions.has(extId)) return { ok: true, already: true };

  const context = createExtensionContext(extId, extensionPath, storedState);
  try {
    const mod = await import(entryPath);
    const activateFn = mod.activate || mod.default?.activate;
    if (typeof activateFn === "function") {
      await activateFn(context);
    }
    activeExtensions.set(extId, { deactivate: mod.deactivate || mod.default?.deactivate, context });
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
      try { sub.dispose(); } catch {}
    }
    activeExtensions.delete(extId);
    return { ok: true };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[ExtHost] Failed to deactivate ${extId}:`, msg);
    activeExtensions.delete(extId); // remove even on error
    return { ok: false, error: msg };
  }
});

rpc.onRequest("ext:command:execute", async (params) => {
  const [command, ...args] = params as [string, ...unknown[]];
  // Extensions register commands via vscode-compat shim (Phase 2).
  // For now, emit an event so future shim can hook in.
  rpc.sendEvent("command:executed", { command, args });
  return { ok: true };
});

rpc.onRequest("ext:list-active", () => {
  return [...activeExtensions.keys()];
});

rpc.onRequest("ext:ping", () => "pong");

// --- Helper: create ExtensionContext ---

function createExtensionContext(
  extId: string,
  extensionPath: string,
  storedState?: Record<string, Record<string, string | null>>,
): ExtensionContext {
  const subscriptions: Disposable[] = [];

  // State stores use RPC to persist in main process DB, hydrated from stored values
  const createStateStore = (scope: string): StateStore => {
    const cache = new Map<string, unknown>();

    // Hydrate cache from persisted DB values
    const stored = storedState?.[scope];
    if (stored) {
      for (const [key, val] of Object.entries(stored)) {
        if (val !== null) {
          try { cache.set(key, JSON.parse(val)); } catch { cache.set(key, val); }
        }
      }
    }

    return {
      get<T = unknown>(key: string, defaultValue?: T): T | undefined {
        if (cache.has(key)) return cache.get(key) as T;
        return defaultValue;
      },
      async update(key: string, value: unknown): Promise<void> {
        cache.set(key, value);
        await rpc.sendRequest("storage:set", extId, scope, key, JSON.stringify(value));
      },
      keys(): readonly string[] {
        return [...cache.keys()];
      },
    };
  };

  return {
    extensionId: extId,
    extensionPath,
    globalState: createStateStore("global"),
    workspaceState: createStateStore("workspace"),
    subscriptions,
  };
}

// Notify main process that worker is ready
rpc.sendEvent("worker:ready", {});
