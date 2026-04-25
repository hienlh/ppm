import { useState, useRef } from "react";
import { createPortal } from "react-dom";
import { useShallow } from "zustand/shallow";
import { useNotificationStore, selectTotalUnread, notificationTint } from "@/stores/notification-store";
import { useProjectStore, resolveOrder } from "@/stores/project-store";
import { useTabStore } from "@/stores/tab-store";
import { Bell, BellOff } from "lucide-react";
import { cn } from "@/lib/utils";
import { resolveProjectColor } from "@/lib/project-palette";

/** Bell button with unread count badge + popover listing unread sessions */
export function NotificationBellPopover({ expanded }: { expanded: boolean }) {
  const notifications = useNotificationStore((s) => s.notifications);
  const clearAll = useNotificationStore((s) => s.clearAll);
  const totalUnread = useNotificationStore(selectTotalUnread);
  const { projects, setActiveProject, customOrder } = useProjectStore(useShallow((s) => ({ projects: s.projects, setActiveProject: s.setActiveProject, customOrder: s.customOrder })));
  const ordered = resolveOrder(projects, customOrder);
  const openTab = useTabStore((s) => s.openTab);
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const [popoverPos, setPopoverPos] = useState<{ left: number; bottom: number } | null>(null);

  const handleToggle = () => {
    if (!open && btnRef.current) {
      const rect = btnRef.current.getBoundingClientRect();
      setPopoverPos({ left: rect.right + 6, bottom: window.innerHeight - rect.bottom });
    }
    setOpen(!open);
  };

  const handleGoToSession = (sessionId: string, projectName: string) => {
    const target = projects.find((p) => p.name === projectName);
    if (target) setActiveProject(target);
    openTab({
      type: "chat",
      title: "Chat",
      projectId: projectName,
      metadata: { projectName, sessionId, providerId: "claude" },
      closable: true,
    });
    setOpen(false);
  };

  // Resolve project color by name
  const getProjectColor = (name: string) => {
    const idx = ordered.findIndex((p) => p.name === name);
    if (idx === -1) return undefined;
    return resolveProjectColor(ordered[idx]!.color, idx);
  };

  // Group notifications by projectName
  const grouped = new Map<string, Array<{ sessionId: string; count: number; type: string; sessionTitle: string | null }>>();
  for (const [sessionId, entry] of notifications) {
    const key = entry.projectName || "Unknown";
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key)!.push({ sessionId, count: entry.count, type: entry.type, sessionTitle: entry.sessionTitle });
  }

  return (
    <>
      <button
        ref={btnRef}
        onClick={handleToggle}
        className={cn(
          "relative flex items-center rounded-md transition-colors",
          expanded ? "w-full h-8 gap-2 px-2 justify-start" : "justify-center size-8",
          open ? "text-primary bg-primary/10" : "text-text-subtle hover:text-foreground hover:bg-surface-elevated",
        )}
      >
        <Bell className="size-4 shrink-0" />
        {expanded && <span className="text-xs whitespace-nowrap">Notifications</span>}
        {totalUnread > 0 && (
          <span className={cn(
            "absolute flex items-center justify-center text-[9px] font-bold text-white bg-red-500 rounded-full min-w-[16px] h-4 px-1",
            expanded ? "right-1.5" : "-top-1 -right-1",
          )}>
            {totalUnread}
          </span>
        )}
      </button>

      {open && popoverPos && createPortal(
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div
            className="fixed z-50 w-72 max-h-80 overflow-y-auto rounded-lg border border-border bg-background shadow-lg"
            style={{ left: popoverPos.left, bottom: popoverPos.bottom }}
          >
            <div className="flex items-center justify-between px-3 py-2 border-b border-border">
              <span className="text-xs font-medium text-foreground">
                {totalUnread > 0 ? `${totalUnread} unread session${totalUnread > 1 ? "s" : ""}` : "No unread"}
              </span>
              {totalUnread > 0 && (
                <button
                  onClick={() => { clearAll(); setOpen(false); }}
                  className="text-[10px] text-text-subtle hover:text-foreground transition-colors flex items-center gap-1"
                >
                  <BellOff className="size-3" />
                  Clear all
                </button>
              )}
            </div>
            {totalUnread === 0 ? (
              <div className="px-3 py-4 text-center text-xs text-text-subtle">All caught up</div>
            ) : (
              <div className="py-1">
                {[...grouped.entries()].map(([projectName, sessions]) => (
                  <div key={projectName}>
                    <div className="px-3 py-1 text-[10px] font-medium text-text-subtle uppercase tracking-wider flex items-center gap-1.5">
                      <span className="size-2 rounded-full shrink-0" style={{ background: getProjectColor(projectName) || "currentColor" }} />
                      {projectName}
                    </div>
                    {sessions.map(({ sessionId, type, sessionTitle }) => (
                      <button
                        key={sessionId}
                        onClick={() => handleGoToSession(sessionId, projectName)}
                        className={cn(
                          "w-full px-3 py-1.5 text-left text-[11px] truncate hover:bg-surface-elevated transition-colors",
                          notificationTint(type),
                        )}
                      >
                        {sessionTitle || `${sessionId.slice(0, 12)}...`}
                      </button>
                    ))}
                  </div>
                ))}
              </div>
            )}
          </div>
        </>,
        document.body,
      )}
    </>
  );
}
