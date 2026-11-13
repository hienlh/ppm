/**
 * Where a tab an extension opens should appear: `preferWindow` asks a desktop browser for a
 * floating window brought to the front, and `beside` names the panel the request comes from
 * (a value `createWebviewPanel` returned) so the window lands next to that panel's. A phone
 * opens an ordinary tab either way.
 */
export interface TabPlacementOptions {
  preferWindow?: boolean;
  /** A webview panel this extension created; anything else is ignored. */
  beside?: unknown;
}

/** What travels over RPC: the panel object stays in the worker, only its id leaves. */
export interface WireTabPlacement {
  preferWindow: true;
  besidePanelId?: string;
}

/** The id behind each panel object `createWebviewPanel` handed out; the panel's own shape stays VSCode's. */
const panelIds = new WeakMap<object, string>();

export function rememberWebviewPanelId(panel: object, panelId: string): void {
  panelIds.set(panel, panelId);
}

/** Undefined unless a window was asked for, so a call without options sends exactly what it always did. */
export function toWirePlacement(options: TabPlacementOptions | undefined): WireTabPlacement | undefined {
  if (options?.preferWindow !== true) return undefined;
  const beside = options.beside;
  const panelId = beside && typeof beside === "object" ? panelIds.get(beside) : undefined;
  return panelId ? { preferWindow: true, besidePanelId: panelId } : { preferWindow: true };
}
