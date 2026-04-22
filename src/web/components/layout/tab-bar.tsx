import { useEffect, useRef, useCallback, useState, memo } from "react";
import {
  Plus,
  Terminal,
  MessageSquare,
  FileDiff,
  Settings,
  FileCode,
  Database,
  ChevronLeft,
  ChevronRight,
  Globe,
  Puzzle,
} from "lucide-react";
import { useTabStore, type TabType } from "@/stores/tab-store";
import { usePanelStore } from "@/stores/panel-store";
import { useProjectStore } from "@/stores/project-store";
import { useFileStore, type FileNode } from "@/stores/file-store";
import { useCompareStore } from "@/stores/compare-store";
import { openCompareTab } from "@/lib/open-compare-tab";
import { toast } from "sonner";
import { useTabDrag } from "@/hooks/use-tab-drag";
import { useTouchTabDrag, wasTouchDragRecent } from "@/hooks/use-touch-tab-drag";
import { openCommandPalette } from "@/hooks/use-global-keybindings";
import { api, projectUrl } from "@/lib/api-client";
import { useProjectTags } from "@/components/chat/tag-filter-chips";
import {
  ContextMenuSub, ContextMenuSubTrigger, ContextMenuSubContent,
  ContextMenuItem, ContextMenuSeparator,
} from "@/components/ui/context-menu";
import { Tag, Check, Columns2 } from "lucide-react";
import { basename } from "@/lib/utils";
import { useNotificationStore, notificationColor } from "@/stores/notification-store";
import { useStreamingStore } from "@/stores/streaming-store";
import { useTabOverflow, getHiddenUnreadDirection } from "@/hooks/use-tab-overflow";
import { DraggableTab } from "./draggable-tab";
import { cn } from "@/lib/utils";
import type { Tab } from "@/stores/tab-store";
import { downloadFile } from "@/lib/file-download";
import { FileActions } from "@/components/explorer/file-actions";

const TAB_ICONS: Record<TabType, React.ElementType> = {
  terminal: Terminal,
  chat: MessageSquare,
  editor: FileCode,
  database: Database,
  sqlite: Database,
  postgres: Database,
  "git-diff": FileDiff,
  settings: Settings,
  ports: Globe,
  extension: Puzzle,
  "extension-webview": Puzzle,
  "conflict-editor": FileDiff,
};

interface TabBarProps {
  panelId?: string;
}

