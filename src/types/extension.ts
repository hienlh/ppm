/** Extension manifest — parsed from package.json of an installed extension */
export interface ExtensionManifest {
  id: string; // npm package name, e.g. @ppm/ext-database
  version: string;
  main: string; // JS entry point relative to extension root
  displayName?: string;
  description?: string;
  icon?: string;
  engines?: { ppm?: string };
  activationEvents?: string[];
  contributes?: ExtensionContributes;
  ppm?: {
    displayName?: string;
    icon?: string;
    webviewDir?: string;
  };
  permissions?: string[];
}

/** VSCode-compatible contributes section */
export interface ExtensionContributes {
  commands?: ContributedCommand[];
  views?: Record<string, ContributedView[]>;
  configuration?: { properties?: Record<string, ConfigProperty> };
  menus?: Record<string, ContributedMenu[]>;
  keybindings?: ContributedKeybinding[];
}

export interface ContributedCommand {
  command: string;
  title: string;
  icon?: string;
  category?: string;
}

export interface ContributedView {
  id: string;
  name: string;
  type?: "tree" | "webview";
  icon?: string;
}

export interface ConfigProperty {
  type?: string;
  default?: unknown;
  description?: string;
  enum?: unknown[];
}

export interface ContributedMenu {
  command: string;
  when?: string;
  group?: string;
}

export interface ContributedKeybinding {
  command: string;
  key: string;
  mac?: string;
  when?: string;
}

/** Runtime extension info returned by API */
export interface ExtensionInfo {
  id: string;
  version: string;
  displayName: string;
  description: string;
  icon: string;
  enabled: boolean;
  activated: boolean;
  manifest: ExtensionManifest;
}

/** DB row for extensions table */
export interface ExtensionRow {
  id: string;
  version: string;
  display_name: string | null;
  description: string | null;
  icon: string | null;
  enabled: number; // 0 | 1
  manifest: string; // JSON
  installed_at: string;
  updated_at: string;
}

/** DB row for extension_storage table */
export interface ExtensionStorageRow {
  ext_id: string;
  scope: string;
  key: string;
  value: string | null; // JSON
}

/** Extension activation context passed to ext.activate() */
export interface ExtensionContext {
  extensionId: string;
  extensionPath: string;
  globalState: StateStore;
  workspaceState: StateStore;
  subscriptions: Disposable[];
}

export interface StateStore {
  get<T = unknown>(key: string, defaultValue?: T): T | undefined;
  update(key: string, value: unknown): Promise<void>;
  keys(): readonly string[];
}

export interface Disposable {
  dispose(): void;
}

/** RPC message types between main process and extension host worker */
export type RpcMessage =
  | RpcRequest
  | RpcResponse
  | RpcEvent;

export interface RpcRequest {
  type: "request";
  id: number;
  method: string;
  params: unknown[];
}

export interface RpcResponse {
  type: "response";
  id: number;
  result?: unknown;
  error?: string;
}

export interface RpcEvent {
  type: "event";
  event: string;
  data: unknown;
}
