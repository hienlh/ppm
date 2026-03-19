import { useEffect, useRef, useCallback } from "react";
import {
  Plus,
  Terminal,
  MessageSquare,
  GitBranch,
  FileDiff,
  Settings,
  FileCode,
  Database,
} from "lucide-react";
import { useTabStore, type TabType } from "@/stores/tab-store";
import { usePanelStore } from "@/stores/panel-store";
import { useProjectStore } from "@/stores/project-store";
import { useTabDrag } from "@/hooks/use-tab-drag";
import { openCommandPalette } from "@/hooks/use-global-keybindings";
import { api, projectUrl } from "@/lib/api-client";
import { DraggableTab } from "./draggable-tab";
import type { Tab } from "@/stores/tab-store";

const TAB_ICONS: Record<TabType, React.ElementType> = {
  terminal: Terminal,
  chat: MessageSquare,
  editor: FileCode,
  sqlite: Database,
  postgres: Database,
  "git-graph": GitBranch,
  "git-diff": FileDiff,
  settings: Settings,
};

interface TabBarProps {
  panelId?: string;
}

export function TabBar({ panelId }: TabBarProps) {
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
    <div
      className="hidden md:flex items-center h-10 border-b border-border bg-background"
      onDragOver={handleDragOverBar}
      onDrop={handleDrop}
      onDoubleClick={handleBarDoubleClick}
      onContextMenu={handleBarContextMenu}
    >
      {/* Scrollable tabs + sticky + button */}
      <div
        ref={scrollRef}
        className="flex-1 overflow-x-auto overflow-y-hidden min-w-0 scrollbar-none"
      >
        <div className="flex items-center h-10">
          {tabs.map((tab, i) => (
            <DraggableTab
              key={tab.id}
              tab={tab}
              isActive={tab.id === activeTabId}
              icon={TAB_ICONS[tab.type]}
              showDropBefore={dropIndex === i}
              onSelect={() => usePanelStore.getState().setActiveTab(tab.id, effectivePanelId)}
              onClose={() => usePanelStore.getState().closeTab(tab.id, effectivePanelId)}
              onDragStart={(e) => handleDragStart(e, tab.id)}
              onDragOver={(e) => handleDragOver(e, tab.id, i)}
              onDragEnd={handleDragEnd}
              tabRef={(el) => {
                if (el) tabRefs.current.set(tab.id, el);
                else tabRefs.current.delete(tab.id);
              }}
              onRename={tab.type === "chat" ? (title) => handleRenameTab(tab, title) : undefined}
            />
          ))}
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
    </div>
  );
}
