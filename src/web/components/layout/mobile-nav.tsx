import { useState, useEffect, useRef, useCallback } from "react";
import {
  FolderOpen, Terminal, MessageSquare, GitBranch, GitCommitHorizontal,
  FileDiff, FileCode, Settings, Menu, X, ArrowLeft, ArrowRight, SplitSquareVertical, MoveVertical,
} from "lucide-react";
import { usePanelStore } from "@/stores/panel-store";
import { findPanelPosition, MAX_ROWS } from "@/stores/panel-utils";
import type { TabType } from "@/stores/tab-store";
import { cn } from "@/lib/utils";

const TAB_ICONS: Record<TabType, React.ElementType> = {
  projects: FolderOpen, terminal: Terminal, chat: MessageSquare, editor: FileCode,
  "git-graph": GitBranch, "git-status": GitCommitHorizontal, "git-diff": FileDiff, settings: Settings,
};

interface MobileNavProps { onMenuPress: () => void; }

export function MobileNav({ onMenuPress }: MobileNavProps) {
  const focusedPanelId = usePanelStore((s) => s.focusedPanelId);
  const panel = usePanelStore((s) => s.panels[s.focusedPanelId]);
  const panelCount = usePanelStore((s) => Object.keys(s.panels).length);
  const grid = usePanelStore((s) => s.grid);
  const tabs = panel?.tabs ?? [];
  const activeTabId = panel?.activeTabId ?? null;
  const tabRefs = useRef<Map<string, HTMLButtonElement>>(new Map());
  const prevTabCount = useRef(tabs.length);

  const [menuTabId, setMenuTabId] = useState<string | null>(null);
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (tabs.length > prevTabCount.current && activeTabId) {
      tabRefs.current.get(activeTabId)?.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "nearest" });
    }
    prevTabCount.current = tabs.length;
  }, [tabs.length, activeTabId]);

  const startLongPress = useCallback((tabId: string) => {
    longPressTimer.current = setTimeout(() => setMenuTabId(tabId), 400);
  }, []);

  const cancelLongPress = useCallback(() => {
    if (longPressTimer.current) { clearTimeout(longPressTimer.current); longPressTimer.current = null; }
  }, []);

  // Context menu actions
  const pos = findPanelPosition(grid, focusedPanelId);
  const canSplitDown = pos ? (grid[pos.col]?.length ?? 0) < MAX_ROWS : false;
  const otherPanelIds = Object.keys(usePanelStore.getState().panels).filter((id) => id !== focusedPanelId);

  function moveTabLeft(tabId: string) {
    const idx = tabs.findIndex((t) => t.id === tabId);
    if (idx > 0) usePanelStore.getState().reorderTab(tabId, focusedPanelId, idx - 1);
  }
  function moveTabRight(tabId: string) {
    const idx = tabs.findIndex((t) => t.id === tabId);
    if (idx < tabs.length - 1) usePanelStore.getState().reorderTab(tabId, focusedPanelId, idx + 1);
  }
  function splitDown(tabId: string) {
    usePanelStore.getState().splitPanel("down", tabId, focusedPanelId);
  }
  function moveToPanel(tabId: string, targetPanelId: string) {
    usePanelStore.getState().moveTab(tabId, focusedPanelId, targetPanelId);
  }

  const menuTab = menuTabId ? tabs.find((t) => t.id === menuTabId) : null;
  const menuTabIdx = menuTabId ? tabs.findIndex((t) => t.id === menuTabId) : -1;

  return (
    <nav className="fixed bottom-0 left-0 right-0 md:hidden bg-background border-t border-border z-40 select-none">
      <div className="flex items-center h-12">
        <button onClick={onMenuPress} className="flex items-center justify-center size-12 shrink-0 text-text-secondary border-r border-border">
          <Menu className="size-5" />
        </button>

        <div className="flex-1 flex items-center h-12 overflow-x-auto">
          {tabs.map((tab) => {
            const Icon = TAB_ICONS[tab.type];
            const isActive = tab.id === activeTabId;
            return (
              <button
                key={tab.id}
                ref={(el) => { if (el) tabRefs.current.set(tab.id, el); else tabRefs.current.delete(tab.id); }}
                onClick={() => usePanelStore.getState().setActiveTab(tab.id)}
                onTouchStart={() => startLongPress(tab.id)}
                onTouchEnd={cancelLongPress}
                onTouchMove={cancelLongPress}
                onContextMenu={(e) => e.preventDefault()}
                className={cn(
                  "flex items-center gap-1 px-3 h-12 whitespace-nowrap text-xs shrink-0 border-t-2 transition-colors",
                  isActive ? "border-primary bg-surface text-primary" : "border-transparent text-text-secondary",
                )}
              >
                <Icon className="size-4" />
                <span className="max-w-[80px] truncate">{tab.title}</span>
                {tab.closable && (
                  <span role="button" tabIndex={0} onClick={(e) => { e.stopPropagation(); usePanelStore.getState().closeTab(tab.id); }}
                    className="ml-0.5 p-0.5 rounded hover:bg-surface-elevated">
                    <X className="size-3" />
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </div>

      {/* Long-press action sheet */}
      {menuTab && (
        <>
          {/* Backdrop */}
          <div className="fixed inset-0 z-50" onClick={() => setMenuTabId(null)} />
          {/* Action sheet */}
          <div className="fixed bottom-14 left-2 right-2 z-50 bg-surface border border-border rounded-lg shadow-lg overflow-hidden animate-in slide-in-from-bottom-2 duration-150">
            <div className="px-3 py-2 text-xs text-text-secondary border-b border-border truncate">
              {menuTab.title}
            </div>
            {menuTabIdx > 0 && (
              <button onClick={() => { moveTabLeft(menuTabId!); setMenuTabId(null); }}
                className="flex items-center gap-2 w-full px-3 py-2.5 text-sm text-foreground active:bg-surface-elevated">
                <ArrowLeft className="size-4" /> Move Left
              </button>
            )}
            {menuTabIdx < tabs.length - 1 && (
              <button onClick={() => { moveTabRight(menuTabId!); setMenuTabId(null); }}
                className="flex items-center gap-2 w-full px-3 py-2.5 text-sm text-foreground active:bg-surface-elevated">
                <ArrowRight className="size-4" /> Move Right
              </button>
            )}
            {canSplitDown && tabs.length > 1 && (
              <button onClick={() => { splitDown(menuTabId!); setMenuTabId(null); }}
                className="flex items-center gap-2 w-full px-3 py-2.5 text-sm text-foreground active:bg-surface-elevated">
                <SplitSquareVertical className="size-4" /> Split to Bottom
              </button>
            )}
            {otherPanelIds.map((pid, i) => (
              <button key={pid} onClick={() => { moveToPanel(menuTabId!, pid); setMenuTabId(null); }}
                className="flex items-center gap-2 w-full px-3 py-2.5 text-sm text-foreground active:bg-surface-elevated">
                <MoveVertical className="size-4" /> Move to Panel {i + 1 === 1 ? "Top" : "Bottom"}
              </button>
            ))}
          </div>
        </>
      )}
    </nav>
  );
}
