/**
 * Titlebar for a window hosting a detached tab: the default chrome plus one caption button
 * that moves the tab into a Document Picture-in-Picture window and back.
 *
 * The button is absent, never disabled, where the API is missing (Firefox, Safari, any
 * non-secure context) — a caption button that only ever explains itself is worse than no
 * button at all.
 *
 * Known limitations while a tab runs in PiP; expected behaviour, not regressions:
 *  - Toasts render in the main window. Sonner mounts one toaster at the app root and it
 *    stays there, so a message raised from the PiP tab appears behind it.
 *  - `useIsMobile()` and Tailwind `md:` variants read the MAIN window's viewport, so a tab
 *    keeps its desktop layout in a narrow PiP window instead of switching to mobile.
 *  - React's `onSelect`/`selectionchange` is delegated from the document the app root is
 *    mounted in; selection-driven UI degrades for content living in the PiP document.
 *  - `use-terminal`'s reconnect check reads the main document's visibility, so a hidden
 *    main tab is treated as hidden even while its terminal is visible in PiP.
 */

import { PictureInPicture2 } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { CAPTION_BUTTON, DefaultWindowChrome } from "./default-window-chrome";
import { TITLEBAR_HEIGHT, type WindowChromeProps } from "./window-chrome-contract";
import { useWindowStore } from "./window-store";
import { activePipHost, attachPipHost } from "./pip/pip-host";
import { focusPipDocument } from "./pip/pip-focus-target";
import { isDocumentPipSupported } from "./pip/pip-support";
import { setTabHostPip, tabHostPip, tabHostSlot, useTabHostPip } from "./tab-host-pip-registry";

export function TabHostWindowChrome(props: WindowChromeProps) {
  const pip = useTabHostPip(props.id);

  const togglePip = () => {
    const active = tabHostPip(props.id);
    if (active) {
      active.detach();
      return;
    }

    const slot = tabHostSlot(props.id);
    if (!slot) {
      toast.error("This window has no tab to pop out yet");
      return;
    }
    const rect = useWindowStore.getState().windows[props.id]?.rect;

    // attachPipHost() is the first call that can consume the click's transient
    // activation; anything awaited before it costs the gesture and the request is
    // rejected. Only synchronous store/registry reads may precede it. The PiP window
    // shows the body alone, so the titlebar comes off the requested height.
    attachPipHost(slot, {
      // A zero falls through to the host's minimum size rather than a magic default.
      width: rect?.w ?? 0,
      height: rect ? rect.h - TITLEBAR_HEIGHT : 0,
      onDetach: () => setTabHostPip(props.id, null),
    })
      .then((handle) => {
        // The window can be closed before this resolves, in which case onDetach has
        // already cleared the state and storing the handle would strand a dead one.
        if (activePipHost() !== handle) return;
        setTabHostPip(props.id, handle);
        // A DOM move carries no focus with it: without this the popped-out terminal or
        // editor is visible but swallows nothing until the user clicks it.
        focusPipDocument(handle.pipWindow.document);
      })
      .catch(() => {
        toast.error("Could not open the picture-in-picture window");
      });
  };

  return (
    <DefaultWindowChrome {...props}>
      {isDocumentPipSupported() && (
        <button
          type="button"
          title={pip ? "Bring back from picture-in-picture" : "Open in picture-in-picture"}
          aria-label={pip ? "Bring back from picture-in-picture" : "Open in picture-in-picture"}
          aria-pressed={Boolean(pip)}
          className={cn(CAPTION_BUTTON, pip && "text-primary")}
          onClick={togglePip}
        >
          <PictureInPicture2 className="size-3.5" />
        </button>
      )}
    </DefaultWindowChrome>
  );
}
