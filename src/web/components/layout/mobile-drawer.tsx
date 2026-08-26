import { useState, useCallback, useEffect, useMemo } from "react";
import { X, Bug as BugIcon, Cloud } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { useProjectStore } from "@/stores/project-store";
import { useSettingsStore, type SidebarActiveTab } from "@/stores/settings-store";
import { useExtensionStore } from "@/stores/extension-store";
import { FileTree } from "@/components/explorer/file-tree";
import { GitStatusPanel } from "@/components/git/git-status-panel";
import { SettingsTab } from "@/components/settings/settings-tab";
import { DatabaseSidebar } from "@/components/database/database-sidebar";
import { JiraPanel } from "@/components/jira/jira-panel";
import { AiResourcesPanel } from "@/components/ai-resources/ai-resources-panel";
import { TunnelManagerTab } from "@/components/tunnels/tunnel-manager-tab";
import { SessionHistoryList } from "@/components/chat/session-history-list";
import { GroupList } from "@/components/group-chat/group-list";
import { ExtensionTreeView } from "@/components/extensions/extension-tree-view";
import { getAvailableTabs } from "@/lib/sidebar-tabs/tab-registry";
import { resolveTabOrder } from "@/lib/sidebar-tabs/resolve-tab-order";
import { MobileDrawerTabBar } from "@/components/layout/mobile-drawer-tab-bar";
import { openBugReportPopup } from "@/lib/report-bug";
import { UpgradeButton } from "@/components/layout/upgrade-button";
import { CloudSharePopover } from "@/components/layout/cloud-share-popover";
import { BottomSheet } from "@/components/ui/mobile-bottom-sheet";
import { isMobileDevice } from "@/hooks/use-is-mobile";
import { cn } from "@/lib/utils";

// Tab ids the mobile drawer can render content for. `search` is desktop-only for now;
// ext views are supported via the `ext:` prefix.
const MOBILE_SUPPORTED = new Set<string>([
  "history", "teams", "explorer", "git", "database", "tunnels", "ai-resources", "settings", "jira",
]);
const isMobileSupported = (id: SidebarActiveTab) => MOBILE_SUPPORTED.has(id) || id.startsWith("ext:");

interface MobileDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  /** Open directly to a specific tab */
  initialTab?: SidebarActiveTab;
}

