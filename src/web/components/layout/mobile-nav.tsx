import { useState, useEffect, useCallback, useMemo } from "react";
import {
  Terminal, Menu, X, ArrowLeft, ArrowRight, SplitSquareVertical, MoveVertical, Layers, Plus,
  Copy, Download, Pencil, Trash2, Columns2, Circle, Tag, Check, XSquare, ChevronsRight, ChevronUp,
} from "lucide-react";
import { usePanelStore } from "@/stores/panel-store";
import { useShallow } from "zustand/react/shallow";
import { useProjectStore, resolveOrder } from "@/stores/project-store";
import { useFileStore, type FileNode } from "@/stores/file-store";
import { useCompareStore } from "@/stores/compare-store";
import { openCompareTab } from "@/lib/open-compare-tab";
import { useProjectTags } from "@/components/chat/tag-filter-chips";
import { findPanelPosition, MAX_ROWS } from "@/stores/panel-utils";
import { resolveProjectColor } from "@/lib/project-palette";
import { ProjectAvatar } from "@/components/layout/project-avatar";
import type { Tab } from "@/stores/tab-store";
import { cn, basename } from "@/lib/utils";
import { toast } from "sonner";
import { openCommandPalette } from "@/hooks/use-global-keybindings";
import { useNotificationStore } from "@/stores/notification-store";
import { downloadFile } from "@/lib/file-download";
import { FileActions } from "@/components/explorer/file-actions";
import { api, projectUrl } from "@/lib/api-client";
import { BottomSheet } from "@/components/ui/mobile-bottom-sheet";
import { useIsMobile } from "@/hooks/use-is-mobile";
import { DockPanel } from "@/components/layout/dock-panel";
import { MobileTabSwitcherSheet } from "@/components/layout/mobile-tab-switcher-sheet";
import { getTabTypeIcon } from "@/lib/tab-type-icons";
import { countDockTabs } from "@/components/layout/dock-tabs";
import { DOCK_PANEL_ID } from "@/stores/panel-utils";

interface MobileNavProps { onMenuPress: () => void; onProjectsPress: () => void; }

