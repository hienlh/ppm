import { useEffect, useRef } from "react";
import {
  X,
  Plus,
  Terminal,
  MessageSquare,
  GitBranch,
  FileDiff,
  Settings,
  FileCode,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ScrollArea, ScrollBar } from "@/components/ui/scroll-area";
import { useTabStore, type TabType } from "@/stores/tab-store";
import { usePanelStore } from "@/stores/panel-store";
import { useProjectStore } from "@/stores/project-store";
import { useTabDrag } from "@/hooks/use-tab-drag";
import { DraggableTab } from "./draggable-tab";

const TAB_ICONS: Record<TabType, React.ElementType> = {
  terminal: Terminal,
  chat: MessageSquare,
  editor: FileCode,
  "git-graph": GitBranch,
  "git-diff": FileDiff,
  settings: Settings,
};

const NEW_TAB_OPTIONS: { type: TabType; label: string }[] = [
  { type: "terminal", label: "Terminal" },
  { type: "chat", label: "AI Chat" },
  { type: "git-graph", label: "Git Graph" },
  { type: "settings", label: "Settings" },
];

interface TabBarProps {
  panelId?: string;
}

export function TabBar({ panelId }: TabBarProps) {
  const activeProject = useProjectStore((s) => s.activeProject);
  const tabRefs = useRef<Map<string, HTMLButtonElement>>(new Map());
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

  function handleNewTab(type: TabType) {
    const needsProject = type === "git-graph" || type === "git-diff" || type === "terminal" || type === "chat";
    const metadata = needsProject ? { projectName: activeProject?.name } : undefined;

    usePanelStore.getState().openTab(
      {
        type,
        title: NEW_TAB_OPTIONS.find((o) => o.type === type)?.label ?? type,
        metadata,
        projectId: activeProject?.name ?? null,
        closable: true,
      },
      effectivePanelId,
    );
  }

  return (
    <div
      className="hidden md:flex items-center h-[41px] border-b border-border bg-background"
      onDragOver={handleDragOverBar}
      onDrop={handleDrop}
    >
      <ScrollArea className="flex-1">
        <div className="flex items-center gap-0.5 px-2 py-1">
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
            />
          ))}
          {/* Show drop indicator at the end */}
          {dropIndex !== null && dropIndex >= tabs.length && (
            <div className="w-0.5 h-6 bg-primary rounded-full" />
          )}
        </div>
        <ScrollBar orientation="horizontal" />
      </ScrollArea>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button className="flex items-center justify-center size-8 mx-1 rounded-md text-text-secondary hover:text-foreground hover:bg-surface-elevated transition-colors">
            <Plus className="size-4" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {NEW_TAB_OPTIONS.map((opt) => {
            const Icon = TAB_ICONS[opt.type];
            return (
              <DropdownMenuItem key={opt.type} onClick={() => handleNewTab(opt.type)}>
                <Icon className="size-4 mr-2" />
                {opt.label}
              </DropdownMenuItem>
            );
          })}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
