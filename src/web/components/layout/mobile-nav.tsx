import { useState, useEffect, useRef, useCallback } from "react";
import {
  Terminal, MessageSquare, GitBranch, Database,
  FileDiff, FileCode, Settings, Menu, X, ArrowLeft, ArrowRight, SplitSquareVertical, MoveVertical, Layers, Plus,
  ChevronRight, Globe, Puzzle,
} from "lucide-react";
import { usePanelStore } from "@/stores/panel-store";
import { useProjectStore, resolveOrder } from "@/stores/project-store";
import { findPanelPosition, MAX_ROWS } from "@/stores/panel-utils";
import { resolveProjectColor } from "@/lib/project-palette";
import { getProjectInitials } from "@/lib/project-avatar";
import type { TabType } from "@/stores/tab-store";
import { cn } from "@/lib/utils";
import { openCommandPalette } from "@/hooks/use-global-keybindings";
import { useNotificationStore, notificationColor } from "@/stores/notification-store";
import { useTabOverflow, getHiddenUnreadDirection } from "@/hooks/use-tab-overflow";

const NEW_TAB_OPTIONS: { type: TabType; label: string }[] = [
  { type: "terminal", label: "Terminal" },
  { type: "chat", label: "AI Chat" },
  { type: "git-graph", label: "Git Graph" },
  { type: "settings", label: "Settings" },
];
const NEW_TAB_LABELS: Partial<Record<TabType, string>> = Object.fromEntries(NEW_TAB_OPTIONS.map((o) => [o.type, o.label]));

const TAB_ICONS: Record<TabType, React.ElementType> = {
  terminal: Terminal, chat: MessageSquare, editor: FileCode, database: Database, sqlite: Database, postgres: Database,
  "git-graph": GitBranch, "git-diff": FileDiff, settings: Settings, browser: Globe,
  "extension-webview": Puzzle,
};

interface MobileNavProps { onMenuPress: () => void; onProjectsPress: () => void; }

