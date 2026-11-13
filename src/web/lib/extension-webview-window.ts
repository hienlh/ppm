import { usePanelStore } from "@/stores/panel-store";
import { useWindowStore } from "@/components/floating-window/window-store";
import { cascadeSpawnRect } from "@/components/floating-window/window-geometry";
import { isMobileDevice } from "@/hooks/use-is-mobile";

/** An extension window's first size, as a share of the work area: a panel that asked for a
 *  window wants room, the way a design canvas does. */
const EXTENSION_WINDOW_SHARE = { w: 0.72, h: 0.84 };

/**
 * Move a just-opened extension tab into a floating window of its own, for a panel created
 * with `preferWindow`. Closing the window closes the panel. A phone has no windows, so the
 * tab stays where it is there; at the window cap `popOutTab` refuses and it stays a tab too.
 */
export function popOutExtensionTab(tabId: string): void {
  if (isMobileDevice()) return;
  const panels = usePanelStore.getState();
  const panelId = panels.getPanelForTab(tabId)?.id;
  if (!panelId) return;
  const windows = useWindowStore.getState();
  const rect = cascadeSpawnRect(
    Object.values(windows.windows).map((w) => w.rect),
    windows.bounds,
    { w: Math.round(windows.bounds.w * EXTENSION_WINDOW_SHARE.w), h: Math.round(windows.bounds.h * EXTENSION_WINDOW_SHARE.h) },
  );
  panels.popOutTab(tabId, panelId, { closeTabsOnClose: true, rect });
}
