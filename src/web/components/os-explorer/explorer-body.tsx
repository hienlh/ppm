/**
 * The explorer itself: sidebar · toolbar · view · status bar.
 *
 * Deliberately free of any window chrome so the mobile full-screen sheet can render the
 * exact same component; `variant` is the only thing that differs between the two hosts.
 */

import { useEffect, useMemo } from "react";
import { AlertTriangle, Home } from "lucide-react";
import { useFileStore } from "@/stores/file-store";
import { cn } from "@/lib/utils";
import { useExplorerActions } from "./actions/use-explorer-actions";
import { ExplorerDialogs } from "./explorer-dialogs";
import { ExplorerSidebar } from "./explorer-sidebar";
import { ExplorerStatusBar } from "./explorer-status-bar";
import { useExplorerStore } from "./explorer-store";
import { ExplorerToolbar } from "./explorer-toolbar";
import { useExplorerPinsStore } from "./explorer-pins-store";
import { FolderIconProvider } from "./icons/file-type-icon";
import { useExplorerSkin } from "./skins/use-explorer-skin";
import { sortAndFilterEntries } from "./sort-and-filter-entries";
import { useCoarseLongPress, usePrefersCoarsePointer } from "./use-coarse-long-press";
import { useExplorerKeyboard } from "./use-explorer-keyboard";
import { useExplorerNavigation } from "./use-explorer-navigation";
import { useHostInfo } from "./use-host-info";
import { useEntrySelection } from "./views/use-entry-selection";
import { viewComponentFor } from "./views/explorer-view-registry";

/** Row heights: comfortable for a mouse, ≥ 36 px for a finger. */
const ROW_HEIGHT_FINE = 28;
const ROW_HEIGHT_COARSE = 36;

export interface ExplorerBodyProps {
  windowId: string;
  /** Where the window opens; navigation takes over from there. */
  initialPath: string;
  /** Presentation host. The sheet variant fills its parent and drops the desktop chrome. */
  variant?: "window" | "sheet";
}

export function ExplorerBody({ windowId, initialPath, variant = "window" }: ExplorerBodyProps) {
  const ensure = useExplorerStore((s) => s.ensure);
  // Creating the slice in an effect (not during render) keeps the store write out of
  // React's render phase; the window shows nothing for exactly one frame.
  useEffect(() => ensure(windowId, initialPath), [ensure, windowId, initialPath]);

  const slice = useExplorerStore((s) => s.slices[windowId]);
  const showHidden = useExplorerStore((s) => s.showHidden);
  const viewMode = useExplorerStore((s) => s.viewMode);
  const sort = useExplorerStore((s) => s.sort);
  const { host } = useHostInfo();
  const hasClipboard = useFileStore((s) => (s.clipboard?.paths.length ?? 0) > 0);
  const isPinned = useExplorerPinsStore((s) => s.isPinned);
  const coarse = usePrefersCoarsePointer();
  const skin = useExplorerSkin();

  const nav = useExplorerNavigation(windowId, slice, showHidden);
  const { actions, dialogs } = useExplorerActions(windowId, slice, nav, host?.platform);

  const entries = useMemo(
    () => (slice ? sortAndFilterEntries(slice.entries, slice.filter, sort) : []),
    [slice?.entries, slice?.filter, sort], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const order = useMemo(() => entries.map((e) => e.path), [entries]);
  const selection = useEntrySelection(windowId, order);
  const onKeyDown = useExplorerKeyboard({
    slice,
    entries,
    actions,
    selection,
    nav,
  });
  // The background menu needs a press target on touch just as the rows do.
  const backgroundLongPress = useCoarseLongPress();

  if (!slice) return null;

  const View = viewComponentFor(viewMode);

  return (
    <div
      data-skin={skin.id}
      style={{ fontFamily: "var(--x-font)" }}
      className={cn("flex h-full min-h-0 w-full flex-col bg-panel text-text", variant === "sheet" && "rounded-t-xl")}
    >
      <ExplorerToolbar windowId={windowId} slice={slice} nav={nav} />

      {slice.error && (
        <div className="flex items-start gap-2 border-b border-border bg-error/10 px-2 py-1.5 text-xs text-error">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
          <div className="min-w-0 flex-1">
            <p className="break-words">{slice.error.message}</p>
            {slice.error.hint && <p className="mt-0.5 text-text-2">{slice.error.hint}</p>}
          </div>
          {host && (
            <button
              type="button"
              onClick={() => nav.go(host.homedir)}
              className="flex shrink-0 items-center gap-1 rounded border border-border px-1.5 py-0.5 text-text-2 can-hover:hover:bg-surface-elevated"
            >
              <Home className="size-3" /> Go home
            </button>
          )}
        </div>
      )}

      <FolderIconProvider value={{ closed: skin.FolderIcon, open: skin.FolderOpenIcon }}>
        <div className="flex min-h-0 flex-1">
          <ExplorerSidebar host={host} currentPath={slice.path} onNavigate={nav.go} vocab={skin.vocab} />
          <div className="min-w-0 flex-1" onKeyDown={onKeyDown} {...backgroundLongPress}>
            <View
              windowId={windowId}
              slice={slice}
              entries={entries}
              actions={actions}
              selection={selection}
              inlineError={dialogs.inlineError}
              hasClipboard={hasClipboard}
              isPinned={isPinned}
              rowHeight={coarse ? ROW_HEIGHT_COARSE : ROW_HEIGHT_FINE}
              nav={nav}
            />
          </div>
        </div>
      </FolderIconProvider>

      <ExplorerStatusBar entries={entries} selection={slice.selection} truncated={slice.truncated} />
      <ExplorerDialogs dialogs={dialogs} platform={host?.platform} sep={slice.sep} />
    </div>
  );
}
