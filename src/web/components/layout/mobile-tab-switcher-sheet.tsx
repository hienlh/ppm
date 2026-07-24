/**
 * Mobile tab-switcher bottom sheet (handoff A2).
 * Opened by the current-tab button in MobileNav. Searchable, grouped by split
 * panel, per-row activate + close. Grouping/filtering is delegated to the pure
 * buildTabSwitcherGroups helper; this file is presentation + wiring only.
 */
import { useState, useRef, useCallback } from "react";
import { Search, X, Plus, Columns2 } from "lucide-react";
import { BottomSheet } from "@/components/ui/mobile-bottom-sheet";
import { usePanelStore } from "@/stores/panel-store";
import { useNotificationStore } from "@/stores/notification-store";
import { getTabTypeIcon } from "@/lib/tab-type-icons";
import { buildTabSwitcherGroups, type TabSortMode } from "./tab-switcher-groups";
import type { Tab } from "@/stores/tab-store";
import { cn } from "@/lib/utils";

const SORT_STORAGE_KEY = "ppm:tab-sort-mode";

function loadSortMode(): TabSortMode {
  try { return localStorage.getItem(SORT_STORAGE_KEY) === "recent" ? "recent" : "default"; } catch { return "default"; }
}

interface MobileTabSwitcherSheetProps {
  open: boolean;
  onClose: () => void;
  /** Opens the command palette (closes this sheet first). */
  onOpenPalette: () => void;
  tabs: Tab[];
  tabPanelMap: Record<string, string>;
  panelOrder: string[];
  activeTabId: string | null;
  /** Active project's resolved color for the row accent bar (transparent if null). */
  projectColor: string | null;
  /** Long-press a row → open the per-tab action menu (owned by MobileNav). */
  onTabLongPress?: (tabId: string) => void;
  /** tabId → recency rank (0 = most recent); drives the "Recent" sort mode. */
  recency: Map<string, number>;
}

