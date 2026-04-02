import { EventEmitter } from "./event-emitter.ts";
import { Uri } from "./uri.ts";
import type { RpcClient, WorkspaceFolder, WorkspaceConfiguration, ConfigurationTarget } from "./types.ts";

/** VSCode-compatible workspace namespace — config, fs, folders via RPC */
export class WorkspaceService {
  private rpc: RpcClient;
  private extId: string;
  private _onDidChangeConfiguration = new EventEmitter<{ affectsConfiguration(section: string): boolean }>();
  readonly onDidChangeConfiguration = this._onDidChangeConfiguration.event;

  constructor(rpc: RpcClient, extId: string) {
    this.rpc = rpc;
    this.extId = extId;
  }

  getConfiguration(section?: string): WorkspaceConfiguration {
    const rpc = this.rpc;
    // Config reads go through RPC — returns a snapshot object
    return {
      async get<T>(key: string, defaultValue?: T): Promise<T | undefined> {
        const fullKey = section ? `${section}.${key}` : key;
        const val = await rpc.request<T | null>("workspace:config:get", fullKey);
        return val ?? defaultValue;
      },
      has(key: string): boolean {
        // Synchronous check not possible over RPC — always returns true
        return true;
      },
      async update(key: string, value: unknown, target?: ConfigurationTarget): Promise<void> {
        const fullKey = section ? `${section}.${key}` : key;
        await rpc.request("workspace:config:update", fullKey, value, target);
      },
    } as WorkspaceConfiguration;
  }

  get workspaceFolders(): WorkspaceFolder[] | undefined {
    // This is sync in VSCode but we return a cached value; updated via RPC event
    return this._cachedFolders;
  }

  private _cachedFolders: WorkspaceFolder[] | undefined;

  /** Called during init to hydrate workspace folders */
  _setFolders(folders: Array<{ uri: string; name: string; index: number }>): void {
    this._cachedFolders = folders.map((f) => ({
      uri: Uri.file(f.uri),
      name: f.name,
      index: f.index,
    }));
  }

  // --- File system operations ---

  readonly fs = {
    readFile: async (uri: Uri): Promise<Uint8Array> => {
      const base64 = await this.rpc.request<string>("workspace:fs:readFile", uri.fsPath);
      return Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
    },
    writeFile: async (uri: Uri, content: Uint8Array): Promise<void> => {
      const base64 = btoa(String.fromCharCode(...content));
      await this.rpc.request("workspace:fs:writeFile", uri.fsPath, base64);
    },
    stat: async (uri: Uri): Promise<{ type: number; size: number; mtime: number }> => {
      return this.rpc.request("workspace:fs:stat", uri.fsPath);
    },
    readDirectory: async (uri: Uri): Promise<Array<[string, number]>> => {
      return this.rpc.request("workspace:fs:readDirectory", uri.fsPath);
    },
  };

  async findFiles(pattern: string, maxResults?: number): Promise<Uri[]> {
    const paths = await this.rpc.request<string[]>("workspace:findFiles", pattern, maxResults ?? 100);
    return paths.map((p) => Uri.file(p));
  }
}
