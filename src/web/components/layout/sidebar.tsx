import { useCallback, useRef, memo } from "react";
import { PanelLeftOpen } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { useProjectStore } from "@/stores/project-store";
import { useSettingsStore, type SidebarActiveTab } from "@/stores/settings-store";
import { FileTree } from "@/components/explorer/file-tree";
import { GitStatusPanel } from "@/components/git/git-status-panel";
import { SettingsTab } from "@/components/settings/settings-tab";
import { DatabaseSidebar } from "@/components/database/database-sidebar";
import { SearchPanel } from "@/components/explorer/search-panel";
import { ExtensionTreeView } from "@/components/extensions/extension-tree-view";
import { JiraPanel } from "@/components/jira/jira-panel";
import { useGitChangesPoller } from "@/stores/git-status-store";
import { ResourceStatusBar } from "@/components/system/resource-status-bar";
import { ProjectSwitcher } from "./project-switcher";
import { NavSectionRail } from "./nav-section-rail";

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
    // Unified rail starts at the viewport's left edge; width is the full aside.
    onResize(e.clientX);
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

function Wordmark({ version, onToggle }: { version: string | null; onToggle: () => void }) {
  return (
    <button
      onClick={onToggle}
      title="Toggle sidebar (⌘B)"
      className="w-[52px] shrink-0 flex flex-col items-center justify-center gap-px border-r border-border hover:bg-surface-elevated transition-colors"
    >
      <span className="text-[11px] font-bold text-primary leading-none">PPM</span>
      {version && <span className="text-[8px] text-text-subtle leading-none">v{version}</span>}
    </button>
  );
}

export const Sidebar = memo(function Sidebar() {
  const { activeProject } = useProjectStore(useShallow((s) => ({ activeProject: s.activeProject })));
  const sidebarCollapsed = useSettingsStore((s) => s.sidebarCollapsed);
  const sidebarWidth = useSettingsStore((s) => s.sidebarWidth);
  const toggleSidebar = useSettingsStore((s) => s.toggleSidebar);
  const setSidebarWidth = useSettingsStore((s) => s.setSidebarWidth);
  const sidebarActiveTab = useSettingsStore((s) => s.sidebarActiveTab);
  const version = useSettingsStore((s) => s.version);
  useGitChangesPoller(activeProject?.name, sidebarActiveTab === "git");

  if (sidebarCollapsed) {
    return (
      <aside className="hidden md:flex flex-col w-[52px] min-w-[52px] bg-background border-r border-border">
        <button
          onClick={toggleSidebar}
          title="Expand sidebar (⌘B)"
          className="flex flex-col items-center justify-center gap-px h-[41px] border-b border-border text-primary hover:bg-surface-elevated transition-colors"
        >
          <PanelLeftOpen className="size-4 text-text-secondary" />
        </button>
        <NavSectionRail />
      </aside>
    );
  }

  return (
    <aside
      className="hidden md:flex flex-col bg-background border-r border-border overflow-hidden relative"
      style={{ width: sidebarWidth, minWidth: 200, maxWidth: 600 }}
    >
      {/* Top bar: wordmark + project switcher */}
      <div className="flex h-[41px] border-b border-border shrink-0">
        <Wordmark version={version} onToggle={toggleSidebar} />
        <div className="flex-1 min-w-0 flex items-center px-1.5">
          <ProjectSwitcher />
        </div>
      </div>

      {/* Row: section rail + section panel */}
      <div className="flex-1 min-h-0 flex">
        <NavSectionRail />

        <div className="flex-1 min-w-0 flex flex-col">
          {/* Panel content */}
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
            {sidebarActiveTab === "search" && <SearchPanel />}
            {sidebarActiveTab === "database" && <DatabaseSidebar />}
            {sidebarActiveTab === "jira" && <JiraPanel />}
            {sidebarActiveTab === "settings" && <SettingsTab />}
            {typeof sidebarActiveTab === "string" && sidebarActiveTab.startsWith("ext:") && (
              <ExtensionTreeView viewId={sidebarActiveTab.slice(4)} className="h-full" />
            )}
          </div>

          {/* Resource monitor status bar */}
          <div className="shrink-0 border-t border-border">
            <ResourceStatusBar />
          </div>
        </div>
      </div>

      {/* Resize handle */}
      <ResizeHandle onResize={setSidebarWidth} />
    </aside>
  );
});
