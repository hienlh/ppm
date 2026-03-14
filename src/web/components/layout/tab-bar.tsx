import {
  X,
  Plus,
  FolderOpen,
  Terminal,
  MessageSquare,
  GitBranch,
  GitCommitHorizontal,
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
import { useProjectStore } from "@/stores/project-store";
import { cn } from "@/lib/utils";

const TAB_ICONS: Record<TabType, React.ElementType> = {
  projects: FolderOpen,
  terminal: Terminal,
  chat: MessageSquare,
  editor: FileCode,
  "git-graph": GitBranch,
  "git-status": GitCommitHorizontal,
  "git-diff": FileDiff,
  settings: Settings,
};

const NEW_TAB_OPTIONS: { type: TabType; label: string }[] = [
  { type: "projects", label: "Projects" },
  { type: "terminal", label: "Terminal" },
  { type: "chat", label: "AI Chat" },
  { type: "git-graph", label: "Git Graph" },
  { type: "git-status", label: "Git Status" },
  { type: "settings", label: "Settings" },
];

export function TabBar() {
  const { tabs, activeTabId, setActiveTab, closeTab, openTab } = useTabStore();
  const activeProject = useProjectStore((s) => s.activeProject);

  function handleNewTab(type: TabType) {
    const needsProject =
      type === "git-graph" || type === "git-status" || type === "git-diff" || type === "terminal" || type === "chat";
    const metadata = needsProject
      ? { projectName: activeProject?.name }
      : undefined;

    openTab({
      type,
      title: NEW_TAB_OPTIONS.find((o) => o.type === type)?.label ?? type,
      metadata,
      projectId: activeProject?.name ?? null,
      closable: true,
    });
  }

  return (
    <div className="hidden md:flex items-center border-b border-border bg-background">
      <ScrollArea className="flex-1">
        <div className="flex items-center gap-0.5 px-2 py-1">
          {tabs.map((tab) => {
            const Icon = TAB_ICONS[tab.type];
            const isActive = tab.id === activeTabId;
            return (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={cn(
                  "group flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-md whitespace-nowrap transition-colors",
                  "border-b-2 -mb-[1px]",
                  isActive
                    ? "border-primary bg-surface text-foreground"
                    : "border-transparent text-text-secondary hover:text-foreground hover:bg-surface-elevated",
                )}
              >
                <Icon className="size-4" />
                <span className="max-w-[120px] truncate">{tab.title}</span>
                {tab.closable && (
                  <span
                    role="button"
                    tabIndex={0}
                    onClick={(e) => {
                      e.stopPropagation();
                      closeTab(tab.id);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.stopPropagation();
                        closeTab(tab.id);
                      }
                    }}
                    className="ml-1 opacity-0 group-hover:opacity-100 rounded-sm hover:bg-surface-elevated p-0.5 transition-opacity"
                  >
                    <X className="size-3" />
                  </span>
                )}
              </button>
            );
          })}
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
              <DropdownMenuItem
                key={opt.type}
                onClick={() => handleNewTab(opt.type)}
              >
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
