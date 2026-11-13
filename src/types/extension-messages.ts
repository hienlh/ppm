/**
 * Shared message types for the Extension WebSocket bridge.
 * Server ↔ Client communication for extension UI updates.
 */
import type { ExtensionContributes } from "./extension.ts";

// --- UI types (shared with extension-store) ---

export interface StatusBarItemMsg {
  id: string;
  text: string;
  tooltip?: string;
  command?: string;
  alignment: "left" | "right";
  priority: number;
  extensionId?: string;
}

/** Wire shape for a row action button — mirrors TreeItemAction in
 * src/web/stores/extension-store.ts exactly; that FE type is the source of truth for what
 * ActionButton actually renders. */
export interface TreeItemActionMsg {
  /** A name the web UI knows (`src/web/lib/extension-icons.ts`); an unknown one draws a refresh arrow. */
  icon: string;
  tooltip: string;
  command: string;
  commandArgs?: unknown[];
}

export interface TreeItemMsg {
  id: string;
  label: string;
  description?: string;
  tooltip?: string;
  icon?: string;
  /** Label wraps instead of truncating — for rows whose text is the content. */
  wrap?: boolean;
  /** A CSS colour for the dot before the label. */
  color?: string;
  badge?: string | number;
  collapsibleState: "none" | "collapsed" | "expanded";
  command?: string;
  commandArgs?: unknown[];
  actions?: TreeItemActionMsg[];
  /** http(s) only, checked by vscode-compat and again by the renderer. */
  url?: string;
  children?: TreeItemMsg[];
  contextValue?: string;
}

export interface QuickPickItemMsg {
  label: string;
  description?: string;
  detail?: string;
  picked?: boolean;
}

// --- Composer ---

export interface ComposerOptionsMsg {
  title?: string;
  prompt?: string;
  value?: string;
  permissionMode?: string;
  model?: string;
}

export interface ComposerResultMsg {
  content: string;
  model?: string;
  effort?: string;
  thinking?: boolean;
  permissionMode: string;
}

/**
 * Where a tab an extension opens should appear on a desktop: in a floating window brought to
 * the front, placed beside the window of the webview panel `besidePanelId` names (the panel
 * the request came from). A phone ignores it and opens an ordinary tab.
 */
export interface ExtTabPlacement {
  preferWindow: true;
  besidePanelId?: string;
}

// --- Server → Client messages ---

export type ExtServerMsg =
  | { type: "tree:update"; viewId: string; items: TreeItemMsg[]; parentId?: string }
  | { type: "tree:refresh"; viewId: string }
  | { type: "statusbar:update"; item: StatusBarItemMsg }
  | { type: "statusbar:remove"; itemId: string }
  | { type: "notification"; id: string; level: "info" | "warn" | "error"; message: string; actions?: string[] }
  | { type: "quickpick:show"; requestId: string; items: QuickPickItemMsg[]; options?: { title?: string; placeholder?: string; canPickMany?: boolean } }
  | { type: "inputbox:show"; requestId: string; options: { title?: string; prompt?: string; value?: string; placeholder?: string; password?: boolean } }
  | { type: "webview:create"; panelId: string; extensionId: string; viewType: string; title: string; projectPath?: string; projectName?: string; preferWindow?: boolean }
  | { type: "webview:html"; panelId: string; html: string }
  | { type: "webview:dispose"; panelId: string }
  | { type: "webview:postMessage"; panelId: string; message: unknown }
  /** This socket's id, sent once on connect; a `tab:open` may be addressed to one client by it. */
  | { type: "client:hello"; clientId: string }
  /** `clientId` set: only that browser opens the tab; every other one ignores the message. */
  | { type: "tab:open"; tabType: string; title: string; projectId: string | null; closable?: boolean; metadata?: Record<string, unknown>; clientId?: string; placement?: ExtTabPlacement }
  | { type: "project:switch"; projectName: string }
  | { type: "contributions:update"; contributions: ExtensionContributes; activationErrors?: Record<string, string> }
  | { type: "composer:show"; requestId: string; options: ComposerOptionsMsg }
  | { type: "composer:dismiss"; requestId: string }
  /** The server stopped waiting for this dialog: every tab still showing it closes it. */
  | { type: "quickpick:dismiss"; requestId: string }
  | { type: "inputbox:dismiss"; requestId: string };

// --- Client → Server messages ---

export type ExtClientMsg =
  | { type: "ready" }
  | { type: "command:execute"; command: string; args?: unknown[] }
  | { type: "tree:expand"; viewId: string; itemId: string }
  | { type: "tree:click"; viewId: string; itemId: string; command?: string }
  | { type: "webview:message"; panelId: string; message: unknown }
  | { type: "webview:close"; panelId: string }
  | { type: "quickpick:resolve"; requestId: string; selected: QuickPickItemMsg[] | null }
  | { type: "inputbox:resolve"; requestId: string; value: string | null }
  | { type: "notification:action"; id: string; action: string | null }
  | { type: "composer:resolve"; requestId: string; result: ComposerResultMsg | null }
  /** The device's IANA zone, on every connect and whenever it changes (`vscode.env.clientTimeZone`). */
  | { type: "client:timezone"; timeZone: string; deviceId: string };
