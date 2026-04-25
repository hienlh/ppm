import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import {
  Terminal, MessageSquare, Database,
  FileDiff, FileCode, Settings, Menu, X, ArrowLeft, ArrowRight, SplitSquareVertical, MoveVertical, Layers, Plus,
  ChevronRight, Globe, Puzzle, Copy, Download, Pencil, Trash2,
} from "lucide-react";
import { usePanelStore } from "@/stores/panel-store";
import { useShallow } from "zustand/react/shallow";
import { useProjectStore, resolveOrder } from "@/stores/project-store";
import { useFileStore, type FileNode } from "@/stores/file-store";
import { findPanelPosition, MAX_ROWS } from "@/stores/panel-utils";
import { resolveProjectColor } from "@/lib/project-palette";
import { getProjectInitials } from "@/lib/project-avatar";
import type { Tab, TabType } from "@/stores/tab-store";
import { cn } from "@/lib/utils";
import { openCommandPalette } from "@/hooks/use-global-keybindings";
import { useNotificationStore, notificationColor } from "@/stores/notification-store";
import { useStreamingStore } from "@/stores/streaming-store";
import { useTabOverflow, getHiddenUnreadDirection } from "@/hooks/use-tab-overflow";
import { downloadFile } from "@/lib/file-download";
import { FileActions } from "@/components/explorer/file-actions";
import { api, projectUrl } from "@/lib/api-client";
import { BottomSheet } from "@/components/ui/mobile-bottom-sheet";

const NEW_TAB_OPTIONS: { type: TabType; label: string }[] = [
  { type: "terminal", label: "Terminal" },
  { type: "chat", label: "AI Chat" },
  { type: "settings", label: "Settings" },
];
const NEW_TAB_LABELS: Partial<Record<TabType, string>> = Object.fromEntries(NEW_TAB_OPTIONS.map((o) => [o.type, o.label]));

const TAB_ICONS: Record<TabType, React.ElementType> = {
  terminal: Terminal, chat: MessageSquare, editor: FileCode, database: Database, sqlite: Database, postgres: Database,
  "git-diff": FileDiff, settings: Settings, ports: Globe,
  extension: Puzzle,
  "extension-webview": Puzzle,
  "conflict-editor": FileDiff,
};

interface MobileNavProps { onMenuPress: () => void; onProjectsPress: () => void; }

