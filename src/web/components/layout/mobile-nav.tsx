import {
  FolderOpen,
  Terminal,
  MessageSquare,
  GitBranch,
  GitCommitHorizontal,
  FileDiff,
  FileCode,
  Settings,
  Plus,
  X,
} from "lucide-react";
import { useTabStore, type TabType } from "@/stores/tab-store";
import { useProjectStore } from "@/stores/project-store";
import { cn } from "@/lib/utils";
import { useState } from "react";

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
  { type: "terminal", label: "Terminal" },
  { type: "chat", label: "AI Chat" },
  { type: "git-status", label: "Git Status" },
  { type: "git-graph", label: "Git Graph" },
  { type: "settings", label: "Settings" },
];

/**
 * Mobile bottom tab bar — scrollable like desktop, with "+" for new tabs.
 */
export function MobileNav() {
  const { tabs, activeTabId, setActiveTab, closeTab, openTab } = useTabStore();
  const activeProject = useProjectStore((s) => s.activeProject);
  const [showMenu, setShowMenu] = useState(false);

  function handleNewTab(type: TabType) {
    const needsProject =
      type === "git-graph" || type === "git-status" || type === "git-diff" || type === "terminal" || type === "chat";
    const metadata = needsProject
      ? { projectName: activeProject?.name }
      : undefined;
    const label = NEW_TAB_OPTIONS.find((o) => o.type === type)?.label ?? type;
    openTab({ type, title: label, metadata, closable: true });
    setShowMenu(false);
  }

  return (
    <nav className="fixed bottom-0 left-0 right-0 md:hidden bg-background border-t border-border z-40">
      {/* Scrollable tab bar */}
      <div className="flex items-center h-12 overflow-x-auto">
        {tabs.map((tab) => {
          const Icon = TAB_ICONS[tab.type];
          const isActive = tab.id === activeTabId;
          return (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={cn(
                "flex items-center gap-1 px-3 h-12 whitespace-nowrap text-xs shrink-0 border-t-2 transition-colors",
                isActive
                  ? "border-primary bg-surface text-primary"
                  : "border-transparent text-text-secondary",
              )}
            >
              <Icon className="size-4" />
              <span className="max-w-[80px] truncate">{tab.title}</span>
              {tab.closable && (
                <span
                  role="button"
                  tabIndex={0}
                  onClick={(e) => {
                    e.stopPropagation();
                    closeTab(tab.id);
                  }}
                  className="ml-0.5 p-0.5 rounded hover:bg-surface-elevated"
                >
                  <X className="size-3" />
                </span>
              )}
            </button>
          );
        })}

        {/* + button */}
        <button
          onClick={() => setShowMenu(!showMenu)}
          className="flex items-center justify-center size-12 shrink-0 text-text-secondary"
        >
          <Plus className="size-5" />
        </button>
      </div>

      {/* New tab popup menu */}
      {showMenu && (
        <div className="absolute bottom-12 right-2 bg-surface border border-border rounded-lg shadow-lg py-1 z-50">
          {NEW_TAB_OPTIONS.map((opt) => {
            const Icon = TAB_ICONS[opt.type];
            return (
              <button
                key={opt.type}
                onClick={() => handleNewTab(opt.type)}
                className="flex items-center gap-2 w-full px-4 py-2.5 text-sm text-text-primary hover:bg-surface-elevated transition-colors min-h-[44px]"
              >
                <Icon className="size-4" />
                {opt.label}
              </button>
            );
          })}
        </div>
      )}
    </nav>
  );
}
