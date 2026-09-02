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
  ArrowLeft, ArrowRight, ArrowUp, Eye, EyeOff, List, PencilLine, RefreshCw, Search, X,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { ExplorerBreadcrumb } from "./explorer-breadcrumb";
import { useExplorerStore, type ExplorerSlice, type ViewMode } from "./explorer-store";
import type { ExplorerNavigation } from "./use-explorer-navigation";
import { AVAILABLE_VIEW_MODES } from "./views/explorer-view-registry";

const VIEW_ICON: Record<ViewMode, typeof List> = { list: List, icons: List, columns: List };
const VIEW_LABEL: Record<ViewMode, string> = { list: "List view", icons: "Icons view", columns: "Column view" };

const buttonClass =
  "flex size-7 shrink-0 items-center justify-center rounded text-text-subtle can-hover:hover:bg-surface-elevated can-hover:hover:text-text disabled:opacity-30";

export interface ExplorerToolbarProps {
  windowId: string;
  slice: ExplorerSlice;
  nav: ExplorerNavigation;
}

export function ExplorerToolbar({ windowId, slice, nav }: ExplorerToolbarProps) {
  const patch = useExplorerStore((s) => s.patch);
  const showHidden = useExplorerStore((s) => s.showHidden);
  const viewMode = useExplorerStore((s) => s.viewMode);
  const setPrefs = useExplorerStore((s) => s.setPrefs);

  const [editingPath, setEditingPath] = useState(false);
  const [draftPath, setDraftPath] = useState(slice.path);
  useEffect(() => setDraftPath(slice.path), [slice.path]);

  return (
    <div className="flex shrink-0 flex-wrap items-center gap-1 border-b border-border bg-panel-2 px-1.5 py-1">
      <button type="button" aria-label="Back" title="Back" disabled={!nav.canGoBack} onClick={nav.back} className={buttonClass}>
        <ArrowLeft className="size-4" />
      </button>
      <button type="button" aria-label="Forward" title="Forward" disabled={!nav.canGoForward} onClick={nav.forward} className={buttonClass}>
        <ArrowRight className="size-4" />
      </button>
      <button type="button" aria-label="Up one level" title="Up" disabled={!slice.parent} onClick={nav.up} className={buttonClass}>
        <ArrowUp className="size-4" />
      </button>
      <button type="button" aria-label="Refresh" title="Refresh" onClick={nav.refresh} className={buttonClass}>
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
          <ExplorerBreadcrumb crumbs={slice.breadcrumbs} onNavigate={nav.go} className="flex-1 overflow-hidden py-0.5" />
        )}
        <button
          type="button"
          aria-label={editingPath ? "Show breadcrumb" : "Edit path"}
          title={editingPath ? "Show breadcrumb" : "Edit path"}
          onClick={() => setEditingPath((v) => !v)}
          className={buttonClass}
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
          <button type="button" aria-label="Clear filter" onClick={() => patch(windowId, { filter: "" })} className={buttonClass}>
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
              className={cn(buttonClass, viewMode === mode && "bg-accent-wash text-primary")}
            >
              <Icon className="size-4" />
            </button>
          );
        })}

      <button
        type="button"
        aria-label={showHidden ? "Hide hidden files" : "Show hidden files"}
        title={showHidden ? "Hide hidden files" : "Show hidden files"}
        aria-pressed={showHidden}
        onClick={() => setPrefs({ showHidden: !showHidden })}
        className={cn(buttonClass, showHidden && "bg-accent-wash text-primary")}
      >
        {showHidden ? <Eye className="size-4" /> : <EyeOff className="size-4" />}
      </button>
    </div>
  );
}