export function MobileNav({ onMenuPress, onProjectsPress }: MobileNavProps) {
  const focusedPanelId = usePanelStore((s) => s.focusedPanelId);
  const panels = usePanelStore((s) => s.panels);
  const grid = usePanelStore((s) => s.grid);

  // Dock visibility — drives the toggle button active state and the bottom sheet.
  const dock = usePanelStore((s) => s.dock);
  const dockExpanded = usePanelStore((s) => s.dockExpanded);
  const isMobile = useIsMobile();

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

  // The current-tab button mirrors the main content, which renders the focused
  // GRID panel (falling back to the first grid panel when focus is elsewhere —
  // e.g. on the dock). Reading focusedPanelId directly would pick up the dock's
  // terminal, which isn't in the merged grid `tabs`, leaving activeTab null and
  // showing "New Tab" while a grid tab is actually on screen.
  const gridPanelIds = grid.flat();
  const activeGridPanelId = gridPanelIds.includes(focusedPanelId) ? focusedPanelId : gridPanelIds[0];
  const activeTabId = (activeGridPanelId ? panels[activeGridPanelId]?.activeTabId : null) ?? null;
  const notifications = useNotificationStore((s) => s.notifications);
  const compareSelection = useCompareStore((s) => s.selection);
  const [sessionTagMap, setSessionTagMap] = useState<Record<string, { id: number; name: string; color: string }>>({});

  const [menuTabId, setMenuTabId] = useState<string | null>(null);
  const [tabSheetOpen, setTabSheetOpen] = useState(false);

  // Active tab (for the current-tab button) + running-terminal indicator.
  const activeTab = tabs.find((t) => t.id === activeTabId) ?? null;
  const dockPanel = panels[DOCK_PANEL_ID];
  const dockTabCount = countDockTabs(dockPanel, currentProject);

  // Context menu actions — use the tab's actual panel (not always focused)
  const menuTab = menuTabId ? tabs.find((t) => t.id === menuTabId) : null;
  const menuTabPanelId = menuTabId ? tabPanelMap[menuTabId] ?? focusedPanelId : focusedPanelId;
  const menuTabPanelTabs = panels[menuTabPanelId]?.tabs ?? [];
  const menuTabIdx = menuTabId ? menuTabPanelTabs.findIndex((t) => t.id === menuTabId) : -1;

  const pos = findPanelPosition(grid, menuTabPanelId);
  const canSplitDown = pos ? grid.length < MAX_ROWS : false;
  const otherPanelIds = grid.flat().filter((id) => id !== menuTabPanelId);

  // Chat-session context for the long-press menu (Mark as unread / Set Tag)
  const menuSessionId = menuTab?.type === "chat" ? (menuTab.metadata?.sessionId as string | undefined) : undefined;
  const menuNotiType = menuSessionId ? ((notifications.get(menuSessionId)?.count ?? 0) > 0) : false;
  // Editor "Compare with Selected" only when a different file in the same project is selected
  const menuFilePath = menuTab?.metadata?.filePath as string | undefined;
  const menuProjectName = menuTab?.metadata?.projectName as string | undefined;
  const menuHasDifferentSelection =
    compareSelection != null &&
    !!menuProjectName &&
    compareSelection.projectName === menuProjectName &&
    compareSelection.filePath !== menuFilePath;

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

  function closeOthers(tabId: string) {
    const pid = tabPanelMap[tabId] ?? focusedPanelId;
    const pTabs = usePanelStore.getState().panels[pid]?.tabs ?? [];
    for (const t of pTabs) { if (t.id !== tabId && t.closable) usePanelStore.getState().closeTab(t.id, pid); }
    setMenuTabId(null);
  }
  function closeRight(tabId: string) {
    const pid = tabPanelMap[tabId] ?? focusedPanelId;
    const pTabs = usePanelStore.getState().panels[pid]?.tabs ?? [];
    const idx = pTabs.findIndex((t) => t.id === tabId);
    for (let i = idx + 1; i < pTabs.length; i++) { if (pTabs[i]!.closable) usePanelStore.getState().closeTab(pTabs[i]!.id, pid); }
    setMenuTabId(null);
  }

  function selectForCompare(tab: Tab) {
    const filePath = tab.metadata?.filePath as string | undefined;
    const projectName = tab.metadata?.projectName as string | undefined;
    if (!filePath || !projectName) return;
    const unsaved = tab.metadata?.unsavedContent as string | undefined;
    useCompareStore.getState().setSelection({ filePath, projectName, dirtyContent: unsaved, label: basename(filePath) });
    setMenuTabId(null);
  }
  async function compareWithSelected(tab: Tab) {
    const filePath = tab.metadata?.filePath as string | undefined;
    const projectName = tab.metadata?.projectName as string | undefined;
    const sel = useCompareStore.getState().selection;
    if (!sel || !filePath || !projectName) return;
    const unsaved = tab.metadata?.unsavedContent as string | undefined;
    try {
      await openCompareTab(
        { path: sel.filePath, dirtyContent: sel.dirtyContent },
        { path: filePath, dirtyContent: unsaved },
        projectName,
      );
      useCompareStore.getState().clearSelection();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Compare failed");
    }
    setMenuTabId(null);
  }
  function markUnread(tab: Tab) {
    const sessionId = tab.metadata?.sessionId as string | undefined;
    const pn = tab.metadata?.projectName as string | undefined;
    if (sessionId && pn) useNotificationStore.getState().markUnread(sessionId, pn, tab.title);
    setMenuTabId(null);
  }

  const [fileActionState, setFileActionState] = useState<{ action: string; node: FileNode; tabId: string } | null>(null);

  function handleFileAction(tab: Tab, action: string) {
    const filePath = tab.metadata?.filePath as string | undefined;
    const projectName = tab.metadata?.projectName as string | undefined;
    switch (action) {
      case "copy-path":
        if (filePath) navigator.clipboard.writeText(filePath).catch(() => {});
        break;
      case "copy-full-path": {
        if (filePath) {
          const project = projectName ? useProjectStore.getState().projects.find((p) => p.name === projectName) : null;
          navigator.clipboard.writeText(project ? `${project.path}/${filePath}` : filePath).catch(() => {});
        }
        break;
      }
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

  // Active project avatar for the Projects button
  const { activeProject, projects, customOrder } = useProjectStore(useShallow((s) => ({ activeProject: s.activeProject, projects: s.projects, customOrder: s.customOrder })));

  const { projectTags, loadTags } = useProjectTags(activeProject?.name);
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
    setMenuTabId(null);
  }, [activeProject?.name, projectTags, loadTags]);

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

  const ActiveTabIcon = activeTab ? getTabTypeIcon(activeTab.type) : null;

  return (
    <nav className="fixed bottom-0 left-0 right-0 md:hidden bg-background border-t border-border z-40 select-none">
      <div className="flex items-center h-12">
        {/* Fixed cluster: Menu | Project | Terminal | + */}
        <div className="flex items-center shrink-0 border-r border-border">
          <button onClick={onMenuPress} className="flex items-center justify-center size-12 shrink-0 text-text-secondary">
            <Menu className="size-5" />
          </button>

          <div className="w-px self-stretch bg-border shrink-0" />

          <button
            onClick={onProjectsPress}
            className="flex items-center justify-center size-12 shrink-0 text-text-secondary"
            title="Switch project"
          >
            {activeProject ? (
              <ProjectAvatar name={activeProject.name} color={activeColor} image={activeProject.image} size={28} allNames={allNames} />
            ) : (
              <Layers className="size-5" />
            )}
          </button>

          <div className="w-px self-stretch bg-border shrink-0" />

          {/* Terminal / panel button — green dot = running dock sessions; active tint when dock open */}
          <button
            onClick={() => usePanelStore.getState().toggleDock()}
            title={dock.visible ? "Hide panel" : "Show panel"}
            aria-label={dock.visible ? "Hide panel" : "Show panel"}
            className={cn(
              "relative flex items-center justify-center size-12 shrink-0 transition-colors",
              dock.visible ? "text-primary bg-primary/10" : "text-text-secondary",
            )}
          >
            <Terminal className="size-5" />
            {dockTabCount > 0 && (
              <span
                aria-hidden
                className="absolute top-1.5 right-1.5 size-[7px] rounded-full ring-[1.5px] ring-background"
                style={{ backgroundColor: "var(--color-success)" }}
              />
            )}
          </button>

          <div className="w-px self-stretch bg-border shrink-0" />

          {/* New tab — opens the command palette */}
          <button
            onClick={() => openCommandPalette()}
            title="New tab"
            aria-label="New tab"
            className="flex items-center justify-center size-12 shrink-0 text-text-secondary"
          >
            <Plus className="size-5" />
          </button>
        </div>

        {/* Current tab button (flex-1) — opens the tab switcher sheet */}
        {activeTab && ActiveTabIcon ? (
          <button
            onClick={() => setTabSheetOpen(true)}
            className="flex-1 min-w-0 flex items-center gap-2 h-12 px-3 border-t-2 border-primary bg-surface"
          >
            <ActiveTabIcon className="size-4 text-primary shrink-0" />
            <span className="flex-1 min-w-0 truncate text-left text-xs font-medium text-primary">{activeTab.title}</span>
            <span className="px-1.5 h-[18px] inline-flex items-center rounded-md border border-border bg-surface-elevated text-[10px] font-mono text-text-secondary shrink-0">
              {tabs.length}
            </span>
            <ChevronUp className="size-3.5 text-text-subtle shrink-0" />
          </button>
        ) : (
          <button
            onClick={() => openCommandPalette()}
            className="flex-1 flex items-center gap-1.5 h-12 px-3 text-text-secondary text-xs"
          >
            <Plus className="size-4" /> New Tab
          </button>
        )}
      </div>

      {/* Tab switcher sheet — replaces the old scrolling strip */}
      <MobileTabSwitcherSheet
        open={tabSheetOpen}
        onClose={() => setTabSheetOpen(false)}
        onOpenPalette={() => openCommandPalette()}
        tabs={tabs}
        tabPanelMap={tabPanelMap}
        panelOrder={grid.flat()}
        activeTabId={activeTabId}
        projectColor={activeProject ? activeColor : null}
        onTabLongPress={(tabId) => setMenuTabId(tabId)}
      />

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
            <button onClick={() => handleFileAction(menuTab, "copy-full-path")}
              className="flex items-center gap-2 w-full px-3 py-2.5 text-sm text-foreground active:bg-surface-elevated">
              <Copy className="size-4" /> Copy Full Path
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
            <button onClick={() => selectForCompare(menuTab)}
              className="flex items-center gap-2 w-full px-3 py-2.5 text-sm text-foreground active:bg-surface-elevated">
              <Columns2 className="size-4" /> Select for Compare
            </button>
            {menuHasDifferentSelection && (
              <button onClick={() => compareWithSelected(menuTab)}
                className="flex items-center gap-2 w-full px-3 py-2.5 text-sm text-foreground active:bg-surface-elevated">
                <Columns2 className="size-4" /> Compare with Selected ({compareSelection!.label})
              </button>
            )}
            <div className="h-px bg-border mx-2" />
          </>
        )}
        {menuSessionId && !menuNotiType && (
          <button onClick={() => markUnread(menuTab!)}
            className="flex items-center gap-2 w-full px-3 py-2.5 text-sm text-foreground active:bg-surface-elevated">
            <Circle className="size-4 fill-primary text-primary" /> Mark as unread
          </button>
        )}
        {menuSessionId && projectTags.length > 0 && (
          <>
            <div className="px-3 pt-2 pb-1 text-xs text-text-secondary flex items-center gap-2">
              <Tag className="size-3.5" /> Set Tag
            </div>
            {projectTags.map((pt) => (
              <button key={pt.id} onClick={() => assignTagToSession(menuSessionId, pt.id)}
                className="flex items-center gap-2 w-full px-3 py-2.5 text-sm text-foreground active:bg-surface-elevated">
                <span className="size-2.5 rounded-full shrink-0" style={{ backgroundColor: pt.color }} />
                {pt.name}
                {sessionTagMap[menuSessionId]?.id === pt.id && <Check className="size-3.5 ml-auto" />}
              </button>
            ))}
            {sessionTagMap[menuSessionId] && (
              <button onClick={() => assignTagToSession(menuSessionId, null)}
                className="flex items-center gap-2 w-full px-3 py-2.5 text-sm text-foreground active:bg-surface-elevated">
                Remove tag
              </button>
            )}
            <div className="h-px bg-border mx-2" />
          </>
        )}
        {menuTab?.closable && (
          <button onClick={() => { usePanelStore.getState().closeTab(menuTabId!); setMenuTabId(null); }}
            className="flex items-center gap-2 w-full px-3 py-2.5 text-sm text-foreground active:bg-surface-elevated">
            <X className="size-4" /> Close
          </button>
        )}
        {menuTabPanelTabs.some((t) => t.id !== menuTabId && t.closable) && (
          <button onClick={() => closeOthers(menuTabId!)}
            className="flex items-center gap-2 w-full px-3 py-2.5 text-sm text-foreground active:bg-surface-elevated">
            <XSquare className="size-4" /> Close Others
          </button>
        )}
        {menuTabIdx >= 0 && menuTabIdx < menuTabPanelTabs.length - 1 && (
          <button onClick={() => closeRight(menuTabId!)}
            className="flex items-center gap-2 w-full px-3 py-2.5 text-sm text-foreground active:bg-surface-elevated">
            <ChevronsRight className="size-4" /> Close to the Right
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

      {/* Mobile dock sheet — only rendered on mobile viewports.
          Desktop panel-layout.tsx gates DockPanel on isDesktop, so exactly ONE
          __dock__ slot is ever registered at a time (no double-mount). */}
      {isMobile && (
        <BottomSheet
          open={dock.visible}
          onClose={() => usePanelStore.getState().setDockVisible(false)}
          // Higher z-index than the default nav z-40 so the sheet covers the tab bar
          zIndex={60}
          // Expand/collapse toggles 60% ↔ 92% (dockExpanded, session-only); animate height.
          className={cn("transition-[height] duration-200", dockExpanded ? "h-[92vh]" : "h-[60vh]")}
        >
          {/* Fixed height so xterm fitAddon.fit() receives a non-zero container.
              ResizeObserver in use-terminal.ts fires when this element gains dimensions,
              triggering a refit — no extra imperative call needed. */}
          <div className="flex flex-col h-full overflow-hidden">
            <DockPanel variant="mobile" />
          </div>
        </BottomSheet>
      )}
    </nav>
  );
}
