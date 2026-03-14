import {
  FolderOpen,
  Terminal,
  MessageSquare,
  GitBranch,
  Plus,
} from "lucide-react";
import { useTabStore, type TabType } from "../../stores/tab.store";
import { useProjectStore } from "../../stores/project.store";
import { cn } from "../../lib/utils";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";

interface NavItem {
  type: TabType;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
}

const NAV_ITEMS: NavItem[] = [
  { type: "projects", label: "Projects", icon: FolderOpen },
  { type: "terminal", label: "Terminal", icon: Terminal },
  { type: "chat", label: "Chat", icon: MessageSquare },
  { type: "git-graph", label: "Git", icon: GitBranch },
];

const MORE_ITEMS: { type: TabType; label: string }[] = [
  { type: "git-status", label: "Git Status" },
  { type: "git-diff", label: "Git Diff" },
  { type: "settings", label: "Settings" },
];

export function MobileNav() {
  const { tabs, activeTabId, openTab } = useTabStore();
  const { activeProject } = useProjectStore();

  const activeTab = tabs.find((t) => t.id === activeTabId);

  const isActive = (type: TabType) => activeTab?.type === type;

  const gitTypes = new Set<TabType>(["git-graph", "git-status", "git-diff"]);

  const handleNav = (type: TabType, label: string) => {
    const closable = type !== "projects";
    const metadata = gitTypes.has(type) && activeProject
      ? { projectPath: activeProject.name }
      : undefined;
    openTab({ type, title: label, closable, metadata });
  };

  return (
    <nav className="md:hidden fixed bottom-0 left-0 right-0 z-50 flex items-center justify-around h-14 bg-background border-t border-border safe-area-inset-bottom">
      {NAV_ITEMS.map(({ type, label, icon: Icon }) => (
        <button
          key={type}
          onClick={() => handleNav(type, label)}
          className={cn(
            "flex flex-col items-center justify-center gap-0.5 flex-1 h-full text-xs transition-colors",
            isActive(type)
              ? "text-primary"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          <Icon className="size-5" />
          <span className="text-[10px]">{label}</span>
        </button>
      ))}

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            className={cn(
              "flex flex-col items-center justify-center gap-0.5 flex-1 h-full text-xs transition-colors",
              "text-muted-foreground hover:text-foreground",
            )}
          >
            <Plus className="size-5" />
            <span className="text-[10px]">More</span>
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" side="top">
          {MORE_ITEMS.map((item) => (
            <DropdownMenuItem
              key={item.type}
              onClick={() => handleNav(item.type, item.label)}
            >
              {item.label}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </nav>
  );
}
