/**
 * Full-screen mobile presentation of the Remote Desktop viewer — `WindowLayer` renders nothing
 * below `md`, so this is what mobile opens instead of the desktop floating window (see
 * `open-remote-desktop.ts`). Self-gated singleton, mounted once at the app root beside the
 * other mobile overlays (`MobileExplorerSheet`, `TeamMemberSheet`) — renders nothing until
 * `useRemoteDesktopMobileOpenState().open()` is called.
 *
 * The heavy viewer (canvas, WebCodecs decoder, gesture engine) is a nested lazy import, same as
 * `TeamMemberSheet` does for its content — nothing here loads until the sheet actually opens.
 */
import { Suspense, lazy } from "react";
import { BottomSheet } from "@/components/ui/mobile-bottom-sheet";
import { useRemoteDesktopMobileOpenState } from "./use-remote-desktop-mobile-open-state";

const RemoteDesktopMobileView = lazy(() => import("./remote-desktop-mobile-view"));

export function RemoteDesktopMobileSheet() {
  const isOpen = useRemoteDesktopMobileOpenState((s) => s.isOpen);
  const close = useRemoteDesktopMobileOpenState((s) => s.close);

  if (!isOpen) return null;

  return (
    <BottomSheet open onClose={close} zIndex={45} className="flex h-[var(--sheet-vh)] flex-col p-0">
      <Suspense fallback={<div className="flex flex-1 items-center justify-center text-sm text-text-2">Loading…</div>}>
        <RemoteDesktopMobileView onClose={close} />
      </Suspense>
    </BottomSheet>
  );
}