export function MobileNav({ onMenuPress, onProjectsPress }: MobileNavProps) {
  const focusedPanelId = usePanelStore((s) => s.focusedPanelId);
  const panels = usePanelStore((s) => s.panels);
  const grid = usePanelStore((s) => s.grid);

  const currentProject = usePanelStore((s) => s.currentProject);

  // Merge tabs from all panels in grid (mobile shows single merged tab bar)
  const { tabs, tabPanelMap } = useMemo(() => {
    const panelIds = grid.flat();
    const allTabs: Tab[] = [];
    const map: Record<string, string> = {};
    for (const pid of panelIds) {
      const p = panels[pid];
      if (p) {
        for (const t of p.tabs) {
          // Skip cross-project tabs (race condition in openTab during project switch)
          if (t.projectId && currentProject && t.projectId !== currentProject) continue;
          allTabs.push(t);
          map[t.id] = pid;
        }
      }
    }
    return { tabs: allTabs, tabPanelMap: map };
  }, [panels, grid, currentProject]);

  const activeTabId = panels[focusedPanelId]?.activeTabId ?? null;
  const tabRefs = useRef<Map<string, HTMLButtonElement>>(new Map());
  const mobileScrollRef = useRef<HTMLDivElement>(null);
  const prevTabCount = useRef(tabs.length);
  const notifications = useNotificationStore((s) => s.notifications);
  const streamingSessions = useStreamingStore((s) => s.sessions);
  const [sessionTagMap, setSessionTagMap] = useState<Record<string, { id: number; name: string; color: string }>>({});

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

  // Context menu actions — use the tab's actual panel (not always focused)
  const menuTab = menuTabId ? tabs.find((t) => t.id === menuTabId) : null;
  const menuTabPanelId = menuTabId ? tabPanelMap[menuTabId] ?? focusedPanelId : focusedPanelId;
  const menuTabPanelTabs = panels[menuTabPanelId]?.tabs ?? [];
  const menuTabIdx = menuTabId ? menuTabPanelTabs.findIndex((t) => t.id === menuTabId) : -1;

  const pos = findPanelPosition(grid, menuTabPanelId);
  const canSplitDown = pos ? grid.length < MAX_ROWS : false;
  const otherPanelIds = grid.flat().filter((id) => id !== menuTabPanelId);

  function moveTabLeft(tabId: string) {
    const pid = tabPanelMap[tabId] ?? focusedPanelId;
    const pTabs = usePanelStore.getState().panels[pid]?.tabs ?? [];
    const idx = pTabs.findIndex((t) => t.id === tabId);
    if (idx > 0) usePanelStore.getState().reorderTab(tabId, pid, idx - 1);
  }
  function moveTabRight(tabId: string) {
    const pid = tabPanelMap[tabId] ?? focusedPanelId;
    const pTabs = usePanelStore.getState().panels[pid]?.tabs ?? [];
    const idx = pTabs.findIndex((t) => t.id === tabId);
    if (idx < pTabs.length - 1) usePanelStore.getState().reorderTab(tabId, pid, idx + 1);
  }
  function splitDown(tabId: string) {
    const pid = tabPanelMap[tabId] ?? focusedPanelId;
    usePanelStore.getState().splitPanel("down", tabId, pid);
  }
  function moveToPanel(tabId: string, targetPanelId: string) {
    const pid = tabPanelMap[tabId] ?? focusedPanelId;
    usePanelStore.getState().moveTab(tabId, pid, targetPanelId);
  }

  const [fileActionState, setFileActionState] = useState<{ action: string; node: FileNode; tabId: string } | null>(null);

  function handleFileAction(tab: Tab, action: string) {
    const filePath = tab.metadata?.filePath as string | undefined;
    const projectName = tab.metadata?.projectName as string | undefined;
    switch (action) {
      case "copy-path":
        if (filePath) navigator.clipboard.writeText(filePath).catch(() => {});
        break;
      case "download":
        if (filePath && projectName) downloadFile(projectName, filePath);
        break;
      case "rename":
      case "delete":
        if (filePath) {
          setFileActionState({ action, tabId: tab.id, node: { name: tab.title, path: filePath, type: "file" } });
        }
        break;
    }
    setMenuTabId(null);
  }

  const { activeProject: activeProjectForTab } = useProjectStore.getState();
  function handleNewTab(type: TabType) {
    const state = usePanelStore.getState();
    const firstPanelId = state.grid[0]?.[0] ?? state.focusedPanelId;
    const needsProject = type === "git-diff" || type === "terminal" || type === "chat";
    const metadata = needsProject ? { projectName: activeProjectForTab?.name } : undefined;
    state.openTab(
      { type, title: NEW_TAB_LABELS[type] ?? type, metadata, projectId: activeProjectForTab?.name ?? null, closable: true },
      firstPanelId,
    );
    setNewTabSheetOpen(false);
  }

  // Active project avatar for the Projects button
  const { activeProject, projects, customOrder } = useProjectStore(useShallow((s) => ({ activeProject: s.activeProject, projects: s.projects, customOrder: s.customOrder })));

  // Session tag map — same fetch pattern as desktop tab-bar so mobile tabs can show tag bar
  const chatSessionIds = tabs.filter((t) => t.type === "chat" && t.metadata?.sessionId).map((t) => t.metadata!.sessionId as string);
  useEffect(() => {
    if (!activeProject?.name || chatSessionIds.length === 0) return;
    api.get<{ sessions: { id: string; tag?: { id: number; name: string; color: string } | null }[] }>(
      `${projectUrl(activeProject.name)}/chat/sessions?limit=50`,
    ).then((data) => {
      const map: Record<string, { id: number; name: string; color: string }> = {};
      for (const s of data.sessions) { if (s.tag) map[s.id] = s.tag; }
      setSessionTagMap(map);
    }).catch(() => {});
  }, [activeProject?.name, chatSessionIds.join(",")]); // eslint-disable-line react-hooks/exhaustive-deps
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
            const Icon = TAB_ICONS[tab.type] || Puzzle;
            const isActive = tab.id === activeTabId;
            const sessionId = tab.type === "chat" ? (tab.metadata?.sessionId as string) : undefined;
            const entry = sessionId ? notifications.get(sessionId) : undefined;
            const notiType = entry && entry.count > 0 ? entry.type : null;
            const tagColor = sessionId ? sessionTagMap[sessionId]?.color : undefined;
            const isStreaming = sessionId ? streamingSessions.has(sessionId) : false;
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
                  "relative flex items-center gap-1 px-3 h-12 whitespace-nowrap text-xs shrink-0 border-t-2 transition-colors",
                  isActive ? "border-primary bg-surface text-primary" : "border-transparent text-text-secondary",
                )}
              >
                {tagColor && (
                  // Tag identity marker — VS Code-style vertical bar on left edge, matches desktop tab
                  <span
                    aria-hidden
                    className="absolute left-0 top-2 bottom-2 w-[3px] rounded-r-full pointer-events-none"
                    style={{ backgroundColor: tagColor }}
                  />
                )}
                <span className={cn("relative", isStreaming && "text-amber-500")}>
                  <Icon className="size-4" />
                  {isStreaming ? (
                    // Messenger-style typing dots inside chat bubble — inherits amber via bg-current
                    <span aria-hidden className="absolute inset-0 flex items-center justify-center gap-[1.5px]">
                      <span className="tab-typing-dot size-[2px] rounded-full bg-current" />
                      <span className="tab-typing-dot size-[2px] rounded-full bg-current" style={{ animationDelay: "0.15s" }} />
                      <span className="tab-typing-dot size-[2px] rounded-full bg-current" style={{ animationDelay: "0.3s" }} />
                    </span>
                  ) : notiType && !isActive ? (
                    <span className={cn("absolute -top-1 -right-1 size-2 rounded-full", notificationColor(notiType))} />
                  ) : null}
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
      <BottomSheet open={newTabSheetOpen} onClose={() => setNewTabSheetOpen(false)}>
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
      </BottomSheet>

      {/* Long-press tab action sheet */}
      <BottomSheet open={!!menuTab} onClose={() => setMenuTabId(null)}>
        <div className="px-3 py-2 text-xs text-text-secondary border-b border-border truncate">
          {menuTab?.title}
        </div>
        {menuTab?.type === "editor" && (
          <>
            <button onClick={() => handleFileAction(menuTab, "copy-path")}
              className="flex items-center gap-2 w-full px-3 py-2.5 text-sm text-foreground active:bg-surface-elevated">
              <Copy className="size-4" /> Copy Path
            </button>
            <button onClick={() => handleFileAction(menuTab, "download")}
              className="flex items-center gap-2 w-full px-3 py-2.5 text-sm text-foreground active:bg-surface-elevated">
              <Download className="size-4" /> Download
            </button>
            <button onClick={() => handleFileAction(menuTab, "rename")}
              className="flex items-center gap-2 w-full px-3 py-2.5 text-sm text-foreground active:bg-surface-elevated">
              <Pencil className="size-4" /> Rename
            </button>
            <button onClick={() => handleFileAction(menuTab, "delete")}
              className="flex items-center gap-2 w-full px-3 py-2.5 text-sm text-error active:bg-surface-elevated">
              <Trash2 className="size-4" /> Delete
            </button>
            <div className="h-px bg-border mx-2" />
          </>
        )}
        {menuTab?.closable && (
          <button onClick={() => { usePanelStore.getState().closeTab(menuTabId!); setMenuTabId(null); }}
            className="flex items-center gap-2 w-full px-3 py-2.5 text-sm text-foreground active:bg-surface-elevated">
            <X className="size-4" /> Close
          </button>
        )}
        {menuTabIdx > 0 && (
          <button onClick={() => { moveTabLeft(menuTabId!); setMenuTabId(null); }}
            className="flex items-center gap-2 w-full px-3 py-2.5 text-sm text-foreground active:bg-surface-elevated">
            <ArrowLeft className="size-4" /> Move Left
          </button>
        )}
        {menuTabIdx < menuTabPanelTabs.length - 1 && (
          <button onClick={() => { moveTabRight(menuTabId!); setMenuTabId(null); }}
            className="flex items-center gap-2 w-full px-3 py-2.5 text-sm text-foreground active:bg-surface-elevated">
            <ArrowRight className="size-4" /> Move Right
          </button>
        )}
        {canSplitDown && menuTabPanelTabs.length > 1 && (
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
      </BottomSheet>

      {fileActionState && (
        <FileActions
          action={fileActionState.action}
          node={fileActionState.node}
          projectName={activeProjectForTab?.name ?? ""}
          onClose={() => setFileActionState(null)}
          onRefresh={() => {
            if (activeProjectForTab) useFileStore.getState().fetchTree(activeProjectForTab.name);
            if (fileActionState.action === "delete") {
              usePanelStore.getState().closeTab(fileActionState.tabId);
            }
          }}
        />
      )}
    </nav>
  );
}
