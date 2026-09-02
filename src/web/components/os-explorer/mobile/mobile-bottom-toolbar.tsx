/**
 * Bottom toolbar: every frequent action lives here, in the thumb zone. Two rows share the
 * one bar — the normal row (navigate / create / paste / enter Select) and, once "Select" is
 * tapped, a row of bulk actions over the current selection. "Delete permanently" is
 * deliberately not here (it lives in the More sheet) — Trash is the default and the one-tap
 * row should not make the irreversible action as easy to reach as the reversible one.
 */

import { useState } from "react";
import {
  ArrowLeft, Check, ClipboardPaste, Copy, Download, FilePlus, FolderPlus, Info, MoreHorizontal, Plus, Scissors, Trash2, X,
} from "lucide-react";
import type { FsEntry } from "@/lib/fs-api";
import { BottomSheet, BottomSheetItem } from "@/components/ui/mobile-bottom-sheet";
import type { ExplorerActions } from "../actions/use-explorer-actions";
import type { ExplorerSlice } from "../explorer-store";
import type { ExplorerNavigation } from "../use-explorer-navigation";
import { useMobileExplorerOpenState } from "../use-explorer-open-state";
import { MobileMoreSheet } from "./mobile-more-sheet";

function ToolbarButton({
  icon: Icon, label, onClick, disabled, destructive,
}: {
  icon: typeof Plus; label: string; onClick(): void; disabled?: boolean; destructive?: boolean;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className={`flex min-w-[44px] flex-1 flex-col items-center gap-0.5 rounded-lg py-1.5 text-[10px] active:bg-surface-elevated disabled:opacity-30 ${destructive ? "text-error" : "text-text-2"}`}
    >
      <Icon className="size-5" />
      <span className="truncate">{label}</span>
    </button>
  );
}

export interface MobileBottomToolbarProps {
  slice: ExplorerSlice;
  nav: ExplorerNavigation;
  actions: ExplorerActions;
  entries: FsEntry[];
  hasClipboard: boolean;
}

export function MobileBottomToolbar({ slice, nav, actions, entries, hasClipboard }: MobileBottomToolbarProps) {
  const selectMode = useMobileExplorerOpenState((s) => s.selectMode);
  const setSelectMode = useMobileExplorerOpenState((s) => s.setSelectMode);
  const [newOpen, setNewOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);

  const selected = entries.filter((e) => slice.selection.has(e.path));

  if (selectMode) {
    const exitSelect = () => { setSelectMode(false); };
    return (
      <div className="flex shrink-0 items-center gap-1 border-t border-border px-1 py-1">
        <ToolbarButton icon={X} label="Cancel" onClick={exitSelect} />
        <span className="px-1 text-xs text-text-subtle">{selected.length} selected</span>
        <div className="flex-1" />
        <ToolbarButton icon={Scissors} label="Cut" disabled={selected.length === 0} onClick={() => actions.cut(selected)} />
        <ToolbarButton icon={Copy} label="Copy" disabled={selected.length === 0} onClick={() => actions.copy(selected)} />
        <ToolbarButton icon={Trash2} label="Trash" disabled={selected.length === 0} destructive onClick={() => actions.trash(selected)} />
        <ToolbarButton
          icon={Download}
          label="Download"
          disabled={!selected.some((e) => e.type === "file")}
          onClick={() => actions.download(selected)}
        />
        {selected.length === 1 && (
          <ToolbarButton icon={Info} label="Info" onClick={() => actions.showProperties(selected[0]!)} />
        )}
      </div>
    );
  }

  return (
    <>
      <div className="flex shrink-0 items-center gap-1 border-t border-border px-1 py-1">
        <ToolbarButton icon={ArrowLeft} label="Back" disabled={!nav.canGoBack} onClick={nav.back} />
        <ToolbarButton icon={Plus} label="New" onClick={() => setNewOpen(true)} />
        <ToolbarButton icon={ClipboardPaste} label="Paste" disabled={!hasClipboard} onClick={() => actions.paste()} />
        <ToolbarButton icon={Check} label="Select" onClick={() => setSelectMode(true)} />
        <ToolbarButton icon={MoreHorizontal} label="More" onClick={() => setMoreOpen(true)} />
      </div>

      <BottomSheet open={newOpen} onClose={() => setNewOpen(false)} className="p-2">
        <BottomSheetItem onClick={() => actions.startCreate("new-file")}>
          <FilePlus className="size-4" /> New File
        </BottomSheetItem>
        <BottomSheetItem onClick={() => actions.startCreate("new-folder")}>
          <FolderPlus className="size-4" /> New Folder
        </BottomSheetItem>
      </BottomSheet>

      <MobileMoreSheet open={moreOpen} onClose={() => setMoreOpen(false)} slice={slice} actions={actions} entries={entries} />
    </>
  );
}
