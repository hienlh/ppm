import { useCallback, useRef } from "react";
import { PanelLeftClose, PanelLeftOpen, FolderOpen, GitBranch, Settings } from "lucide-react";
import { useProjectStore } from "@/stores/project-store";
import { useSettingsStore, type SidebarActiveTab } from "@/stores/settings-store";
import { FileTree } from "@/components/explorer/file-tree";
import { GitStatusPanel } from "@/components/git/git-status-panel";
import { SettingsTab } from "@/components/settings/settings-tab";
import { cn } from "@/lib/utils";

const TABS: { id: SidebarActiveTab; label: string; icon: React.ElementType }[] = [
  { id: "explorer", label: "Explorer", icon: FolderOpen },
  { id: "git", label: "Git", icon: GitBranch },
  { id: "settings", label: "Settings", icon: Settings },
];

function ResizeHandle({ onResize }: { onResize: (width: number) => void }) {
  const dragging = useRef(false);

  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    dragging.current = true;
    const target = e.currentTarget as HTMLElement;
    target.setPointerCapture(e.pointerId);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  }, []);

  const handlePointerMove = useCallback((e: React.PointerEvent) => {
    if (!dragging.current) return;
    // Sidebar starts after the project bar (48px wide)
    const projectBarWidth = 48;
    const newWidth = e.clientX - projectBarWidth;
    onResize(newWidth);
  }, [onResize]);

  const handlePointerUp = useCallback((e: React.PointerEvent) => {
    dragging.current = false;
    const target = e.currentTarget as HTMLElement;
    target.releasePointerCapture(e.pointerId);
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
  }, []);

  return (
    <div
      className="absolute right-0 top-0 bottom-0 w-1 cursor-col-resize hover:bg-primary/30 active:bg-primary/50 transition-colors z-10"
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
    />
  );
}

export function Sidebar() {
  const { activeProject } = useProjectStore();
  const sidebarCollapsed = useSettingsStore((s) => s.sidebarCollapsed);
  const sidebarWidth = useSettingsStore((s) => s.sidebarWidth);
  const toggleSidebar = useSettingsStore((s) => s.toggleSidebar);
  const setSidebarWidth = useSettingsStore((s) => s.setSidebarWidth);
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
    <aside
      className="hidden md:flex flex-col bg-background border-r border-border overflow-hidden relative"
      style={{ width: sidebarWidth, minWidth: 200, maxWidth: 600 }}
    >
      {/* Tab bar */}
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
              {sidebarWidth >= 240 && <span>{tab.label}</span>}
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
        {sidebarActiveTab === "settings" && (
          <SettingsTab />
        )}
      </div>

      {/* Resize handle */}
      <ResizeHandle onResize={setSidebarWidth} />
    </aside>
  );
}
