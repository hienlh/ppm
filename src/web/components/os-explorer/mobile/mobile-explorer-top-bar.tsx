/**
 * Mobile sheet header: current folder name, nothing else. Every frequent action lives in
 * the bottom toolbar (the thumb zone) — putting anything interactive up here would be the
 * one part of a one-handed grip that is hardest to reach.
 *
 * The close button is the one addition beyond "title only": a sheet that fills the whole
 * screen leaves no backdrop to tap, so swipe-to-dismiss would otherwise be the only way out.
 */

import { X } from "lucide-react";
import type { ExplorerSlice } from "../explorer-store";

export interface MobileExplorerTopBarProps {
  slice: ExplorerSlice;
  onClose(): void;
}

/** The folder name to show for the current path — the last breadcrumb is the folder itself. */
function currentFolderName(slice: ExplorerSlice): string {
  const last = slice.breadcrumbs[slice.breadcrumbs.length - 1];
  return last?.name ?? slice.path;
}

export function MobileExplorerTopBar({ slice, onClose }: MobileExplorerTopBarProps) {
  return (
    <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2.5">
      <span className="min-w-0 flex-1 truncate text-[15px] font-semibold text-text">
        {currentFolderName(slice)}
      </span>
      <button
        type="button"
        aria-label="Close file explorer"
        title="Close"
        onClick={onClose}
        className="flex size-11 shrink-0 items-center justify-center rounded-full text-text-2 active:bg-surface-elevated"
      >
        <X className="size-5" />
      </button>
    </div>
  );
}
