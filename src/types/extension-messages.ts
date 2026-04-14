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

export interface TreeItemMsg {
  id: string;
  label: string;
  description?: string;
  tooltip?: string;
  icon?: string;
  collapsibleState: "none" | "collapsed" | "expanded";
  command?: string;
  children?: TreeItemMsg[];
  contextValue?: string;
}

export interface QuickPickItemMsg {
  label: string;
  description?: string;
  detail?: string;
  picked?: boolean;
}

// --- Server → Client messages ---

export type ExtServerMsg =
  | { type: "tree:update"; viewId: string; items: TreeItemMsg[]; parentId?: string }
  | { type: "tree:refresh"; viewId: string }
  | { type: "statusbar:update"; item: StatusBarItemMsg }
  | { type: "statusbar:remove"; itemId: string }
  | { type: "notification"; id: string; level: "info" | "warn" | "error"; message: string; actions?: string[] }
  | { type: "quickpick:show"; requestId: string; items: QuickPickItemMsg[]; options?: { placeholder?: string; canPickMany?: boolean } }
  | { type: "inputbox:show"; requestId: string; options: { prompt?: string; value?: string; placeholder?: string; password?: boolean } }
  | { type: "webview:create"; panelId: string; extensionId: string; viewType: string; title: string }
  | { type: "webview:html"; panelId: string; html: string }
  | { type: "webview:dispose"; panelId: string }
  | { type: "webview:postMessage"; panelId: string; message: unknown }
  | { type: "tab:open"; tabType: string; title: string; projectId: string | null; closable?: boolean; metadata?: Record<string, unknown> }
  | { type: "contributions:update"; contributions: ExtensionContributes };

// --- Client → Server messages ---

export type ExtClientMsg =
  | { type: "ready" }
  | { type: "command:execute"; command: string; args?: unknown[] }
  | { type: "tree:expand"; viewId: string; itemId: string }
  | { type: "tree:click"; viewId: string; itemId: string; command?: string }
  | { type: "webview:message"; panelId: string; message: unknown }
  | { type: "quickpick:resolve"; requestId: string; selected: QuickPickItemMsg[] | null }
  | { type: "inputbox:resolve"; requestId: string; value: string | null }
  | { type: "notification:action"; id: string; action: string | null };