export const TabBar = memo(function TabBar({ panelId }: TabBarProps) {
  const activeProject = useProjectStore((s) => s.activeProject);
  const tabRefs = useRef<Map<string, HTMLButtonElement>>(new Map());
  const scrollRef = useRef<HTMLDivElement>(null);
  const prevTabCount = useRef(0);

  // Read tabs from panel-store if panelId given, else from tab-store (focused)
  const panel = usePanelStore((s) => panelId ? s.panels[panelId] : s.panels[s.focusedPanelId]);
  const tabs = panel?.tabs ?? [];
  const activeTabId = panel?.activeTabId ?? null;
  const effectivePanelId = panel?.id ?? usePanelStore.getState().focusedPanelId;

  const { dropIndex, handleDragStart, handleDragOver, handleDragOverBar, handleDrop, handleDragEnd } =
    useTabDrag(effectivePanelId);
  const { handleTouchStart, handleTouchMove, handleTouchEnd } = useTouchTabDrag(effectivePanelId);

  const { projectTags, loadTags } = useProjectTags(activeProject?.name);
  const [sessionTagMap, setSessionTagMap] = useState<Record<string, { id: number; name: string; color: string }>>({});

  // Fetch session tags for open chat tabs
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

  const assignTagToSession = useCallback(async (sessionId: string, tagId: number | null) => {
    if (!activeProject?.name) return;
    try {
      if (tagId !== null) {
        await api.patch(`${projectUrl(activeProject.name)}/chat/sessions/${sessionId}/tag`, { tagId });
        const tag = projectTags.find((t) => t.id === tagId);
        if (tag) setSessionTagMap((prev) => ({ ...prev, [sessionId]: { id: tag.id, name: tag.name, color: tag.color } }));
      } else {
        await api.del(`${projectUrl(activeProject.name)}/chat/sessions/${sessionId}/tag`);
        setSessionTagMap((prev) => { const n = { ...prev }; delete n[sessionId]; return n; });
      }
      loadTags();
    } catch { /* silent */ }
  }, [activeProject?.name, projectTags, loadTags]);

  const notifications = useNotificationStore((s) => s.notifications);
  const streamingSessions = useStreamingStore((s) => s.sessions);
  const { canScrollLeft, canScrollRight, scrollLeft: doScrollLeft, scrollRight: doScrollRight } =
    useTabOverflow(scrollRef);

  // Hidden unread direction — recomputed when notifications or scroll changes
  const hiddenUnread = getHiddenUnreadDirection(scrollRef.current, tabRefs.current as Map<string, HTMLElement>, tabs, notifications);

  // Auto-scroll to new tab
  useEffect(() => {
    if (tabs.length > prevTabCount.current && activeTabId) {
      const el = tabRefs.current.get(activeTabId);
      if (el) el.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "nearest" });
    }
    prevTabCount.current = tabs.length;
  }, [tabs.length, activeTabId]);

  /** Rename a chat session tab — calls PATCH API + updates tab store */
  const handleRenameTab = useCallback((tab: Tab, newTitle: string) => {
    useTabStore.getState().updateTab(tab.id, { title: newTitle });
    const pName = tab.metadata?.projectName as string | undefined;
    const sId = tab.metadata?.sessionId as string | undefined;
    if (pName && sId) {
      api.patch(`${projectUrl(pName)}/chat/sessions/${sId}`, { title: newTitle }).catch(() => {});
    }
  }, []);

  // Compare selection — re-renders menu when selection changes
  const compareSelection = useCompareStore((s) => s.selection);

  // File action dialog state for tab context menu (rename/delete)
  const [fileActionState, setFileActionState] = useState<{ action: string; node: FileNode; tabId: string } | null>(null);

  /**
   * Build "Select for Compare" + "Compare with Selected" menu items for a tab.
   * Returns null for non-file tabs so menu stays clean.
   */
  function compareMenuItems(tab: Tab): React.ReactNode {
    if (tab.type !== "editor") return null;
    const filePath = tab.metadata?.filePath as string | undefined;
    const projectName = tab.metadata?.projectName as string | undefined;
    if (!filePath || !projectName) return null;

    // Only show "Compare with Selected" when same project (cross-project
    // selection is auto-cleared on project switch, but guard covers the
    // brief window before the subscription fires).
    const hasDifferentSelection =
      compareSelection != null &&
      compareSelection.projectName === projectName &&
      compareSelection.filePath !== filePath;

    return (
      <>
        <ContextMenuItem
          onClick={() => {
            const unsaved = tab.metadata?.unsavedContent as string | undefined;
            useCompareStore.getState().setSelection({
              filePath,
              projectName,
              dirtyContent: unsaved,
              label: basename(filePath),
            });
          }}
        >
          <Columns2 className="size-3.5 mr-2" />
          Select for Compare
        </ContextMenuItem>
        {hasDifferentSelection && (
          <ContextMenuItem
            onClick={async () => {
              const sel = useCompareStore.getState().selection;
              if (!sel) return;
              const unsaved = tab.metadata?.unsavedContent as string | undefined;
              try {
                await openCompareTab(
                  { path: sel.filePath, dirtyContent: sel.dirtyContent },
                  { path: filePath, dirtyContent: unsaved },
                  projectName,
                );
                useCompareStore.getState().clearSelection();
              } catch (err) {
                const msg = err instanceof Error ? err.message : "Compare failed";
                toast.error(msg);
              }
            }}
          >
            <Columns2 className="size-3.5 mr-2" />
            Compare with Selected ({compareSelection!.label})
          </ContextMenuItem>
        )}
        <ContextMenuSeparator />
      </>
    );
  }

  /** Handle context menu actions on a tab */
  const handleTabContextAction = useCallback((tab: Tab, action: string) => {
    const panelState = usePanelStore.getState();
    const pTabs = panelState.panels[effectivePanelId]?.tabs ?? [];

    switch (action) {
      case "close":
        panelState.closeTab(tab.id, effectivePanelId);
        break;
      case "close-others":
        for (const t of pTabs) {
          if (t.id !== tab.id && t.closable) panelState.closeTab(t.id, effectivePanelId);
        }
        break;
      case "close-right": {
        const idx = pTabs.findIndex((t) => t.id === tab.id);
        for (let i = idx + 1; i < pTabs.length; i++) {
          if (pTabs[i]!.closable) panelState.closeTab(pTabs[i]!.id, effectivePanelId);
        }
        break;
      }
      case "copy-path": {
        const filePath = tab.metadata?.filePath as string | undefined;
        if (filePath) navigator.clipboard.writeText(filePath).catch(() => {});
        break;
      }
      case "download": {
        const filePath = tab.metadata?.filePath as string | undefined;
        const projectName = tab.metadata?.projectName as string | undefined;
        if (filePath && projectName) downloadFile(projectName, filePath);
        break;
      }
      case "rename":
      case "delete": {
        const filePath = tab.metadata?.filePath as string | undefined;
        if (filePath) {
          setFileActionState({
            action,
            tabId: tab.id,
            node: { name: tab.title, path: filePath, type: "file" },
          });
        }
        break;
      }
    }
  }, [effectivePanelId]);

  /** Double-click on empty bar area → open command palette */
  function handleBarDoubleClick(e: React.MouseEvent) {
    // Only trigger if clicking directly on the bar or scroll container (not on a tab)
    const target = e.target as HTMLElement;
    if (target.closest("[data-tab-item]")) return;
    openCommandPalette();
  }

  /** Right-click on empty bar area → open command palette */
  function handleBarContextMenu(e: React.MouseEvent) {
    const target = e.target as HTMLElement;
    if (target.closest("[data-tab-item]")) return;
    e.preventDefault();
    openCommandPalette();
  }

  return (
    <>
    <div
      className="hidden md:flex items-center h-10 border-b border-border bg-background relative"
      onDragOver={handleDragOverBar}
      onDrop={handleDrop}
      onDoubleClick={handleBarDoubleClick}
      onContextMenu={handleBarContextMenu}
    >
      {/* Left scroll arrow */}
      {canScrollLeft && (
        <button
          onClick={doScrollLeft}
          className="absolute left-0 z-10 flex items-center justify-center size-8 bg-gradient-to-r from-background via-background to-transparent"
        >
          <span className="relative">
            <ChevronLeft className="size-4 text-text-secondary" />
            {hiddenUnread.left && (
              <span className={cn("absolute -top-1 -right-0.5 size-2 rounded-full", notificationColor(hiddenUnread.left))} />
            )}
          </span>
        </button>
      )}

      {/* Scrollable tabs + sticky + button */}
      <div
        ref={scrollRef}
        className="flex-1 overflow-x-auto overflow-y-hidden min-w-0 scrollbar-none"
      >
        <div className="flex items-center h-10">
          {tabs.map((tab, i) => {
            const sessionId = tab.type === "chat" ? (tab.metadata?.sessionId as string) : undefined;
            const entry = sessionId ? notifications.get(sessionId) : undefined;
            const notiType = entry && entry.count > 0 ? entry.type : null;
            const isTabStreaming = sessionId ? streamingSessions.has(sessionId) : false;
            return (
            <DraggableTab
              key={tab.id}
              tab={tab}
              isActive={tab.id === activeTabId}
              icon={TAB_ICONS[tab.type] || Puzzle}
              showDropBefore={dropIndex === i}
              notificationType={notiType}
              isStreaming={isTabStreaming}
              onSelect={() => {
                if (wasTouchDragRecent()) return;
                usePanelStore.getState().setActiveTab(tab.id, effectivePanelId);
                if (sessionId) useNotificationStore.getState().clearForSession(sessionId);
              }}
              onClose={() => usePanelStore.getState().closeTab(tab.id, effectivePanelId)}
              onDragStart={(e) => handleDragStart(e, tab.id)}
              onDragOver={(e) => handleDragOver(e, tab.id, i)}
              onDragEnd={handleDragEnd}
              onTouchStart={(e) => handleTouchStart(e, tab.id, tab.title)}
              onTouchMove={handleTouchMove}
              onTouchEnd={handleTouchEnd}
              tabRef={(el) => {
                if (el) tabRefs.current.set(tab.id, el);
                else tabRefs.current.delete(tab.id);
              }}
              onRename={tab.type === "chat" ? (title) => handleRenameTab(tab, title) : undefined}
              onContextAction={(action) => handleTabContextAction(tab, action)}
              tagColor={sessionId ? sessionTagMap[sessionId]?.color : undefined}
              extraMenuContent={
                <>
                  {compareMenuItems(tab)}
                  {sessionId && projectTags.length > 0 && (
                    <>
                      <ContextMenuSub>
                        <ContextMenuSubTrigger>
                          <Tag className="size-3.5 mr-2" />
                          Set Tag
                        </ContextMenuSubTrigger>
                        <ContextMenuSubContent>
                          {projectTags.map((pt) => (
                            <ContextMenuItem key={pt.id} onClick={() => assignTagToSession(sessionId, pt.id)}>
                              <span className="size-2.5 rounded-full mr-2 shrink-0" style={{ backgroundColor: pt.color }} />
                              {pt.name}
                              {sessionTagMap[sessionId]?.id === pt.id && <Check className="size-3 ml-auto" />}
                            </ContextMenuItem>
                          ))}
                          {sessionTagMap[sessionId] && (
                            <>
                              <ContextMenuSeparator />
                              <ContextMenuItem onClick={() => assignTagToSession(sessionId, null)}>
                                Remove tag
                              </ContextMenuItem>
                            </>
                          )}
                        </ContextMenuSubContent>
                      </ContextMenuSub>
                      <ContextMenuSeparator />
                    </>
                  )}
                </>
              }
            />
            );
          })}
          {/* Show drop indicator at the end */}
          {dropIndex !== null && dropIndex >= tabs.length && (
            <div className="w-0.5 h-6 bg-primary rounded-full" />
          )}

          {/* + button — inside flow, sticky when overflowing */}
          <button
            onClick={() => openCommandPalette()}
            title="Open command palette (Shift+Shift)"
            className="flex items-center justify-center size-10 shrink-0 sticky right-0 border-b-2 border-transparent text-text-secondary hover:text-foreground transition-colors bg-background"
          >
            <Plus className="size-4" />
          </button>
        </div>
      </div>

      {/* Right scroll arrow */}
      {canScrollRight && (
        <button
          onClick={doScrollRight}
          className="absolute right-10 z-10 flex items-center justify-center size-8 bg-gradient-to-l from-background via-background to-transparent"
        >
          <span className="relative">
            <ChevronRight className="size-4 text-text-secondary" />
            {hiddenUnread.right && (
              <span className={cn("absolute -top-1 -left-0.5 size-2 rounded-full", notificationColor(hiddenUnread.right))} />
            )}
          </span>
        </button>
      )}
    </div>

    {fileActionState && (
      <FileActions
        action={fileActionState.action}
        node={fileActionState.node}
        projectName={activeProject?.name ?? ""}
        onClose={() => setFileActionState(null)}
        onRefresh={() => {
          if (activeProject) useFileStore.getState().fetchTree(activeProject.name);
          // Close tab after file deletion (onRefresh only called on success)
          if (fileActionState.action === "delete") {
            usePanelStore.getState().closeTab(fileActionState.tabId, effectivePanelId);
          }
        }}
      />
    )}
    </>
  );
});

