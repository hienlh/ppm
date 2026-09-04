/**
 * "Open in window" — detaches a tab into a floating window, keeping it live.
 *
 * Desktop only: the window layer renders nothing below the md breakpoint, so on a phone
 * the item would move a tab somewhere the user cannot see (a scaled-down window is never
 * the answer — see the mobile-first UI rules).
 */
import { ExternalLink } from "lucide-react";
import { toast } from "sonner";
import { ContextMenuItem, ContextMenuSeparator } from "@/components/ui/context-menu";
import { useIsMobile } from "@/hooks/use-is-mobile";
import { usePanelStore } from "@/stores/panel-store";
import type { Tab } from "@/stores/tab-store";

interface TabPopOutMenuItemProps {
  tab: Tab;
  /** Panel the tab currently lives in — also where it re-docks when the window closes. */
  panelId: string;
}

export function TabPopOutMenuItem({ tab, panelId }: TabPopOutMenuItemProps) {
  const isMobile = useIsMobile();
  // The monitor already has a window kind of its own; detaching it would open a second,
  // duplicate presentation of the same data.
  if (isMobile || tab.type === "system-monitor") return null;

  return (
    <>
      <ContextMenuItem
        onClick={() => {
          const windowId = usePanelStore.getState().popOutTab(tab.id, panelId);
          // The only rejection a desktop user can hit is the shared window cap.
          if (!windowId) toast.error("Too many windows open — close one first");
        }}
      >
        <ExternalLink className="size-3.5 mr-2" />
        Open in window
      </ContextMenuItem>
      <ContextMenuSeparator />
    </>
  );
}
