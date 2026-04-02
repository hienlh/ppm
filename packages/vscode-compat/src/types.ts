import type { Uri } from "./uri.ts";
import type { Event } from "./event-emitter.ts";

// --- Enums ---

export enum TreeItemCollapsibleState {
  None = 0,
  Collapsed = 1,
  Expanded = 2,
}

export enum ViewColumn {
  Active = -1,
  Beside = -2,
  One = 1,
  Two = 2,
  Three = 3,
}

export enum StatusBarAlignment {
  Left = 1,
  Right = 2,
}

export enum ConfigurationTarget {
  Global = 1,
  Workspace = 2,
  WorkspaceFolder = 3,
}

export enum DiagnosticSeverity {
  Error = 0,
  Warning = 1,
  Information = 2,
  Hint = 3,
}

// --- Tree View ---

export interface TreeItem {
  label?: string;
  id?: string;
  iconPath?: string | Uri | { light: string | Uri; dark: string | Uri };
  description?: string;
  tooltip?: string;
  collapsibleState?: TreeItemCollapsibleState;
  command?: { command: string; title: string; arguments?: unknown[] };
  contextValue?: string;
}

export interface TreeDataProvider<T> {
  getTreeItem(element: T): TreeItem | Promise<TreeItem>;
  getChildren(element?: T): T[] | Promise<T[]>;
  onDidChangeTreeData?: Event<T | undefined | null | void>;
}

// --- Webview ---

export interface WebviewOptions {
  enableScripts?: boolean;
  enableForms?: boolean;
  localResourceRoots?: Uri[];
}

export interface Webview {
  html: string;
  options: WebviewOptions;
  onDidReceiveMessage: Event<unknown>;
  postMessage(message: unknown): Promise<boolean>;
  asWebviewUri(localResource: Uri): Uri;
}

export interface WebviewPanel {
  viewType: string;
  title: string;
  webview: Webview;
  viewColumn?: ViewColumn;
  active: boolean;
  visible: boolean;
  onDidDispose: Event<void>;
  onDidChangeViewState: Event<{ webviewPanel: WebviewPanel }>;
  reveal(viewColumn?: ViewColumn, preserveFocus?: boolean): void;
  dispose(): void;
}

// --- Status Bar ---

export interface StatusBarItem {
  alignment: StatusBarAlignment;
  priority?: number;
  text: string;
  tooltip?: string;
  color?: string;
  command?: string;
  show(): void;
  hide(): void;
  dispose(): void;
}

// --- Quick Pick / Input ---

export interface QuickPickItem {
  label: string;
  description?: string;
  detail?: string;
  picked?: boolean;
  alwaysShow?: boolean;
}

export interface QuickPickOptions {
  title?: string;
  placeHolder?: string;
  canPickMany?: boolean;
  matchOnDescription?: boolean;
  matchOnDetail?: boolean;
}

export interface InputBoxOptions {
  title?: string;
  value?: string;
  prompt?: string;
  placeHolder?: string;
  password?: boolean;
  validateInput?(value: string): string | undefined | null | Promise<string | undefined | null>;
}

// --- Output Channel ---

export interface OutputChannel {
  name: string;
  append(value: string): void;
  appendLine(value: string): void;
  clear(): void;
  show(preserveFocus?: boolean): void;
  hide(): void;
  dispose(): void;
}

// --- Workspace ---

export interface WorkspaceFolder {
  uri: Uri;
  name: string;
  index: number;
}

export interface WorkspaceConfiguration {
  get<T>(section: string, defaultValue?: T): T | undefined;
  has(section: string): boolean;
  update(section: string, value: unknown, target?: ConfigurationTarget): Promise<void>;
}

// --- Theme ---

export class ThemeIcon {
  static readonly File = new ThemeIcon("file");
  static readonly Folder = new ThemeIcon("folder");
  readonly id: string;
  constructor(id: string) { this.id = id; }
}

// --- RPC client interface (injected into Worker) ---

export interface RpcClient {
  request<T = unknown>(method: string, ...params: unknown[]): Promise<T>;
  notify(event: string, data: unknown): void;
}