export function MobileNav({ onMenuPress, onProjectsPress }: MobileNavProps) {
  const focusedPanelId = usePanelStore((s) => s.focusedPanelId);
  const panel = usePanelStore((s) => s.panels[s.focusedPanelId]);
  const panelCount = usePanelStore((s) => Object.keys(s.panels).length);
  const grid = usePanelStore((s) => s.grid);
  const tabs = panel?.tabs ?? [];
  const activeTabId = panel?.activeTabId ?? null;
  const tabRefs = useRef<Map<string, HTMLButtonElement>>(new Map());
  const mobileScrollRef = useRef<HTMLDivElement>(null);
  const prevTabCount = useRef(tabs.length);
  const notifications = useNotificationStore((s) => s.notifications);
  const { canScrollLeft, canScrollRight, scrollRight: doScrollRight } =
    useTabOverflow(mobileScrollRef);
  const hiddenUnread = getHiddenUnreadDirection(mobileScrollRef.current, tabRefs.current as Map<string, HTMLElement>, tabs, notifications);

  const [menuTabId, setMenuTabId] = useState<string | null>(null);
  const [newTabSheetOpen, setNewTabSheetOpen] = useState(false);
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
  const canSplitDown = pos ? grid.length < MAX_ROWS : false;
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

  const { activeProject: activeProjectForTab } = useProjectStore.getState();
  function handleNewTab(type: TabType) {
    const needsProject = type === "git-graph" || type === "git-diff" || type === "terminal" || type === "chat";
    const metadata = needsProject ? { projectName: activeProjectForTab?.name } : undefined;
    usePanelStore.getState().openTab(
      { type, title: NEW_TAB_LABELS[type] ?? type, metadata, projectId: activeProjectForTab?.name ?? null, closable: true },
      focusedPanelId,
    );
    setNewTabSheetOpen(false);
  }

  // Active project avatar for the Projects button
  const { activeProject, projects, customOrder } = useProjectStore();
  const ordered = resolveOrder(projects, customOrder ?? null);
  const allNames = ordered.map((p) => p.name);
  const activeIdx = ordered.findIndex((p) => p.name === activeProject?.name);
  const activeColor = activeProject
    ? resolveProjectColor(activeProject.color, activeIdx >= 0 ? activeIdx : 0)
    : "#4f86c6";
  const activeInitials = activeProject
    ? getProjectInitials(activeProject.name, allNames)
    : null;

  return (
    <nav className="fixed bottom-0 left-0 right-0 md:hidden bg-background border-t border-border z-40 select-none">
      <div className="flex items-center h-12">
        {/* Fixed section: Menu + Project + Add — curved right edge */}
        <div className={cn(
          "flex items-center shrink-0 bg-background relative z-10 transition-all duration-200",
          canScrollLeft ? "rounded-r-2xl shadow-[6px_0_12px_-4px_rgba(0,0,0,0.12)]" : "border-r border-border",
        )}>
          <button onClick={onMenuPress} className="flex items-center justify-center size-12 shrink-0 text-text-secondary">
            <Menu className="size-5" />
          </button>

          <div className="w-px self-stretch bg-border shrink-0" />

          <button
            onClick={onProjectsPress}
            className="flex items-center justify-center size-12 shrink-0 text-text-secondary"
            title="Switch project"
          >
            {activeInitials ? (
              <div
                className="size-7 rounded-full flex items-center justify-center text-[10px] font-bold text-white"
                style={{ background: activeColor }}
              >
                {activeInitials}
              </div>
            ) : (
              <Layers className="size-5" />
            )}
          </button>

          <div className="w-px self-stretch bg-border shrink-0" />

          <button
            onClick={() => openCommandPalette()}
            className={cn(
              "flex items-center justify-center shrink-0 text-text-secondary gap-1.5 h-12",
              tabs.length === 0 ? "px-4" : "w-12",
            )}
          >
            <Plus className="size-4" />
            {tabs.length === 0 && <span className="text-xs">New Tab</span>}
          </button>
        </div>

        {/* Tab list — overlaps under curved edge so tabs slide beneath it */}
        <div className="flex-1 min-w-0 relative flex items-center h-12 -ml-4">
          <div ref={mobileScrollRef} className="flex-1 min-w-0 flex items-center h-12 overflow-x-auto scrollbar-none pl-4">
          {tabs.map((tab) => {
            const Icon = TAB_ICONS[tab.type];
            const isActive = tab.id === activeTabId;
            const sessionId = tab.type === "chat" ? (tab.metadata?.sessionId as string) : undefined;
            const entry = sessionId ? notifications.get(sessionId) : undefined;
            const notiType = entry && entry.count > 0 ? entry.type : null;
            return (
              <button
                key={tab.id}
                ref={(el) => { if (el) tabRefs.current.set(tab.id, el); else tabRefs.current.delete(tab.id); }}
                onClick={() => {
                  usePanelStore.getState().setActiveTab(tab.id);
                  if (sessionId) useNotificationStore.getState().clearForSession(sessionId);
                }}
                onTouchStart={() => startLongPress(tab.id)}
                onTouchEnd={cancelLongPress}
                onTouchMove={cancelLongPress}
                onContextMenu={(e) => e.preventDefault()}
                className={cn(
                  "flex items-center gap-1 px-3 h-12 whitespace-nowrap text-xs shrink-0 border-t-2 transition-colors",
                  isActive ? "border-primary bg-surface text-primary" : "border-transparent text-text-secondary",
                )}
              >
                <span className="relative">
                  <Icon className="size-4" />
                  {notiType && !isActive && (
                    <span className={cn("absolute -top-1 -right-1 size-2 rounded-full", notificationColor(notiType))} />
                  )}
                </span>
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
          {/* Right scroll arrow */}
          {canScrollRight && (
            <button onClick={doScrollRight} className="absolute right-0 z-10 flex items-center justify-center size-8 bg-gradient-to-l from-background via-background to-transparent">
              <span className="relative">
                <ChevronRight className="size-3.5 text-text-secondary" />
                {hiddenUnread.right && <span className={cn("absolute -top-1 -left-0.5 size-1.5 rounded-full", notificationColor(hiddenUnread.right))} />}
              </span>
            </button>
          )}
        </div>
      </div>

      {/* New tab action sheet */}
      {newTabSheetOpen && (
        <>
          <div className="fixed inset-0 z-50" onClick={() => setNewTabSheetOpen(false)} />
          <div className="fixed bottom-14 left-2 right-2 z-50 bg-surface border border-border rounded-lg shadow-lg overflow-hidden animate-in slide-in-from-bottom-2 duration-150">
            <div className="px-3 py-2 text-xs text-text-secondary border-b border-border">New Tab</div>
            {NEW_TAB_OPTIONS.map((opt) => {
              const Icon = TAB_ICONS[opt.type];
              return (
                <button
                  key={opt.type}
                  onClick={() => handleNewTab(opt.type)}
                  className="flex items-center gap-2 w-full px-3 py-2.5 text-sm text-foreground active:bg-surface-elevated"
                >
                  <Icon className="size-4" /> {opt.label}
                </button>
              );
            })}
          </div>
        </>
      )}

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
