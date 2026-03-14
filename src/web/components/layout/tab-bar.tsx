import { useRef } from "react";
import {
  FolderOpen,
  Terminal,
  MessageSquare,
  GitBranch,
  GitCommitHorizontal,
  FileDiff,
  Settings,
  X,
  Plus,
} from "lucide-react";
import { useTabStore, type TabType } from "../../stores/tab.store";
import { useProjectStore } from "../../stores/project.store";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip";

const TAB_ICONS: Record<TabType, React.ComponentType<{ className?: string }>> =
  {
    projects: FolderOpen,
    terminal: Terminal,
    chat: MessageSquare,
    editor: FolderOpen,
    "git-graph": GitBranch,
    "git-status": GitCommitHorizontal,
    "git-diff": FileDiff,
    settings: Settings,
  };

const NEW_TAB_OPTIONS: { type: TabType; label: string }[] = [
  { type: "terminal", label: "Terminal" },
  { type: "chat", label: "Chat" },
  { type: "git-graph", label: "Git Graph" },
  { type: "git-status", label: "Git Status" },
  { type: "git-diff", label: "Git Diff" },
  { type: "settings", label: "Settings" },
];

export function TabBar() {
  const { tabs, activeTabId, setActiveTab, closeTab, openTab } = useTabStore();
  const { activeProject } = useProjectStore();
  const scrollRef = useRef<HTMLDivElement>(null);

  return (
    <div className="hidden md:flex h-9 items-center border-b border-border bg-background shrink-0">
      <div className="flex-1 overflow-x-auto overflow-y-hidden scrollbar-none">
        <div ref={scrollRef} className="flex items-center h-9 gap-0 min-w-max">
          {tabs.map((tab) => {
            const Icon = TAB_ICONS[tab.type];
            const isActive = tab.id === activeTabId;
            return (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={cn(
                  "group flex items-center gap-1.5 px-3 h-9 text-xs border-r border-border whitespace-nowrap transition-colors",
                  isActive
                    ? "bg-background text-foreground border-b-2 border-b-primary"
                    : "bg-muted/40 text-muted-foreground hover:bg-muted hover:text-foreground",
                )}
              >
                <Icon className="size-3.5 shrink-0" />
                <span className="max-w-32 truncate">{tab.title}</span>
                {tab.closable && (
                  <span
                    role="button"
                    tabIndex={0}
                    aria-label={`Close ${tab.title}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      closeTab(tab.id);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.stopPropagation();
                        closeTab(tab.id);
                      }
                    }}
                    className="ml-0.5 opacity-0 group-hover:opacity-100 rounded-sm hover:bg-destructive/20 p-0.5 transition-opacity"
                  >
                    <X className="size-3" />
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </div>

      <DropdownMenu>
        <Tooltip>
          <TooltipTrigger asChild>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="h-9 w-9 shrink-0 rounded-none border-l border-border"
              >
                <Plus className="size-4" />
              </Button>
            </DropdownMenuTrigger>
          </TooltipTrigger>
          <TooltipContent>New tab</TooltipContent>
        </Tooltip>
        <DropdownMenuContent align="end">
          {NEW_TAB_OPTIONS.map((opt) => {
            const Icon = TAB_ICONS[opt.type];
            return (
              <DropdownMenuItem
                key={opt.type}
                onClick={() => {
                  const gitTypes: TabType[] = ["git-graph", "git-status", "git-diff"];
                  const metadata = gitTypes.includes(opt.type) && activeProject
                    ? { projectPath: activeProject.name }
                    : undefined;
                  openTab({ type: opt.type, title: opt.label, closable: true, metadata });
                }}
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
