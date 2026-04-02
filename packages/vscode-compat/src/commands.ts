import { Disposable } from "./disposable.ts";
import type { RpcClient } from "./types.ts";

type CommandHandler = (...args: unknown[]) => unknown;

/** VSCode-compatible commands namespace — delegates to RPC */
export class CommandService {
  private localHandlers = new Map<string, CommandHandler>();
  private rpc: RpcClient;
  private extId: string;

  constructor(rpc: RpcClient, extId: string) {
    this.rpc = rpc;
    this.extId = extId;
  }

  registerCommand(command: string, callback: CommandHandler): Disposable {
    this.localHandlers.set(command, callback);
    // Notify main process about the registration
    this.rpc.notify("commands:register", { extId: this.extId, command });
    return new Disposable(() => {
      this.localHandlers.delete(command);
      this.rpc.notify("commands:unregister", { command });
    });
  }

  async executeCommand<T = unknown>(command: string, ...args: unknown[]): Promise<T> {
    // Try local handler first (same-worker commands)
    const local = this.localHandlers.get(command);
    if (local) return await local(...args) as T;
    // Delegate to main process (cross-extension or built-in commands)
    return this.rpc.request<T>("commands:execute", command, ...args);
  }

  async getCommands(filterInternal?: boolean): Promise<string[]> {
    const remote = await this.rpc.request<string[]>("commands:list", filterInternal ?? false);
    return [...new Set([...this.localHandlers.keys(), ...remote])];
  }
}
