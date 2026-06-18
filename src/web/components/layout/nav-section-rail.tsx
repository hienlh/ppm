import { useState, useRef, useEffect, useMemo, memo } from "react";
import { createPortal } from "react-dom";
import {
  FolderOpen, GitBranch, Settings, Database, Search, Puzzle, Bug, Cloud,
} from "lucide-react";
import { useSettingsStore, type SidebarActiveTab } from "@/stores/settings-store";
import { useProjectStore } from "@/stores/project-store";
import { useShallow } from "zustand/react/shallow";
import { useExtensionStore } from "@/stores/extension-store";
import { useGitStatusStore } from "@/stores/git-status-store";
import { useJiraStore } from "@/stores/jira-store";
import { NotificationBellPopover } from "./notification-bell-popover";
import { CloudSharePopover } from "./cloud-share-popover";
import { openBugReportPopup } from "@/lib/report-bug";
import { cn } from "@/lib/utils";

const BUILTIN_TABS: { id: SidebarActiveTab; label: string; icon: React.ElementType }[] = [
  { id: "explorer", label: "Explorer", icon: FolderOpen },
  { id: "search", label: "Search", icon: Search },
  { id: "git", label: "Git", icon: GitBranch },
  { id: "database", label: "Database", icon: Database },
  { id: "settings", label: "Settings", icon: Settings },
];

function Badge({ count }: { count: number }) {
  return (
    <span className="absolute top-1 right-1 min-w-[16px] h-4 px-1 flex items-center justify-center rounded-full bg-primary text-primary-foreground text-[10px] font-medium leading-none">
      {count > 99 ? "99+" : count}
    </span>
  );
}

// Section nav item: 38×38, active = tinted bg + inset accent bar + bolder icon.
function NavItem({ icon: Icon, label, active, badge, onClick }: {
  icon: React.ElementType; label: string; active: boolean; badge?: number; onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "group relative flex items-center justify-center size-[38px] rounded-lg transition-colors shrink-0",
        active
          ? "bg-primary/[0.12] text-primary shadow-[inset_2px_0_0_var(--color-primary)]"
          : "text-text-subtle hover:bg-surface-elevated hover:text-foreground",
      )}
    >
      <Icon className="size-[18px]" strokeWidth={active ? 2.4 : 2} />
      {badge != null && badge > 0 && <Badge count={badge} />}
      {/* hover tooltip (pointer devices only) */}
      <span className="pointer-events-none absolute left-[calc(100%+8px)] z-50 hidden can-hover:group-hover:block whitespace-nowrap rounded-md border border-border bg-surface-elevated px-2 py-1 text-xs font-medium text-foreground shadow-[0_4px_12px_rgba(0,0,0,.4)]">
        {label}
      </span>
    </button>
  );
}

// Footer utility item: 32×32, 16px icon.
function FooterUtil({ icon: Icon, label, onClick, active }: {
  icon: React.ElementType; label: string; onClick?: () => void; active?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "group relative flex items-center justify-center size-8 rounded-[7px] transition-colors shrink-0",
        active ? "text-primary bg-primary/10" : "text-text-subtle hover:bg-surface-elevated hover:text-foreground",
      )}
    >
      <Icon className="size-4" />
      <span className="pointer-events-none absolute left-[calc(100%+8px)] z-50 hidden can-hover:group-hover:block whitespace-nowrap rounded-md border border-border bg-surface-elevated px-2 py-1 text-xs font-medium text-foreground shadow-[0_4px_12px_rgba(0,0,0,.4)]">
        {label}
      </span>
    </button>
  );
}

