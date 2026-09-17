/**
 * "Open in window" / "Open in picture-in-picture" — detaches a tab, keeping it live.
 *
 * The PiP route skips the window entirely from the user's point of view: a host window is
 * opened and hidden, and closing PiP closes it, so the tab lands back in this strip.
 *
 * Desktop only: the window layer renders nothing below the md breakpoint, so on a phone
 * the item would move a tab somewhere the user cannot see (a scaled-down window is never
 * the answer — see the mobile-first UI rules).
 */
import { ExternalLink, PictureInPicture2 } from "@/lib/icons";
import { toast } from "sonner";
import { openTabInPip } from "@/components/floating-window/open-tab-in-pip";
import { isDocumentPipSupported } from "@/components/floating-window/pip/pip-support";
import { ContextMenuItem, ContextMenuSeparator } from "@/components/ui/context-menu";
import { useIsMobile } from "@/hooks/use-is-mobile";
import { usePanelStore } from "@/stores/panel-store";
import { NON_POPPABLE_TAB_TYPES } from "@/stores/panel-utils";
import type { Tab } from "@/stores/tab-store";

interface TabPopOutMenuItemProps {
  tab: Tab;
  /** Panel the tab currently lives in — also where it re-docks when the window closes. */
  panelId: string;
}

export function TabPopOutMenuItem({ tab, panelId }: TabPopOutMenuItemProps) {
  const isMobile = useIsMobile();
  // Some tabs already have a window kind of their own; detaching one would open a second,
  // duplicate presentation of the same data.
  if (isMobile || NON_POPPABLE_TAB_TYPES.has(tab.type)) return null;

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
      {isDocumentPipSupported() && (
        <ContextMenuItem
          onClick={() => {
            // Nothing awaited before this call: it spends the click's activation on the PiP
            // request, and the browser grants that only to a live gesture.
            void openTabInPip(tab.id, panelId)
              .then((result) => {
                if (result === "window-cap") toast.error("Too many windows open — close one first");
              })
              .catch(() => {
                toast.error("Could not open the picture-in-picture window");
              });
          }}
        >
          <PictureInPicture2 className="size-3.5 mr-2" />
          Open in picture-in-picture
        </ContextMenuItem>
      )}
      <ContextMenuSeparator />
    </>
  );
}
