import { useState, useEffect, useCallback } from "react";
import { History, Settings2, Loader2, MessageSquare, RefreshCw, Search } from "lucide-react";
import { Activity } from "lucide-react";
import { api, projectUrl } from "@/lib/api-client";
import { useTabStore } from "@/stores/tab-store";
import { AISettingsSection } from "@/components/settings/ai-settings-section";
import { UsageDetailPanel } from "./usage-badge";
import type { SessionInfo } from "../../../types/chat";
import type { UsageInfo } from "../../../types/chat";

type PanelType = "history" | "config" | "usage" | null;

interface ChatHistoryBarProps {
  projectName: string;
  usageInfo: UsageInfo;
  usageLoading?: boolean;
  refreshUsage?: () => void;
  lastFetchedAt?: string | null;
  sessionId?: string | null;
  onSelectSession?: (session: SessionInfo) => void;
  onBugReport?: () => void;
  isConnected?: boolean;
  onReconnect?: () => void;
}

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  } catch {
    return "";
  }
}

function relativeTime(iso: string): string {
  const secs = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (secs < 5) return "now";
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m`;
  return `${Math.floor(mins / 60)}h`;
}

function pctColor(pct: number): string {
  if (pct >= 90) return "text-red-500";
  if (pct >= 70) return "text-amber-500";
  return "text-green-500";
}

export function ChatHistoryBar({
  projectName, usageInfo, usageLoading, refreshUsage, lastFetchedAt,
  sessionId, onSelectSession, onBugReport, isConnected, onReconnect,
}: ChatHistoryBarProps) {
  const [activePanel, setActivePanel] = useState<PanelType>(null);
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const openTab = useTabStore((s) => s.openTab);

  const togglePanel = (panel: PanelType) => {
    setActivePanel((prev) => prev === panel ? null : panel);
  };

  const load = useCallback(async () => {
    if (!projectName) return;
    setLoading(true);
    try {
      const data = await api.get<SessionInfo[]>(`${projectUrl(projectName)}/chat/sessions`);
      setSessions(data);
    } catch {
      // silent
    } finally {
      setLoading(false);
    }
  }, [projectName]);

  // Load sessions when history panel opens
  useEffect(() => {
    if (activePanel === "history" && sessions.length === 0) load();
  }, [activePanel]); // eslint-disable-line react-hooks/exhaustive-deps

  function openSession(session: SessionInfo) {
    if (onSelectSession) {
      onSelectSession(session);
      setActivePanel(null);
    } else {
      openTab({
        type: "chat",
        title: session.title || "Chat",
        projectId: projectName ?? null,
        metadata: { projectName, sessionId: session.id },
        closable: true,
      });
    }
  }

  // Filter sessions by search query
  const filteredSessions = searchQuery.trim()
    ? sessions.filter((s) => (s.title || "").toLowerCase().includes(searchQuery.toLowerCase()))
    : sessions;

  // Usage badge display
  const fiveHourPct = usageInfo.fiveHour != null ? Math.round(usageInfo.fiveHour * 100) : null;
  const sevenDayPct = usageInfo.sevenDay != null ? Math.round(usageInfo.sevenDay * 100) : null;
  const worstPct = Math.max(fiveHourPct ?? 0, sevenDayPct ?? 0);
  const usageColor = fiveHourPct != null || sevenDayPct != null ? pctColor(worstPct) : "text-text-subtle";

  return (
    <div className="border-b border-border/50">
      {/* Toolbar row — all buttons on one line */}
      <div className="flex items-center gap-1 px-2 py-1">
        {/* History */}
        <button
          onClick={() => togglePanel("history")}
          className={`flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] transition-colors ${
            activePanel === "history" ? "text-primary bg-primary/10" : "text-text-secondary hover:text-foreground hover:bg-surface-elevated"
          }`}
        >
          <History className="size-3" />
          <span>History</span>
        </button>

        {/* Config */}
        <button
          onClick={() => togglePanel("config")}
          className={`p-1 rounded transition-colors ${
            activePanel === "config" ? "text-primary bg-primary/10" : "text-text-subtle hover:text-text-secondary hover:bg-surface-elevated"
          }`}
          title="AI Settings"
        >
          <Settings2 className="size-3" />
        </button>

        {/* Usage badge */}
        <button
          onClick={() => togglePanel("usage")}
          className={`flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] font-medium tabular-nums transition-colors hover:bg-surface-elevated ${
            activePanel === "usage" ? "bg-primary/10" : ""
          } ${usageColor}`}
          title="Usage limits"
        >
          <Activity className="size-3" />
          <span>5h:{fiveHourPct != null ? `${fiveHourPct}%` : "--%"}</span>
          <span className="text-text-subtle">·</span>
          <span>Wk:{sevenDayPct != null ? `${sevenDayPct}%` : "--%"}</span>
          {lastFetchedAt && (
            <span className="text-text-subtle/50 font-normal text-[9px] ml-0.5">{relativeTime(lastFetchedAt)}</span>
          )}
        </button>

        {/* Spacer */}
        <div className="flex-1" />

        {/* Connection indicator */}
        {onReconnect && (
          <button
            onClick={onReconnect}
            className="size-4 flex items-center justify-center"
            title={isConnected ? "Connected" : "Disconnected — click to reconnect"}
          >
            <span className={`size-2 rounded-full ${isConnected ? "bg-green-500" : "bg-red-500 animate-pulse"}`} />
          </button>
        )}
      </div>

      {/* Panels — only one visible at a time */}

      {/* History panel */}
      {activePanel === "history" && (
        <div className="border-t border-border/30 bg-surface">
          {/* Search + refresh */}
          <div className="flex items-center gap-1.5 px-2 py-1 border-b border-border/30">
            <Search className="size-3 text-text-subtle shrink-0" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search sessions..."
              className="flex-1 bg-transparent text-[11px] text-text-primary outline-none placeholder:text-text-subtle"
            />
            <button
              onClick={load}
              disabled={loading}
              className="p-0.5 rounded text-text-subtle hover:text-text-secondary transition-colors disabled:opacity-50"
              title="Refresh"
            >
              <RefreshCw className={`size-3 ${loading ? "animate-spin" : ""}`} />
            </button>
          </div>

          <div className="max-h-[200px] overflow-y-auto">
            {loading && sessions.length === 0 ? (
              <div className="flex items-center justify-center py-3">
                <Loader2 className="size-3.5 animate-spin text-text-subtle" />
              </div>
            ) : filteredSessions.length === 0 ? (
              <div className="flex items-center justify-center py-3 text-[11px] text-text-subtle">
                {searchQuery ? "No matching sessions" : "No sessions yet"}
              </div>
            ) : (
              filteredSessions.map((session) => (
                <button
                  key={session.id}
                  onClick={() => openSession(session)}
                  className="flex items-center gap-2 w-full px-3 py-1.5 text-left hover:bg-surface-elevated transition-colors"
                >
                  <MessageSquare className="size-3 shrink-0 text-text-subtle" />
                  <span className="text-[11px] truncate flex-1">{session.title || "Untitled"}</span>
                  {session.updatedAt && (
                    <span className="text-[10px] text-text-subtle shrink-0">{formatDate(session.updatedAt)}</span>
                  )}
                </button>
              ))
            )}
          </div>
        </div>
      )}

      {/* Config panel */}
      {activePanel === "config" && (
        <div className="border-t border-border/30 bg-surface px-3 py-2 max-h-[280px] overflow-y-auto">
          <AISettingsSection compact />
        </div>
      )}

      {/* Usage panel */}
      {activePanel === "usage" && (
        <UsageDetailPanel
          usage={usageInfo}
          visible={true}
          onClose={() => setActivePanel(null)}
          onReload={refreshUsage}
          loading={usageLoading}
          lastFetchedAt={lastFetchedAt}
        />
      )}
    </div>
  );
}
