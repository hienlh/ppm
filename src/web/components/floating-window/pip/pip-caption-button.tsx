/**
 * Titlebar button that moves a floating window's body into a Document Picture-in-Picture
 * window and back. Every skin renders it, so every window kind gets the capability — the
 * skin only supplies the box (`className`) that matches its own caption metric.
 *
 * The button is absent, never disabled, where the API is missing (Firefox, Safari, any
 * non-secure context) — a caption button that only ever explains itself is worse than no
 * button at all.
 *
 * Known limitations while a window's body runs in PiP; expected behaviour, not regressions:
 *  - Toasts render in the main window. Sonner mounts one toaster at the app root and it
 *    stays there, so a message raised from the PiP body appears behind it.
 *  - `useIsMobile()` and Tailwind `md:` variants read the MAIN window's viewport, so the
 *    content keeps its desktop layout in a narrow PiP window instead of switching to mobile.
 *  - React's `onSelect`/`selectionchange` is delegated from the document the app root is
 *    mounted in; selection-driven UI degrades for content living in the PiP document.
 *  - `use-terminal`'s reconnect check reads the main document's visibility, so a hidden
 *    main tab is treated as hidden even while its terminal is visible in PiP.
 *  - Monaco chords (Ctrl+Z, Ctrl+F, …) do not fire while the editor sits in PiP: typing
 *    reaches the buffer, but the keybinding dispatcher listens on the window the editor was
 *    created in. Undo works again as soon as the body is brought back.
 *  - A tab-host titlebar shows the tab title captured at pop-out time; a tab renamed
 *    afterwards (a chat acquiring a name) keeps the old caption until it is popped out again.
 */

import { PictureInPicture2 } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { TITLEBAR_HEIGHT } from "../window-chrome-contract";
import { useWindowStore } from "../window-store";
import { setWindowPip, windowPip, windowSlot, useWindowPip } from "../window-pip-registry";
import { activePipHost, attachPipHost } from "./pip-host";
import { focusPipDocument } from "./pip-focus-target";
import { isDocumentPipSupported } from "./pip-support";

export interface PipCaptionButtonProps {
  /** Window id — the registry key for both the body element and the resulting handle. */
  id: string;
  /** The skin's caption-button box. Defaults to a compact icon button. */
  className?: string;
}

const DEFAULT_BOX =
  "grid place-items-center size-6 rounded text-text-2 can-hover:hover:bg-surface-elevated can-hover:hover:text-text transition-colors";

export function PipCaptionButton({ id, className }: PipCaptionButtonProps) {
  const pip = useWindowPip(id);

  if (!isDocumentPipSupported()) return null;

  const togglePip = () => {
    const active = windowPip(id);
    if (active) {
      active.detach();
      return;
    }

    const slot = windowSlot(id);
    if (!slot) {
      toast.error("This window has nothing to pop out yet");
      return;
    }
    const rect = useWindowStore.getState().windows[id]?.rect;

    // attachPipHost() is the first call that can consume the click's transient
    // activation; anything awaited before it costs the gesture and the request is
    // rejected. Only synchronous store/registry reads may precede it. The PiP window
    // shows the body alone, so the titlebar comes off the requested height.
    attachPipHost(slot, {
      // A zero falls through to the host's minimum size rather than a magic default.
      width: rect?.w ?? 0,
      height: rect ? rect.h - TITLEBAR_HEIGHT : 0,
      onDetach: () => setWindowPip(id, null),
    })
      .then((handle) => {
        // The window can be closed before this resolves, in which case onDetach has
        // already cleared the state and storing the handle would strand a dead one.
        // A null handle is that same case, detected inside the host. The slot check
        // covers a body that unmounted and came back: the new one is not this one.
        if (!handle || activePipHost() !== handle) return;
        if (windowSlot(id) !== slot) {
          handle.detach();
          return;
        }
        setWindowPip(id, handle);
        // A DOM move carries no focus with it: without this the popped-out terminal or
        // editor is visible but swallows nothing until the user clicks it.
        focusPipDocument(handle.pipWindow.document);
      })
      .catch(() => {
        toast.error("Could not open the picture-in-picture window");
      });
  };

  const label = pip ? "Bring back from picture-in-picture" : "Open in picture-in-picture";
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={Boolean(pip)}
      className={cn(className ?? DEFAULT_BOX, pip && "text-primary")}
      onClick={togglePip}
    >
      <PictureInPicture2 className="size-3.5" />
    </button>
  );
}
