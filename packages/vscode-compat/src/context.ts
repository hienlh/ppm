import type { Disposable } from "./disposable.ts";
import type { RpcClient } from "./types.ts";

/** Memento — key-value state store backed by SQLite via RPC */
export class Memento {
  private cache = new Map<string, unknown>();
  private rpc: RpcClient;
  private extId: string;
  private scope: string;

  constructor(rpc: RpcClient, extId: string, scope: string, initial?: Record<string, string | null>) {
    this.rpc = rpc;
    this.extId = extId;
    this.scope = scope;
    // Hydrate from persisted values
    if (initial) {
      for (const [key, val] of Object.entries(initial)) {
        if (val !== null) {
          try { this.cache.set(key, JSON.parse(val)); } catch { this.cache.set(key, val); }
        }
      }
    }
  }

  get<T = unknown>(key: string, defaultValue?: T): T | undefined {
    if (this.cache.has(key)) return this.cache.get(key) as T;
    return defaultValue;
  }

  async update(key: string, value: unknown): Promise<void> {
    this.cache.set(key, value);
    await this.rpc.request("storage:set", this.extId, this.scope, key, JSON.stringify(value));
  }

  keys(): readonly string[] {
    return [...this.cache.keys()];
  }
}

/** VSCode-compatible ExtensionContext */
export interface ExtensionContext {
  readonly extensionId: string;
  readonly extensionPath: string;
  readonly storagePath: string;
  readonly globalState: Memento;
  readonly workspaceState: Memento;
  readonly subscriptions: Disposable[];
}

export function createExtensionContext(
  rpc: RpcClient,
  extId: string,
  extensionPath: string,
  storagePath: string,
  storedState?: { global?: Record<string, string | null>; workspace?: Record<string, string | null> },
): ExtensionContext {
  return {
    extensionId: extId,
    extensionPath,
    storagePath,
    globalState: new Memento(rpc, extId, "global", storedState?.global),
    workspaceState: new Memento(rpc, extId, "workspace", storedState?.workspace),
    subscriptions: [],
  };
}
