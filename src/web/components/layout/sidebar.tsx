import { PanelLeftClose, PanelLeftOpen, FolderOpen, GitBranch, MessageSquare } from "lucide-react";
import { useProjectStore } from "@/stores/project-store";
import { useSettingsStore, type SidebarActiveTab } from "@/stores/settings-store";
import { FileTree } from "@/components/explorer/file-tree";
import { GitStatusPanel } from "@/components/git/git-status-panel";
import { ChatHistoryPanel } from "@/components/chat/chat-history-panel";
import { cn } from "@/lib/utils";

const TABS: { id: SidebarActiveTab; label: string; icon: React.ElementType }[] = [
  { id: "explorer", label: "Explorer", icon: FolderOpen },
  { id: "git", label: "Git", icon: GitBranch },
  { id: "history", label: "History", icon: MessageSquare },
];

export function Sidebar() {
  const { activeProject } = useProjectStore();
  const sidebarCollapsed = useSettingsStore((s) => s.sidebarCollapsed);
  const toggleSidebar = useSettingsStore((s) => s.toggleSidebar);
  const sidebarActiveTab = useSettingsStore((s) => s.sidebarActiveTab);
  const setSidebarActiveTab = useSettingsStore((s) => s.setSidebarActiveTab);

  if (sidebarCollapsed) {
    return (
      <aside className="hidden md:flex flex-col w-10 min-w-10 bg-background border-r border-border">
        <button
          onClick={toggleSidebar}
          title="Expand sidebar (⌘B)"
          className="flex items-center justify-center h-[41px] border-b border-border text-text-secondary hover:text-foreground transition-colors"
        >
          <PanelLeftOpen className="size-4" />
        </button>
      </aside>
    );
  }

  return (
    <aside className="hidden md:flex flex-col w-[280px] min-w-[280px] bg-background border-r border-border overflow-hidden">
      {/* Tab bar (replaces old header) */}
      <div className="flex items-center h-[41px] border-b border-border shrink-0">
        {TABS.map((tab) => {
          const Icon = tab.icon;
          const isActive = sidebarActiveTab === tab.id;
          return (
            <button
              key={tab.id}
              onClick={() => setSidebarActiveTab(tab.id)}
              className={cn(
                "flex-1 flex items-center justify-center gap-1.5 h-full text-xs transition-colors border-b-2 -mb-px",
                isActive
                  ? "border-primary text-primary font-medium"
                  : "border-transparent text-text-secondary hover:text-foreground",
              )}
            >
              <Icon className="size-3.5" />
              <span>{tab.label}</span>
            </button>
          );
        })}
        <button
          onClick={toggleSidebar}
          title="Collapse sidebar (⌘B)"
          className="flex items-center justify-center w-8 h-full text-text-subtle hover:text-text-secondary transition-colors shrink-0"
        >
          <PanelLeftClose className="size-3.5" />
        </button>
      </div>

      {/* Tab content */}
      <div className="flex-1 overflow-y-auto min-h-0">
        {sidebarActiveTab === "explorer" && (
          activeProject ? (
            <FileTree />
          ) : (
            <div className="flex items-center justify-center h-24 p-4">
              <p className="text-xs text-text-subtle text-center">Select a project to browse files</p>
            </div>
          )
        )}
        {sidebarActiveTab === "git" && (
          <GitStatusPanel metadata={{ projectName: activeProject?.name }} />
        )}
        {sidebarActiveTab === "history" && (
          <ChatHistoryPanel projectName={activeProject?.name} />
        )}
      </div>

    </aside>
  );
}