export function MobileTabSwitcherSheet({
  open, onClose, onOpenPalette, tabs, tabPanelMap, panelOrder, activeTabId, projectColor, onTabLongPress, recency,
}: MobileTabSwitcherSheetProps) {
  const [query, setQuery] = useState("");
  const [sortMode, setSortMode] = useState<TabSortMode>(loadSortMode);
  const changeSort = useCallback((mode: TabSortMode) => {
    setSortMode(mode);
    try { localStorage.setItem(SORT_STORAGE_KEY, mode); } catch { /* ignore */ }
  }, []);
  const { groups, total } = buildTabSwitcherGroups(tabs, tabPanelMap, panelOrder, query, { sortMode, recency });

  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const startLongPress = useCallback((tabId: string) => {
    if (!onTabLongPress) return;
    longPressTimer.current = setTimeout(() => onTabLongPress(tabId), 400);
  }, [onTabLongPress]);
  const cancelLongPress = useCallback(() => {
    if (longPressTimer.current) { clearTimeout(longPressTimer.current); longPressTimer.current = null; }
  }, []);

  function activate(tab: Tab) {
    usePanelStore.getState().setActiveTab(tab.id, tabPanelMap[tab.id]);
    if (tab.type === "chat") {
      const sid = tab.metadata?.sessionId as string | undefined;
      if (sid) useNotificationStore.getState().clearForSession(sid);
    }
    onClose();
  }

  function close(tab: Tab, e: React.MouseEvent) {
    e.stopPropagation();
    usePanelStore.getState().closeTab(tab.id, tabPanelMap[tab.id]);
  }

  function openPalette() {
    onClose();
    onOpenPalette();
  }

  return (
    <BottomSheet open={open} onClose={onClose} className="max-h-[72vh] flex flex-col">
      {/* Header — title, count, sort toggle, and new-tab button on one row */}
      <div className="shrink-0 flex items-center gap-2 pl-4 pr-3 pt-1 pb-2.5">
        <span className="text-[13px] font-semibold text-text-primary">Open Tabs</span>
        <span className="px-1.5 h-[18px] inline-flex items-center rounded-md border border-border bg-surface-elevated text-[10px] font-mono text-text-secondary">
          {tabs.length}
        </span>
        <div className="flex-1" />
        {/* Sort segmented control */}
        <div className="flex items-center gap-0.5 p-0.5 rounded-lg bg-background border border-border">
          {([["default", "Default"], ["recent", "Recent"]] as const).map(([mode, label]) => (
            <button
              key={mode}
              onClick={() => changeSort(mode)}
              aria-pressed={sortMode === mode}
              className={cn(
                "h-7 px-2.5 rounded-md text-[11px] font-medium transition-colors select-none",
                sortMode === mode
                  ? "bg-primary/10 text-primary"
                  : "text-text-secondary active:bg-surface-elevated",
              )}
            >
              {label}
            </button>
          ))}
        </div>
        <button
          onClick={openPalette}
          title="New tab"
          aria-label="New tab"
          className="flex items-center justify-center size-8 rounded-full border border-dashed border-border text-text-subtle active:bg-surface-elevated"
        >
          <Plus className="size-4" />
        </button>
      </div>

      {/* Search */}
      <div className="shrink-0 px-3 pb-2">
        <div className="flex items-center gap-2 h-10 px-3 rounded-xl bg-background border border-border">
          <Search className="size-4 text-text-subtle shrink-0" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter tabs..."
            className="flex-1 bg-transparent outline-none text-text-primary placeholder:text-text-subtle"
            style={{ fontSize: 16 }} // 16px prevents iOS zoom-on-focus
          />
        </div>
      </div>

      {/* Groups — min-h-0 lets this flex child shrink below content height so
          overflow-y-auto actually scrolls inside the capped-height sheet. */}
      <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain px-2 pb-2">
        {total === 0 ? (
          <p className="text-center text-[13px] text-text-subtle py-6">No tabs match</p>
        ) : (
          groups.map((group) => (
            <div key={group.panelId} className="mb-1">
              {group.label && (
                <div className="flex items-center gap-1.5 px-2 pt-2 pb-1">
                  <Columns2 className="size-3 text-text-subtle" />
                  <span className="text-[11px] font-semibold uppercase tracking-[0.05em] text-text-subtle">{group.label}</span>
                  <span className="text-[10px] font-mono text-text-subtle">{group.tabs.length}</span>
                </div>
              )}
              {group.tabs.map((tab) => {
                const Icon = getTabTypeIcon(tab.type);
                const isActive = tab.id === activeTabId;
                return (
                  <button
                    key={tab.id}
                    onClick={() => activate(tab)}
                    onTouchStart={() => startLongPress(tab.id)}
                    onTouchEnd={cancelLongPress}
                    onTouchMove={cancelLongPress}
                    onContextMenu={(e) => e.preventDefault()}
                    className={cn(
                      "relative flex items-center gap-2.5 w-full h-11 rounded-lg pl-3.5 pr-2 transition-colors",
                      isActive ? "bg-primary/10" : "active:bg-surface-elevated",
                    )}
                  >
                    {/* Project color accent bar */}
                    <span
                      aria-hidden
                      className="absolute left-0 top-2 bottom-2 w-[3px] rounded-r-sm"
                      style={{ backgroundColor: tab.projectId && projectColor ? projectColor : "transparent" }}
                    />
                    <Icon className={cn("size-4 shrink-0", isActive ? "text-primary" : "text-text-secondary")} />
                    <span className={cn("flex-1 text-left text-sm font-medium truncate", isActive ? "text-primary" : "text-text-primary")}>
                      {tab.title}
                    </span>
                    {isActive && <span className="size-1.5 rounded-full bg-primary shrink-0" />}
                    {tab.closable && (
                      <span
                        role="button"
                        tabIndex={0}
                        onClick={(e) => close(tab, e)}
                        className="flex items-center justify-center size-8 rounded-lg text-text-subtle active:bg-surface-elevated shrink-0"
                      >
                        <X className="size-4" />
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          ))
        )}
      </div>
    </BottomSheet>
  );
}
