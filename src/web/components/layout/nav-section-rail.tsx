import { useState, useRef, useEffect, useMemo, memo } from "react";
import { createPortal } from "react-dom";
import { Settings, Bug, Cloud, FolderTree } from "lucide-react";
import { openExplorer } from "@/components/os-explorer/open-explorer";
import { useSettingsStore, type SidebarActiveTab } from "@/stores/settings-store";
import { getAvailableTabs } from "@/lib/sidebar-tabs/tab-registry";
import { resolveTabOrder } from "@/lib/sidebar-tabs/resolve-tab-order";
import { useProjectStore } from "@/stores/project-store";
import { useShallow } from "zustand/react/shallow";
import { useExtensionStore } from "@/stores/extension-store";
import { useGitStatusStore } from "@/stores/git-status-store";
import { useJiraStore } from "@/stores/jira-store";
import { useNotificationStore, selectProjectUnread } from "@/stores/notification-store";
import { NotificationBellPopover } from "./notification-bell-popover";
import { CloudSharePopover } from "./cloud-share-popover";
import { openBugReportPopup } from "@/lib/report-bug";
import { isMobileDevice } from "@/hooks/use-is-mobile";
import { cn } from "@/lib/utils";

function Badge({ count }: { count: number }) {
  return (
    <span className="absolute top-1 right-1 min-w-[16px] h-4 px-1 flex items-center justify-center rounded-full bg-primary text-primary-foreground text-[10px] font-medium leading-none">
      {count > 99 ? "99+" : count}
    </span>
  );
}

// Section nav item: 38×38, active = tinted bg + inset accent bar + bolder icon.
function NavItem({ icon: Icon, label, active, badge, beta, onClick, dragging, dropBefore, onDragStart, onDragOver, onDrop, onDragEnd }: {
  icon: React.ElementType; label: string; active: boolean; badge?: number; beta?: boolean; onClick: () => void;
  dragging?: boolean; dropBefore?: boolean;
  onDragStart?: (e: React.DragEvent) => void;
  onDragOver?: (e: React.DragEvent) => void;
  onDrop?: (e: React.DragEvent) => void;
  onDragEnd?: () => void;
}) {
  return (
    <button
      draggable
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDrop={onDrop}
      onDragEnd={onDragEnd}
      onClick={onClick}
      className={cn(
        "group relative flex items-center justify-center size-[38px] rounded-[9px] transition-colors shrink-0",
        active
          ? "bg-accent-wash text-primary shadow-[inset_2px_0_0_var(--accent)]"
          : "text-text-subtle hover:bg-surface-elevated hover:text-foreground",
        dragging && "opacity-40",
        dropBefore && "shadow-[inset_0_2px_0_var(--accent)]",
      )}
    >
      <Icon className="size-[18px]" strokeWidth={active ? 2.4 : 2} />
      {badge != null && badge > 0 && <Badge count={badge} />}
      {beta && (
        <span className="absolute -top-0.5 -right-0.5 rounded-full bg-accent-wash px-1 text-[7px] font-bold uppercase leading-[1.4] tracking-wide text-primary shadow-sm">
          beta
        </span>
      )}
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
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className={cn(
        "group relative flex items-center justify-center size-8 rounded-[7px] transition-colors shrink-0",
        active ? "text-primary bg-accent-wash" : "text-text-subtle hover:bg-surface-elevated hover:text-foreground",
      )}
    >
      <Icon className="size-4" />
      <span className="pointer-events-none absolute left-[calc(100%+8px)] z-50 hidden can-hover:group-hover:block whitespace-nowrap rounded-md border border-border bg-surface-elevated px-2 py-1 text-xs font-medium text-foreground shadow-[0_4px_12px_rgba(0,0,0,.4)]">
        {label}
      </span>
    </button>
  );
}

