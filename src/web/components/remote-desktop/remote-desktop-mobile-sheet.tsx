/**
 * Full-screen mobile presentation of the Remote Desktop viewer — `WindowLayer` renders nothing
 * below `md`, so this is what mobile opens instead of the desktop floating window (see
 * `open-remote-desktop.ts`). Self-gated singleton, mounted once at the app root beside the
 * other mobile overlays (`MobileExplorerSheet`, `TeamMemberSheet`) — renders nothing until
 * `useRemoteDesktopMobileOpenState().open()` is called.
 *
 * Deliberately NOT the shared `BottomSheet`: that component tracks `visualViewport` and shrinks
 * its panel to leave room above the on-screen keyboard (right for a chat input you need visible
 * next to the keyboard), but this viewer's "keyboard" is just a hidden input forwarding
 * keystrokes — nothing here needs to stay visible above it, and shrinking the canvas viewport
 * every time the toolbar's Keyboard button is tapped is exactly the wrong behavior. It also
 * wires swipe-to-dismiss on touchstart/move/end, which fights the gesture engine's own
 * `stopPropagation()`-based touch handling. A plain `fixed inset-0` portal sidesteps both —
 * this stays full-viewport no matter what the keyboard does; `remote-desktop-mobile-view.tsx`
 * reads `visualViewport` itself and floats just its toolbar/key-bar row above the keyboard.
 *
 * The heavy viewer (canvas, WebCodecs decoder, gesture engine) is a nested lazy import, same as
 * `TeamMemberSheet` does for its content — nothing here loads until the sheet actually opens.
 */
import { Suspense, lazy } from "react";
import { createPortal } from "react-dom";
import { usePortalContainer } from "@/components/ui/portal-container-context";
import { useRemoteDesktopMobileOpenState } from "./use-remote-desktop-mobile-open-state";

const RemoteDesktopMobileView = lazy(() => import("./remote-desktop-mobile-view"));

export function RemoteDesktopMobileSheet() {
  const isOpen = useRemoteDesktopMobileOpenState((s) => s.isOpen);
  const close = useRemoteDesktopMobileOpenState((s) => s.close);
  const portalContainer = usePortalContainer();

  if (!isOpen) return null;

  return createPortal(
    <div className="fixed inset-0 z-[45] bg-black" data-testid="remote-desktop-mobile-sheet">
      <Suspense fallback={<div className="flex h-full items-center justify-center text-sm text-text-2">Loading…</div>}>
        <RemoteDesktopMobileView onClose={close} />
      </Suspense>
    </div>,
    portalContainer ?? document.getElementById("root") ?? document.body,
  );
}
