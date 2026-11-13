import { usePanelStore } from "@/stores/panel-store";
import { windowIdFromPanelId } from "@/stores/panel-utils";
import { useWindowStore } from "@/components/floating-window/window-store";
import { displayedRect, type Rect } from "@/components/floating-window/window-geometry";
import { isMobileDevice } from "@/hooks/use-is-mobile";
import type { ExtTabPlacement } from "../../types/extension-messages.ts";
import { besideWindowRect } from "./beside-window-rect";

/**
 * The calling webview panel, when this browser shows it: `rect` is its window on screen, null
 * when it is a docked tab or a minimised window (nothing to stand beside). Null when absent.
 */
function findAnchor(webviewPanelId: string): { rect: Rect | null } | null {
  for (const panel of Object.values(usePanelStore.getState().panels)) {
    if (!panel.tabs.some((t) => t.type === "extension" && t.metadata?.panelId === webviewPanelId)) continue;
    const windowId = windowIdFromPanelId(panel.id);
    const { windows, bounds } = useWindowStore.getState();
    const win = windowId ? windows[windowId] : undefined;
    if (!win || win.state === "minimized") return { rect: null };
    return { rect: displayedRect(win.state, win.rect, bounds) };
  }
  return null;
}

export interface TabPlacementContext {
  /** The tab did not exist before: its window is its home, and closing the window closes it. */
  created: boolean;
  /** The server sent this to this browser alone, rather than to every browser. */
  addressed: boolean;
}

/**
 * Put a tab an extension opened in a floating window in front, beside the calling panel's
 * window, so a chat opened from a panel that floats is not left hidden in the tab strip
 * behind it. Already in a window: that window comes forward. A docked tab moves into a new
 * window; one that existed before keeps its home, so closing the window docks it again.
 *
 * A phone has no windows and keeps the tab. A broadcast reaches every browser, and one that
 * does not show the calling panel is not where the request came from, so it keeps a tab too.
 * At the window cap `popOutTab` refuses and the tab stays where it is. Answers the window id.
 */
export function placeExtensionTab(tabId: string, placement: ExtTabPlacement, context: TabPlacementContext): string | null {
  if (isMobileDevice()) return null;
  const panelId = usePanelStore.getState().getPanelForTab(tabId)?.id;
  if (!panelId) return null;
  const ownWindow = windowIdFromPanelId(panelId);
  if (ownWindow) {
    useWindowStore.getState().focus(ownWindow);
    return ownWindow;
  }
  const anchor = placement.besidePanelId ? findAnchor(placement.besidePanelId) : null;
  if (placement.besidePanelId && !anchor && !context.addressed) return null;
  const rect = besideWindowRect(anchor?.rect ?? null, useWindowStore.getState().bounds);
  return usePanelStore.getState().popOutTab(tabId, panelId, { rect, ...(context.created ? { closeTabsOnClose: true } : {}) });
}

function allTabIds(): Set<string> {
  return new Set(Object.values(usePanelStore.getState().panels).flatMap((p) => p.tabs.map((t) => t.id)));
}

/** Run `open` (answers the tab id) and, when a placement was asked for, place what it opened. */
export function openPlacedTab(open: () => string, placement: ExtTabPlacement | undefined, addressed: boolean): string {
  if (!placement) return open();
  const before = allTabIds();
  const tabId = open();
  if (tabId) placeExtensionTab(tabId, placement, { created: !before.has(tabId), addressed });
  return tabId;
}
