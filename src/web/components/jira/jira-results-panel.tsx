import { useState, useEffect, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useJiraStore } from "@/stores/jira-store";
import { JiraStatusBadge } from "./jira-status-badge";
import { JiraTicketDetail } from "./jira-ticket-detail";
import { JiraDebugPromptDialog } from "./jira-debug-prompt-dialog";
import { cn } from "@/lib/utils";
import { RefreshCw, Trash2, Loader2, Play } from "lucide-react";
import { toast } from "sonner";
import type { JiraWatchResult, JiraResultStatus } from "../../../../src/types/jira";

export function JiraResultsPanel() {
  const {
    results, watchers, configs, loadResults, loadConfigs,
    softDeleteResult, markRead, unreadCount, loadUnreadCount,
  } = useJiraStore();
  const [filterWatcher, setFilterWatcher] = useState<string>("all");
  const [filterStatus, setFilterStatus] = useState<string>("all");
  const [loading, setLoading] = useState(false);
  const [ticketOpen, setTicketOpen] = useState(false);
  const [selectedIssue, setSelectedIssue] = useState<{ configId: number; issueKey: string } | null>(null);
  const [debugTarget, setDebugTarget] = useState<JiraWatchResult | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      await loadResults(
        filterWatcher !== "all" ? Number(filterWatcher) : undefined,
        filterStatus !== "all" ? filterStatus : undefined,
      );
    } catch {}
    setLoading(false);
  }, [filterWatcher, filterStatus, loadResults]);

  useEffect(() => { loadConfigs(); loadUnreadCount(); refresh(); }, []);
  useEffect(() => { refresh(); }, [filterWatcher, filterStatus]);

  // Listen for jira:status_change WS events dispatched as CustomEvents
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
            onClick: () => window.dispatchEvent(
              new CustomEvent("ppm:open-session", { detail: { sessionId: detail.sessionId } }),
            ),
          } : undefined,
        });
      } else if (detail.status === "failed") {
        toast.error(`Debug failed: ${detail.issueKey}`);
      }
    };
    window.addEventListener("jira:status_change", handler);
    return () => window.removeEventListener("jira:status_change", handler);
  }, [refresh, loadUnreadCount]);

  const handleRowClick = (r: JiraWatchResult) => {
    // Mark as read if done + unread
    if (r.status === "done" && !r.readAt) markRead(r.id);

    if (r.status === "done" && r.sessionId) {
      window.dispatchEvent(new CustomEvent("ppm:open-session", { detail: { sessionId: r.sessionId } }));
      return;
    }
    const watcher = watchers.find((w) => w.id === r.watcherId);
    const config = configs.find((c) => c.id === watcher?.jiraConfigId);
    if (config) {
      setSelectedIssue({ configId: config.id, issueKey: r.issueKey });
      setTicketOpen(true);
    }
  };

  const selectedConfig = selectedIssue
    ? configs.find((c) => c.id === selectedIssue.configId)
    : null;

  return (
    <div className="h-full flex flex-col">
      {/* Filter bar */}
      <div className="shrink-0 px-3 py-2 flex items-center gap-2 border-b">
        <Select value={filterWatcher} onValueChange={setFilterWatcher}>
          <SelectTrigger className="h-8 w-32 text-xs"><SelectValue placeholder="Watcher" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All watchers</SelectItem>
            {watchers.map((w) => <SelectItem key={w.id} value={String(w.id)}>{w.name}</SelectItem>)}
          </SelectContent>
        </Select>
        <Select value={filterStatus} onValueChange={setFilterStatus}>
          <SelectTrigger className="h-8 w-28 text-xs"><SelectValue placeholder="Status" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All</SelectItem>
            <SelectItem value="pending">Pending</SelectItem>
            <SelectItem value="queued">Queued</SelectItem>
            <SelectItem value="running">Running</SelectItem>
            <SelectItem value="done">Done</SelectItem>
            <SelectItem value="failed">Failed</SelectItem>
          </SelectContent>
        </Select>
        {unreadCount > 0 && (
          <span className="inline-flex items-center justify-center size-5 rounded-full bg-primary text-primary-foreground text-[10px] font-bold">
            {unreadCount}
          </span>
        )}
        <Button size="icon" variant="ghost" className="size-8 ml-auto" onClick={refresh} disabled={loading}>
          {loading ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}
        </Button>
      </div>

      {/* Results list */}
      <div className="flex-1 overflow-y-auto">
        {results.length === 0 ? (
          <p className="text-sm text-muted-foreground text-center py-8">
            No results yet. Configure a watcher to start.
          </p>
        ) : (
          results.map((r) => (
            <div
              key={r.id}
              className={cn(
                "flex items-center gap-2 px-3 py-2 border-b hover:bg-muted/50 cursor-pointer",
                r.status === "done" && !r.readAt && "bg-primary/5 font-medium border-l-2 border-l-primary",
              )}
              onClick={() => handleRowClick(r)}
            >
              <JiraStatusBadge status={r.status as JiraResultStatus} />
              <span className="text-xs font-mono font-medium shrink-0">{r.issueKey}</span>
              <span className="text-xs text-muted-foreground truncate flex-1">
                {r.issueSummary ?? ""}
              </span>
              {r.status === "queued" && <Loader2 className="size-3.5 text-muted-foreground" />}
              {r.status === "running" && <Loader2 className="size-3.5 animate-spin text-primary" />}
              {r.status === "pending" && (
                <Button size="icon" variant="ghost" className="size-8 shrink-0"
                  onClick={(e) => { e.stopPropagation(); setDebugTarget(r); }}>
                  <Play className="size-3.5 text-primary" />
                </Button>
              )}
              <span className="text-[10px] text-muted-foreground shrink-0">
                {timeAgo(r.createdAt)}
              </span>
              <Button
                size="icon" variant="ghost"
                className="size-6 shrink-0 text-muted-foreground hover:text-destructive"
                onClick={(e) => { e.stopPropagation(); softDeleteResult(r.id); }}
              >
                <Trash2 className="size-3" />
              </Button>
            </div>
          ))
        )}
      </div>

      {/* Debug prompt dialog */}
      <JiraDebugPromptDialog result={debugTarget} onClose={() => setDebugTarget(null)} />

      {/* Ticket detail dialog */}
      {selectedIssue && (
        <JiraTicketDetail
          open={ticketOpen}
          onOpenChange={setTicketOpen}
          configId={selectedIssue.configId}
          issueKey={selectedIssue.issueKey}
          baseUrl={selectedConfig?.baseUrl}
        />
      )}
    </div>
  );
}

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "now";
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h`;
  return `${Math.floor(hrs / 24)}d`;
}