export function MobileDrawer({ isOpen, onClose, initialTab }: MobileDrawerProps) {
  const { activeProject } = useProjectStore(useShallow((s) => ({ activeProject: s.activeProject })));
  const version = useSettingsStore((s) => s.version);
  const jiraEnabled = useSettingsStore((s) => s.jiraEnabled);
  const sidebarTabOrder = useSettingsStore((s) => s.sidebarTabOrder);
  const setSidebarTabOrder = useSettingsStore((s) => s.setSidebarTabOrder);
  const contributions = useExtensionStore((s) => s.contributions);
  const [activeTab, setActiveTab] = useState<SidebarActiveTab>(initialTab ?? "explorer");
  const [cloudOpen, setCloudOpen] = useState(false);

  const tabs = useMemo(
    () => resolveTabOrder(getAvailableTabs({ jiraEnabled, contributions }), sidebarTabOrder).filter((t) => isMobileSupported(t.id)),
    [jiraEnabled, contributions, sidebarTabOrder],
  );

  // Sync when initialTab changes (e.g. settings button opens drawer)
  useEffect(() => {
    if (initialTab) setActiveTab(initialTab);
  }, [initialTab]);

  // If the active tab disappears (Jira disabled, ext uninstalled), fall back to the first tab.
  useEffect(() => {
    if (tabs.length > 0 && !tabs.some((t) => t.id === activeTab)) setActiveTab(tabs[0]!.id);
  }, [tabs, activeTab]);

  // Command palette request — the desktop rail is hidden on mobile, so the
  // sheet here is what opens. The sheet portals to body, so it shows even while
  // the drawer itself is closed.
  useEffect(() => {
    const open = () => { if (isMobileDevice()) setCloudOpen(true); };
    window.addEventListener("open-cloud-share", open);
    return () => window.removeEventListener("open-cloud-share", open);
  }, []);

  const handleReportBug = useCallback(() => openBugReportPopup(version), [version]);

  const noProject = (
    <p className="px-4 py-6 text-xs text-text-secondary text-center">
      Select a project from the bottom nav bar
    </p>
  );

  return (
    <div
      className={cn(
        "fixed inset-0 z-50 md:hidden transition-opacity duration-200",
        isOpen ? "opacity-100" : "opacity-0 pointer-events-none",
      )}
    >
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/50" onClick={onClose} aria-label="Close drawer" />

      {/* Drawer panel */}
      <div
        className={cn(
          "fixed left-0 top-0 bottom-0 w-[90vw] bg-background border-r border-border",
          "z-50 flex flex-col transition-transform duration-300 ease-out",
          isOpen ? "translate-x-0" : "-translate-x-full",
        )}
      >
        {/* Header — logo + close */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-border shrink-0">
          <span className="text-sm font-bold text-primary tracking-tight">
            {activeProject?.name ?? "PPM"}
          </span>
          <button
            onClick={onClose}
            className="flex items-center justify-center size-8 rounded-md hover:bg-surface-elevated transition-colors"
          >
            <X className="size-4" />
          </button>
        </div>

        {/* Tab content — scrollable */}
        <div className="flex-1 overflow-y-auto min-h-0">
          {activeTab === "history" && (activeProject
            ? <SessionHistoryList variant="sidebar" projectName={activeProject.name} onNavigate={onClose} />
            : noProject)}
          {activeTab === "teams" && (activeProject ? <GroupList /> : noProject)}
          {activeTab === "explorer" && (activeProject ? <FileTree onFileOpen={onClose} /> : noProject)}
          {activeTab === "git" && <GitStatusPanel metadata={{ projectName: activeProject?.name }} onNavigate={onClose} />}
          {activeTab === "database" && <DatabaseSidebar />}
          {activeTab === "tunnels" && <TunnelManagerTab />}
          {activeTab === "jira" && <JiraPanel />}
          {activeTab === "ai-resources" && <AiResourcesPanel />}
          {activeTab === "settings" && <SettingsTab />}
          {activeTab.startsWith("ext:") && <ExtensionTreeView viewId={activeTab.slice(4)} className="h-full" />}
        </div>

        {/* Bottom tab bar — fixed slots + overflow "More" + drag reorder */}
        <div className="shrink-0 border-t border-border">
          <MobileDrawerTabBar
            tabs={tabs}
            activeId={activeTab}
            onSelect={setActiveTab}
            onReorder={setSidebarTabOrder}
          />

          {/* Report Bug + Cloud & Share + Version / Upgrade */}
          <div className="flex items-center justify-between px-4 py-2 border-t border-border text-[11px]">
            <UpgradeButton align="left" />
            <div className="flex items-center gap-3">
              <button
                onClick={() => setCloudOpen(true)}
                className="flex items-center gap-1 text-[10px] text-text-subtle hover:text-text-secondary transition-colors"
              >
                <Cloud className="size-3" />
                <span>Cloud &amp; Share</span>
              </button>
              <button
                onClick={handleReportBug}
                className="flex items-center gap-1 text-[10px] text-text-subtle hover:text-text-secondary transition-colors"
              >
                <BugIcon className="size-3" />
                <span>Report Bug</span>
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Cloud & Share — bottom sheet (portals to body, so drawer transform doesn't clip it) */}
      <BottomSheet open={cloudOpen} onClose={() => setCloudOpen(false)} zIndex={60}>
        <CloudSharePopover variant="sheet" onClose={() => setCloudOpen(false)} />
      </BottomSheet>
    </div>
  );
}
