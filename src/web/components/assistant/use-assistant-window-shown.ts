/**
 * Whether the Assistant's window is on screen (open and not minimized): the rail button reads
 * it to show itself pressed.
 */
import { usePanelStore } from "@/stores/panel-store";
import { windowIdFromPanelId } from "@/stores/panel-utils";
import { useWindowStore } from "@/components/floating-window/window-store";
import { ASSISTANT_TAB_ID } from "./open-assistant";

export function useAssistantWindowShown(): boolean {
  const windowId = usePanelStore((s) => {
    const panel = Object.values(s.panels).find((p) => p.tabs.some((t) => t.id === ASSISTANT_TAB_ID));
    return panel ? windowIdFromPanelId(panel.id) : null;
  });
  return useWindowStore((s) => {
    const win = windowId ? s.windows[windowId] : undefined;
    return !!win && win.state !== "minimized";
  });
}
