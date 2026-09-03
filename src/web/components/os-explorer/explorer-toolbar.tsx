/**
 * Window toolbar: history navigation, the breadcrumb (switchable to a raw path field),
 * a name filter, the view switch and the hidden-files toggle.
 *
 * The path field is a deliberate toggle rather than a click-to-edit breadcrumb: pasting a
 * path is the fastest way to reach a deep folder, and a breadcrumb that turns into a field
 * on click makes the crumbs themselves hard to hit.
 */

import { useEffect, useState } from "react";
import {
  ArrowLeft, ArrowRight, ArrowUp, Columns3, Eye, EyeOff, LayoutGrid, List, PencilLine, RefreshCw, Search,
  Upload, X,
} from "lucide-react";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import type { ExplorerActions } from "./actions/use-explorer-actions";
import { ExplorerBreadcrumb } from "./explorer-breadcrumb";
import { ExplorerSortMenu } from "./explorer-sort-menu";
import { useExplorerStore, type ExplorerSlice, type ViewMode } from "./explorer-store";
import { toolbarButtonClass as buttonClass } from "./toolbar-icon-button";
import { usePrefersCoarsePointer } from "./use-coarse-long-press";
import type { ExplorerNavigation } from "./use-explorer-navigation";
import { AVAILABLE_VIEW_MODES } from "./views/explorer-view-registry";

const VIEW_ICON: Record<ViewMode, typeof List> = { list: List, icons: LayoutGrid, columns: Columns3 };
const VIEW_LABEL: Record<ViewMode, string> = { list: "List view", icons: "Icons view", columns: "Column view" };

export interface ExplorerToolbarProps {
  windowId: string;
  slice: ExplorerSlice;
  nav: ExplorerNavigation;
  actions: ExplorerActions;
}

export function ExplorerToolbar({ windowId, slice, nav, actions }: ExplorerToolbarProps) {
  const patch = useExplorerStore((s) => s.patch);
  const showHidden = useExplorerStore((s) => s.showHidden);
  const viewMode = useExplorerStore((s) => s.viewMode);
  const setPrefs = useExplorerStore((s) => s.setPrefs);

  const [editingPath, setEditingPath] = useState(false);
  const [draftPath, setDraftPath] = useState(slice.path);
  useEffect(() => setDraftPath(slice.path), [slice.path]);
  const coarse = usePrefersCoarsePointer();

  return (
    <div className="flex shrink-0 flex-wrap items-center gap-1 border-b border-border bg-[var(--x-toolbar-bg,var(--panel-2))] px-1.5 py-1">
      <button type="button" aria-label="Back" title="Back" disabled={!nav.canGoBack} onClick={nav.back} className={buttonClass(coarse)}>
        <ArrowLeft className="size-4" />
      </button>
      <button type="button" aria-label="Forward" title="Forward" disabled={!nav.canGoForward} onClick={nav.forward} className={buttonClass(coarse)}>
        <ArrowRight className="size-4" />
      </button>
      <button type="button" aria-label="Up one level" title="Up" disabled={!slice.parent} onClick={nav.up} className={buttonClass(coarse)}>
        <ArrowUp className="size-4" />
      </button>
      <button type="button" aria-label="Refresh" title="Refresh" onClick={nav.refresh} className={buttonClass(coarse)}>
        <RefreshCw className={cn("size-4", slice.loading && "animate-spin")} />
      </button>

      <div className="flex min-w-[8rem] flex-1 items-center gap-1 rounded border border-border bg-panel px-1">
        {editingPath ? (
          <input
            autoFocus
            aria-label="Path"
            value={draftPath}
            onChange={(e) => setDraftPath(e.target.value)}
            onBlur={() => setEditingPath(false)}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Enter") { nav.go(draftPath.trim()); setEditingPath(false); }
              else if (e.key === "Escape") { setDraftPath(slice.path); setEditingPath(false); }
            }}
            className="min-w-0 flex-1 bg-transparent py-1 font-mono text-xs text-text outline-none"
          />
        ) : (
          <ExplorerBreadcrumb crumbs={slice.breadcrumbs} onNavigate={nav.go} sep={slice.sep} className="flex-1 overflow-hidden py-0.5" />
        )}
        <button
          type="button"
          aria-label={editingPath ? "Show breadcrumb" : "Edit path"}
          title={editingPath ? "Show breadcrumb" : "Edit path"}
          onClick={() => setEditingPath((v) => !v)}
          className={buttonClass(coarse)}
        >
          <PencilLine className="size-3.5" />
        </button>
      </div>

      <div className="flex items-center gap-1 rounded border border-border bg-panel px-1">
        <Search className="size-3.5 shrink-0 text-text-subtle" />
        <input
          aria-label="Filter entries"
          placeholder="Filter"
          value={slice.filter}
          onChange={(e) => patch(windowId, { filter: e.target.value })}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Escape") patch(windowId, { filter: "" });
          }}
          className="w-24 min-w-0 bg-transparent py-1 text-xs text-text outline-none placeholder:text-text-subtle"
        />
        {slice.filter && (
          <button type="button" aria-label="Clear filter" onClick={() => patch(windowId, { filter: "" })} className={buttonClass(coarse)}>
            <X className="size-3.5" />
          </button>
        )}
      </div>

      {AVAILABLE_VIEW_MODES.length > 1 &&
        AVAILABLE_VIEW_MODES.map((mode) => {
          const Icon = VIEW_ICON[mode];
          return (
            <button
              key={mode}
              type="button"
              aria-label={VIEW_LABEL[mode]}
              title={VIEW_LABEL[mode]}
              aria-pressed={viewMode === mode}
              onClick={() => setPrefs({ viewMode: mode })}
              className={cn(buttonClass(coarse), viewMode === mode && "bg-accent-wash text-primary")}
            >
              <Icon className="size-4" />
            </button>
          );
        })}

      <ExplorerSortMenu coarse={coarse} />

      {actions.supportsFolderUpload ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button type="button" aria-label="Upload" title="Upload" className={buttonClass(coarse)}>
              <Upload className="size-4" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={() => actions.openUploadPicker()}>Upload Files…</DropdownMenuItem>
            <DropdownMenuItem onClick={() => actions.openUploadFolderPicker()}>Upload Folder…</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      ) : (
        <button
          type="button"
          aria-label="Upload"
          title="Upload"
          onClick={() => actions.openUploadPicker()}
          className={buttonClass(coarse)}
        >
          <Upload className="size-4" />
        </button>
      )}

      <button
        type="button"
        aria-label={showHidden ? "Hide hidden files" : "Show hidden files"}
        title={showHidden ? "Hide hidden files" : "Show hidden files"}
        aria-pressed={showHidden}
        onClick={() => setPrefs({ showHidden: !showHidden })}
        className={cn(buttonClass(coarse), showHidden && "bg-accent-wash text-primary")}
      >
        {showHidden ? <Eye className="size-4" /> : <EyeOff className="size-4" />}
      </button>
    </div>
  );
}
