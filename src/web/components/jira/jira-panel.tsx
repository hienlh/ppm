import { useState, useEffect, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useProjectStore } from "@/stores/project-store";
import { useJiraStore } from "@/stores/jira-store";
import { useTabStore } from "@/stores/tab-store";
import { JiraTicketCard } from "./jira-ticket-card";
import { JiraWatcherList } from "./jira-watcher-list";
import { JiraConfigForm } from "./jira-config-form";
import { JiraDebugPromptDialog } from "./jira-debug-prompt-dialog";
import { ArrowLeft, Settings2, Plus, ListFilter, RefreshCw, Loader2 } from "lucide-react";
import { toast } from "sonner";
import type { JiraWatchResult } from "../../../../src/types/jira";

type SubView = "tickets" | "watchers" | "credentials";

export function JiraPanel() {
  const activeProject = useProjectStore((s) => s.activeProject);
  const openTab = useTabStore((s) => s.openTab);
  const {
    configs, watchers, results, loadConfigs, loadWatchers, loadResults,
    loadProjectsWithIds, projectsWithIds, softDeleteResult, resumeDebug, cancelDebug,
    markRead, unreadCount, loadUnreadCount,
  } = useJiraStore();

  const [subView, setSubView] = useState<SubView>("tickets");
  const [loading, setLoading] = useState(false);
  const [debugTarget, setDebugTarget] = useState<JiraWatchResult | null>(null);

  // Resolve current project → config
  const projectEntry = projectsWithIds.find((p) => p.name === activeProject?.name);
  const config = configs.find((c) => c.projectId === projectEntry?.id);

  // Load data on mount and when project changes
  useEffect(() => {
    loadConfigs();
    loadProjectsWithIds();
  }, []);

  useEffect(() => {
    if (config) loadWatchers(config.id);
  }, [config?.id]);

  const refresh = useCallback(async () => {
    setLoading(true);
    try { await loadResults(); } catch {}
    setLoading(false);
  }, [loadResults]);

  useEffect(() => { refresh(); loadUnreadCount(); }, [config?.id]);

  // WS events for live status updates
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (!detail) return;
      refresh();
      if (detail.status === "done") {
        loadUnreadCount();
        toast.success(`Debug complete: ${detail.issueKey}`, {
          action: detail.sessionId ? {
            label: "View",
            onClick: () => openTab({
              type: "chat",
              title: `[Jira] ${detail.issueKey}`,
              projectId: activeProject?.name ?? null,
              metadata: { projectName: activeProject?.name, sessionId: detail.sessionId },
              closable: true,
            }),
          } : undefined,
        });
      } else if (detail.status === "failed") {
        toast.error(`Debug failed: ${detail.issueKey}`);
      }
    };
    window.addEventListener("jira:status_change", handler);
    return () => window.removeEventListener("jira:status_change", handler);
  }, [refresh, loadUnreadCount]);

  const openSession = useCallback((r: JiraWatchResult) => {
    if (!r.sessionId) return;
    if (r.status === "done" && !r.readAt) markRead(r.id);
    openTab({
      type: "chat",
      title: `[Jira] ${r.issueKey}`,
      projectId: activeProject?.name ?? null,
      metadata: { projectName: activeProject?.name, sessionId: r.sessionId },
      closable: true,
    });
  }, [openTab, markRead, activeProject]);

  const handleRowClick = (r: JiraWatchResult) => {
    if (r.sessionId) openSession(r);
  };

  // No project selected
  if (!activeProject) {
    return (
      <div className="flex items-center justify-center h-32 p-4">
        <p className="text-xs text-muted-foreground text-center">Select a project to use Jira</p>
      </div>
    );
  }

  // Sub-views: watchers / credentials
  if (subView !== "tickets") {
    const title = subView === "watchers" ? "Watchers" : "Jira Credentials";
    return (
      <div className="h-full flex flex-col">
        <div className="shrink-0 px-2 py-2 flex items-center gap-1.5 border-b border-border/50">
          <Button size="icon" variant="ghost" className="size-7" onClick={() => setSubView("tickets")}>
            <ArrowLeft className="size-4" />
          </Button>
          <h2 className="text-sm font-semibold truncate">{title}</h2>
        </div>
        <ScrollArea className="flex-1 min-h-0">
          <div className="p-3">
            {subView === "watchers" ? (
              config ? <JiraWatcherList configId={config.id} /> : <p className="text-xs text-muted-foreground text-center py-4">Configure Jira credentials first.</p>
            ) : (
              projectEntry ? <JiraConfigForm projectId={projectEntry.id} existing={config ? { baseUrl: config.baseUrl, email: config.email, hasToken: config.hasToken } : null} /> : <p className="text-xs text-muted-foreground text-center py-4">Project not found in database.</p>
            )}
          </div>
        </ScrollArea>
      </div>
    );
  }

  // Default: ticket list
  return (
    <div className="h-full flex flex-col">
      {/* Header */}
      <div className="shrink-0 px-3 py-2 flex items-center gap-1.5 border-b border-border/50">
        <h2 className="text-sm font-semibold flex-1 truncate">Jira</h2>
        {unreadCount > 0 && (
          <span className="inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full bg-primary text-primary-foreground text-[10px] font-bold">
            {unreadCount}
          </span>
        )}
        <Button size="icon" variant="ghost" className="size-7" onClick={refresh} disabled={loading} title="Refresh">
          {loading ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}
        </Button>
        <Button size="icon" variant="ghost" className="size-7" onClick={() => setSubView("watchers")} title="Watchers">
          <ListFilter className="size-3.5" />
        </Button>
        <Button size="icon" variant="ghost" className="size-7" onClick={() => setSubView("credentials")} title="Credentials">
          <Settings2 className="size-3.5" />
        </Button>
      </div>

      {/* Ticket list */}
      <ScrollArea className="flex-1 min-h-0">
        <div className="p-1.5 space-y-1.5">
          {!config ? (
            <EmptyState
              message="No Jira credentials configured"
              action="Set up Jira"
              onAction={() => setSubView("credentials")}
            />
          ) : results.length === 0 && watchers.length === 0 ? (
            <EmptyState
              message="No watchers yet"
              action="Add Watcher"
              onAction={() => setSubView("watchers")}
            />
          ) : results.length === 0 ? (
            <EmptyState message="No tickets yet. Watchers will pick up new issues." />
          ) : (
            results.map((r) => (
              <JiraTicketCard
                key={r.id}
                result={r}
                onDebug={setDebugTarget}
                onResume={(r) => resumeDebug(r.id)}
                onCancel={(r) => cancelDebug(r.id)}
                onOpenSession={openSession}
                onDelete={softDeleteResult}
                onClick={handleRowClick}
              />
            ))
          )}
        </div>
      </ScrollArea>

      <JiraDebugPromptDialog result={debugTarget} onClose={() => setDebugTarget(null)} />
    </div>
  );
}

function EmptyState({ message, action, onAction }: { message: string; action?: string; onAction?: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center py-12 gap-3">
      <p className="text-xs text-muted-foreground text-center">{message}</p>
      {action && onAction && (
        <Button size="sm" variant="outline" className="min-h-[44px]" onClick={onAction}>
          <Plus className="size-4 mr-1.5" /> {action}
        </Button>
      )}
    </div>
  );
}