export const NavSectionRail = memo(function NavSectionRail({ className }: { className?: string }) {
  const { activeProject } = useProjectStore(useShallow((s) => ({ activeProject: s.activeProject })));
  const sidebarActiveTab = useSettingsStore((s) => s.sidebarActiveTab);
  const setSidebarActiveTab = useSettingsStore((s) => s.setSidebarActiveTab);
  const sidebarTabOrder = useSettingsStore((s) => s.sidebarTabOrder);
  const setSidebarTabOrder = useSettingsStore((s) => s.setSidebarTabOrder);
  const sidebarCollapsed = useSettingsStore((s) => s.sidebarCollapsed);
  const toggleSidebar = useSettingsStore((s) => s.toggleSidebar);
  const jiraEnabled = useSettingsStore((s) => s.jiraEnabled);
  const version = useSettingsStore((s) => s.version);
  const contributions = useExtensionStore((s) => s.contributions);
  const gitChangesCount = useGitStatusStore((s) =>
    activeProject?.name ? (s.counts.get(activeProject.name) ?? 0) : 0,
  );
  const jiraUnreadCount = useJiraStore((s) => s.unreadCount);
  const historyUnreadCount = useNotificationStore(selectProjectUnread(activeProject?.name));

  const TABS = useMemo(
    () => resolveTabOrder(getAvailableTabs({ jiraEnabled, contributions }), sidebarTabOrder),
    [contributions, jiraEnabled, sidebarTabOrder],
  );

  // Drag-to-reorder — writes the full resolved id list so mobile/desktop stay in sync.
  const [dragId, setDragId] = useState<SidebarActiveTab | null>(null);
  const [dropId, setDropId] = useState<SidebarActiveTab | null>(null);

  const commitReorder = (targetId: SidebarActiveTab) => {
    if (dragId && dragId !== targetId) {
      const ids = TABS.map((t) => t.id);
      const from = ids.indexOf(dragId);
      if (from >= 0) {
        ids.splice(from, 1);
        const insertAt = ids.indexOf(targetId); // insert before target's post-removal position
        ids.splice(insertAt < 0 ? ids.length : insertAt, 0, dragId);
        setSidebarTabOrder(ids);
      }
    }
    setDragId(null);
    setDropId(null);
  };

  // Cloud & Share popover
  const [cloudOpen, setCloudOpen] = useState(false);
  const cloudBtnRef = useRef<HTMLButtonElement>(null);
  const [popoverPos, setPopoverPos] = useState<{ left: number; bottom: number } | null>(null);
  useEffect(() => {
    if (!cloudOpen || !cloudBtnRef.current) { setPopoverPos(null); return; }
    const rect = cloudBtnRef.current.getBoundingClientRect();
    setPopoverPos({ left: rect.right + 6, bottom: window.innerHeight - rect.bottom });
  }, [cloudOpen]);

  // Command palette can't reach the popover's local state, so it asks via event.
  // The rail is `hidden md:flex`, so on mobile the drawer's bottom sheet answers.
  useEffect(() => {
    const open = () => { if (!isMobileDevice()) setCloudOpen(true); };
    window.addEventListener("open-cloud-share", open);
    return () => window.removeEventListener("open-cloud-share", open);
  }, []);

  const handleReportBug = () => openBugReportPopup(version);

  // Rail tab click: collapsed → open on any tab; open → clicking the active tab closes it.
  const handleTabClick = (tabId: SidebarActiveTab) => {
    if (sidebarCollapsed) {
      setSidebarActiveTab(tabId);
      toggleSidebar();
    } else if (sidebarActiveTab === tabId) {
      toggleSidebar();
    } else {
      setSidebarActiveTab(tabId);
    }
  };

  return (
    <div className={cn("w-[52px] shrink-0 border-r border-border flex flex-col", className)}>
      {/* sections */}
      <div className="flex-1 overflow-y-auto min-h-0 flex flex-col items-center gap-[3px] px-[3px] py-2 scrollbar-none">
        {TABS.map((tab) => (
          <NavItem
            key={tab.id}
            icon={tab.icon}
            label={tab.label}
            active={sidebarActiveTab === tab.id}
            badge={tab.id === "git" ? gitChangesCount : tab.id === "jira" ? jiraUnreadCount : tab.id === "history" ? historyUnreadCount : undefined}
            beta={tab.beta}
            onClick={() => handleTabClick(tab.id)}
            dragging={dragId === tab.id}
            dropBefore={dropId === tab.id && dragId !== tab.id}
            onDragStart={(e) => { setDragId(tab.id); e.dataTransfer.effectAllowed = "move"; }}
            onDragOver={(e) => { e.preventDefault(); setDropId(tab.id); }}
            onDrop={(e) => { e.preventDefault(); commitReorder(tab.id); }}
            onDragEnd={() => { setDragId(null); setDropId(null); }}
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
        {/* Not a sidebar tab — the explorer lives in its own floating window. */}
        <FooterUtil icon={FolderTree} label="File Explorer" onClick={() => void openExplorer()} />
        <FooterUtil icon={Bug} label="Report Bug" onClick={handleReportBug} />
        <FooterUtil icon={Settings} label="Settings" active={sidebarActiveTab === "settings"} onClick={() => handleTabClick("settings")} />
      </div>
    </div>
  );
});
