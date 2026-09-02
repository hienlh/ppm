/**
 * The mobile toolbar's overflow sheet: view mode, sort, hidden files, permanent delete and
 * properties of the *current folder* (not the selection — that's what the row/tile menu and
 * the selection-mode toolbar are for).
 *
 * "Delete permanently" lives here rather than on the one-tap selection toolbar so the
 * irreversible action never sits as close at hand as Trash.
 */

import {
  Columns3, Eye, EyeOff, Info, LayoutGrid, List, Trash2,
} from "lucide-react";
import type { FsEntry } from "@/lib/fs-api";
import { BottomSheet, BottomSheetItem, BottomSheetSeparator, BottomSheetSubLabel } from "@/components/ui/mobile-bottom-sheet";
import type { ExplorerActions } from "../actions/use-explorer-actions";
import { useExplorerStore, type ExplorerSlice, type SortKey, type ViewMode } from "../explorer-store";
import { activeEntries } from "../use-explorer-keyboard";
import { AVAILABLE_VIEW_MODES } from "../views/explorer-view-registry";
import { cn } from "@/lib/utils";

const VIEW_ICON: Record<ViewMode, typeof List> = { list: List, icons: LayoutGrid, columns: Columns3 };
const VIEW_LABEL: Record<ViewMode, string> = { list: "List", icons: "Icons", columns: "Columns" };
const SORT_KEYS: { key: SortKey; label: string }[] = [
  { key: "name", label: "Name" },
  { key: "size", label: "Size" },
  { key: "modified", label: "Modified" },
  { key: "kind", label: "Kind" },
];

/** The current folder, in the shape `showProperties`/`PropertiesDialog` need — the dialog
 *  fetches everything else itself from `/api/fs/stat`. */
function currentFolderEntry(slice: ExplorerSlice): FsEntry {
  const name = slice.breadcrumbs[slice.breadcrumbs.length - 1]?.name ?? slice.path;
  return { name, path: slice.path, type: "directory", kind: "directory", modified: "" };
}

export interface MobileMoreSheetProps {
  open: boolean;
  onClose(): void;
  slice: ExplorerSlice;
  actions: ExplorerActions;
  entries: FsEntry[];
}

export function MobileMoreSheet({ open, onClose, slice, actions, entries }: MobileMoreSheetProps) {
  const viewMode = useExplorerStore((s) => s.viewMode);
  const sort = useExplorerStore((s) => s.sort);
  const showHidden = useExplorerStore((s) => s.showHidden);
  const setPrefs = useExplorerStore((s) => s.setPrefs);
  const targets = activeEntries(slice, entries);

  return (
    <BottomSheet open={open} onClose={onClose} className="p-2">
      <BottomSheetSubLabel>View</BottomSheetSubLabel>
      <div className="flex gap-1 px-2 pb-2">
        {AVAILABLE_VIEW_MODES.map((mode) => {
          const Icon = VIEW_ICON[mode];
          return (
            <button
              key={mode}
              type="button"
              aria-pressed={viewMode === mode}
              onClick={() => { setPrefs({ viewMode: mode }); onClose(); }}
              className={cn(
                "flex flex-1 flex-col items-center gap-1 rounded-lg py-2 text-xs active:bg-surface-elevated",
                viewMode === mode ? "bg-accent-wash text-primary" : "text-text-2",
              )}
            >
              <Icon className="size-4" />
              {VIEW_LABEL[mode]}
            </button>
          );
        })}
      </div>

      <BottomSheetSeparator />
      <BottomSheetSubLabel>Sort by</BottomSheetSubLabel>
      <div className="flex flex-wrap gap-1 px-2 pb-2">
        {SORT_KEYS.map(({ key, label }) => (
          <button
            key={key}
            type="button"
            aria-pressed={sort.key === key}
            onClick={() => {
              setPrefs({ sort: { key, dir: sort.key === key && sort.dir === "asc" ? "desc" : "asc" } });
              onClose();
            }}
            className={cn(
              "rounded-full border px-3 py-1.5 text-xs active:bg-surface-elevated",
              sort.key === key ? "border-primary bg-accent-wash text-text" : "border-border text-text-2",
            )}
          >
            {label}{sort.key === key ? (sort.dir === "asc" ? " ↑" : " ↓") : ""}
          </button>
        ))}
      </div>

      <BottomSheetSeparator />
      <BottomSheetItem onClick={() => setPrefs({ showHidden: !showHidden })}>
        {showHidden ? <Eye className="size-4" /> : <EyeOff className="size-4" />}
        {showHidden ? "Hide hidden files" : "Show hidden files"}
      </BottomSheetItem>

      <BottomSheetSeparator />
      <BottomSheetItem
        variant="destructive"
        disabled={targets.length === 0}
        onClick={() => actions.confirmPermanentDelete(targets)}
      >
        <Trash2 className="size-4" />
        Delete permanently{targets.length > 1 ? ` (${targets.length})` : ""}
      </BottomSheetItem>
      <BottomSheetItem onClick={() => actions.showProperties(currentFolderEntry(slice))}>
        <Info className="size-4" />
        Properties of this folder
      </BottomSheetItem>
    </BottomSheet>
  );
}
