/**
 * Full-screen mobile presentation of the explorer: a `BottomSheet` sized to the whole
 * visible viewport, hosting the exact same `ExplorerBody` every desktop window uses
 * (`variant="sheet"`), so file-type icons, the active OS skin's vocabulary and every mutation
 * action are shared code, not a parallel mobile implementation.
 *
 * Self-gated singleton, mounted once at the app root next to the other overlay singletons
 * (`ComparePicker`, `ImageOverlay`, …) — renders nothing until `openMobileExplorer` is called.
 */

import { type TouchEvent } from "react";
import { BottomSheet } from "@/components/ui/mobile-bottom-sheet";
import { ExplorerBody } from "../explorer-body";
import { useExplorerStore } from "../explorer-store";
import { MOBILE_EXPLORER_WINDOW_ID, useMobileExplorerOpenState } from "../use-explorer-open-state";

export function MobileExplorerSheet() {
  const isOpen = useMobileExplorerOpenState((s) => s.isOpen);
  const close = useMobileExplorerOpenState((s) => s.close);
  const path = useExplorerStore((s) => s.slices[MOBILE_EXPLORER_WINDOW_ID]?.path);
  const renaming = useExplorerStore(
    (s) => s.slices[MOBILE_EXPLORER_WINDOW_ID]?.inlineEdit?.kind === "rename",
  );

  // Swallowed only while an inline rename is active: a drag meant to clear the soft keyboard
  // (or just reach a field below it) would otherwise also read as a swipe-to-dismiss, since
  // `BottomSheet` wires its drag handlers on the panel — an ancestor of everything here.
  const suppressSwipe = (e: TouchEvent) => {
    if (renaming) e.stopPropagation();
  };

  if (!isOpen) return null;

  return (
    // Below the default sheet z-index (50): the explorer opens further sheets on top of
    // itself (row actions, "New", "More", "Places") that all rely on that default, and a
    // higher value here would silently sit above every one of them instead. 45 still clears
    // the mobile bottom nav (z-40) so the sheet reads as full-screen underneath it.
    <BottomSheet open={isOpen} onClose={close} zIndex={45} className="flex h-[var(--sheet-vh)] flex-col p-0">
      <div
        className="flex min-h-0 flex-1 flex-col"
        onTouchStart={suppressSwipe}
        onTouchMove={suppressSwipe}
      >
        {path ? (
          <ExplorerBody windowId={MOBILE_EXPLORER_WINDOW_ID} initialPath={path} variant="sheet" />
        ) : (
          <div className="flex flex-1 items-center justify-center text-sm text-text-2">Loading…</div>
        )}
      </div>
    </BottomSheet>
  );
}