export const NavSectionRail = memo(function NavSectionRail() {
  const { activeProject } = useProjectStore(useShallow((s) => ({ activeProject: s.activeProject })));
  const sidebarActiveTab = useSettingsStore((s) => s.sidebarActiveTab);
  const setSidebarActiveTab = useSettingsStore((s) => s.setSidebarActiveTab);
  const jiraEnabled = useSettingsStore((s) => s.jiraEnabled);
  const version = useSettingsStore((s) => s.version);
  const contributions = useExtensionStore((s) => s.contributions);
  const gitChangesCount = useGitStatusStore((s) =>
    activeProject?.name ? (s.counts.get(activeProject.name) ?? 0) : 0,
  );
  const jiraUnreadCount = useJiraStore((s) => s.unreadCount);

  const TABS = useMemo(() => {
    const tabs: { id: SidebarActiveTab; label: string; icon: React.ElementType }[] = [...BUILTIN_TABS];
    if (jiraEnabled) {
      const settingsIdx = tabs.findIndex((t) => t.id === "settings");
      tabs.splice(settingsIdx, 0, { id: "jira", label: "Jira", icon: Bug });
    }
    if (contributions?.views) {
      const sidebarViews = contributions.views["sidebar"] ?? contributions.views["explorer"] ?? [];
      for (const view of sidebarViews) {
        tabs.push({ id: `ext:${view.id}` as SidebarActiveTab, label: view.name, icon: Puzzle });
      }
    }
    return tabs;
  }, [contributions, jiraEnabled]);

  // Cloud & Share popover
  const [cloudOpen, setCloudOpen] = useState(false);
  const cloudBtnRef = useRef<HTMLButtonElement>(null);
  const [popoverPos, setPopoverPos] = useState<{ left: number; bottom: number } | null>(null);
  useEffect(() => {
    if (!cloudOpen || !cloudBtnRef.current) { setPopoverPos(null); return; }
    const rect = cloudBtnRef.current.getBoundingClientRect();
    setPopoverPos({ left: rect.right + 6, bottom: window.innerHeight - rect.bottom });
  }, [cloudOpen]);

  const handleReportBug = () => openBugReportPopup(version);

  return (
    <div className="w-[52px] shrink-0 border-r border-border flex flex-col">
      {/* sections */}
      <div className="flex-1 overflow-y-auto min-h-0 flex flex-col items-center gap-[3px] px-[3px] py-2 scrollbar-none">
        {TABS.map((tab) => (
          <NavItem
            key={tab.id}
            icon={tab.icon}
            label={tab.label}
            active={sidebarActiveTab === tab.id}
            badge={tab.id === "git" ? gitChangesCount : tab.id === "jira" ? jiraUnreadCount : undefined}
            onClick={() => setSidebarActiveTab(tab.id)}
          />
        ))}
      </div>

      {/* footer utilities */}
      <div className="shrink-0 flex flex-col items-center gap-0.5 px-[3px] py-2 border-t border-border">
        <NotificationBellPopover expanded={false} />
        <button
          ref={cloudBtnRef}
          onClick={() => setCloudOpen(!cloudOpen)}
          className={cn(
            "group relative flex items-center justify-center size-8 rounded-[7px] transition-colors shrink-0",
            cloudOpen ? "text-primary bg-primary/10" : "text-text-subtle hover:bg-surface-elevated hover:text-foreground",
          )}
        >
          <Cloud className="size-4" />
          <span className="pointer-events-none absolute left-[calc(100%+8px)] z-50 hidden can-hover:group-hover:block whitespace-nowrap rounded-md border border-border bg-surface-elevated px-2 py-1 text-xs font-medium text-foreground shadow-[0_4px_12px_rgba(0,0,0,.4)]">
            Cloud &amp; Share
          </span>
        </button>
        {cloudOpen && popoverPos && createPortal(
          <>
            <div className="fixed inset-0 z-40" onClick={() => setCloudOpen(false)} />
            <div className="fixed z-50" style={{ left: popoverPos.left, bottom: popoverPos.bottom }}>
              <CloudSharePopover onClose={() => setCloudOpen(false)} />
            </div>
          </>,
          document.body,
        )}
        <FooterUtil icon={Bug} label="Report Bug" onClick={handleReportBug} />
        <FooterUtil icon={Settings} label="Settings" active={sidebarActiveTab === "settings"} onClick={() => setSidebarActiveTab("settings")} />
      </div>
    </div>
  );
});
