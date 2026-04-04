import { useState, useRef, useEffect, useCallback } from "react";
import { RefreshCw, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { api } from "@/lib/api-client";
import type { TeamMessageItem } from "@/hooks/use-chat";

interface TeamActivityPopoverProps {
  teamNames: string[];
  messages: TeamMessageItem[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const STATUS_COLORS: Record<string, string> = {
  active: "bg-green-500",
  idle: "bg-yellow-500",
  shutdown: "bg-zinc-400",
};

const TYPE_BADGES: Record<string, { label: string; className: string }> = {
  task_assignment: { label: "task", className: "bg-blue-500/20 text-blue-400" },
  idle_notification: { label: "idle", className: "bg-yellow-500/20 text-yellow-400" },
  completion: { label: "done", className: "bg-green-500/20 text-green-400" },
  shutdown_request: { label: "shutdown", className: "bg-red-500/20 text-red-400" },
  shutdown_approved: { label: "shutdown ✓", className: "bg-zinc-500/20 text-zinc-400" },
};

export function TeamActivityPopover({ teamNames, messages, open, onOpenChange }: TeamActivityPopoverProps) {
  const [selectedTeam, setSelectedTeam] = useState(teamNames[0] ?? "");
  const [members, setMembers] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  // Sync selected team when teamNames changes
  useEffect(() => {
    if (teamNames.length > 0 && !teamNames.includes(selectedTeam)) {
      setSelectedTeam(teamNames[0]!);
    }
  }, [teamNames, selectedTeam]);

  const fetchTeamDetail = useCallback(async (name: string) => {
    setLoading(true);
    try {
      const detail = await api.get<any>(`/api/teams/${encodeURIComponent(name)}`);
      setMembers(detail?.members ?? []);
    } catch { setMembers([]); }
    setLoading(false);
  }, []);

  // Fetch members on mount and tab switch
  useEffect(() => {
    if (open && selectedTeam) fetchTeamDetail(selectedTeam);
  }, [open, selectedTeam, fetchTeamDetail]);

  // Auto-scroll messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages.length]);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        onOpenChange(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open, onOpenChange]);

  if (!open) return null;

  // Filter messages relevant to selected team (all for now — teams share the same messages array)
  const teamMessages = messages;
  const displayMessages = teamMessages.slice(-200);

  return (
    <div
      ref={panelRef}
      className="absolute bottom-full left-0 mb-2 w-80 md:w-96 bg-surface border border-border rounded-lg shadow-lg z-50 overflow-hidden"
    >
      {/* Header with tabs */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-border bg-surface-elevated">
        <div className="flex items-center gap-1 overflow-x-auto min-w-0">
          {teamNames.map((name) => (
            <button
              key={name}
              onClick={() => setSelectedTeam(name)}
              className={cn(
                "px-2 py-0.5 text-[11px] rounded-md whitespace-nowrap transition-colors",
                selectedTeam === name
                  ? "bg-primary/10 text-primary font-medium"
                  : "text-text-subtle hover:text-text-primary"
              )}
            >
              {name}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <button
            onClick={() => selectedTeam && fetchTeamDetail(selectedTeam)}
            className="text-text-subtle hover:text-foreground p-1"
            aria-label="Refresh"
          >
            <RefreshCw className={cn("size-3", loading && "animate-spin")} />
          </button>
          <button
            onClick={() => onOpenChange(false)}
            className="text-text-subtle hover:text-foreground p-1"
            aria-label="Close"
          >
            <X className="size-3" />
          </button>
        </div>
      </div>

      {/* Members */}
      {members.length > 0 && (
        <div className="px-3 py-2 border-b border-border">
          <div className="text-[10px] text-text-subtle uppercase tracking-wider mb-1">Members</div>
          <div className="space-y-1">
            {members.map((m: any) => (
              <div key={m.name} className="flex items-center gap-2 text-xs">
                <span className={cn("size-1.5 rounded-full shrink-0", STATUS_COLORS[m.status] ?? "bg-zinc-400")} />
                <span className="font-medium truncate">{m.name}</span>
                {m.model && m.model !== "unknown" && (
                  <span className="text-text-subtle text-[10px]">({m.model})</span>
                )}
                <span className="ml-auto text-text-subtle text-[10px]">{m.status}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Messages */}
      <div className="max-h-64 overflow-y-auto px-3 py-2">
        {displayMessages.length === 0 ? (
          <p className="text-xs text-text-subtle text-center py-4">No messages yet</p>
        ) : (
          <div className="space-y-2">
            {displayMessages.map((msg, i) => {
              const badge = msg.parsedType ? TYPE_BADGES[msg.parsedType] : null;
              const time = formatTime(msg.timestamp);
              return (
                <div key={`${msg.timestamp}-${i}`} className="text-xs">
                  <div className="flex items-center gap-1 text-text-subtle">
                    <span className="font-medium" style={safeColor(msg.color)}>
                      {msg.from}
                    </span>
                    <span>→</span>
                    <span>{msg.to}</span>
                    <span className="ml-auto text-[10px]">{time}</span>
                  </div>
                  <div className="mt-0.5 text-foreground/90 break-words">
                    {badge && (
                      <span className={cn("inline-block px-1 py-0 rounded text-[9px] mr-1", badge.className)}>
                        {badge.label}
                      </span>
                    )}
                    {msg.summary ?? truncateText(msg.text)}
                  </div>
                </div>
              );
            })}
            <div ref={messagesEndRef} />
          </div>
        )}
      </div>
    </div>
  );
}

function formatTime(timestamp: string): string {
  try {
    const d = new Date(timestamp);
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  } catch { return ""; }
}

/** Sanitize color value to prevent CSS injection */
function safeColor(color?: string): React.CSSProperties | undefined {
  if (!color) return undefined;
  // Only allow hex colors and named CSS colors (no url(), expression(), etc.)
  if (/^#[0-9a-fA-F]{3,8}$/.test(color) || /^[a-zA-Z]{3,20}$/.test(color)) {
    return { color };
  }
  return undefined;
}

function truncateText(text: string, max = 120): string {
  if (!text) return "";
  // Try to parse JSON for structured messages
  try {
    const parsed = JSON.parse(text);
    return parsed.summary ?? parsed.text ?? text.slice(0, max);
  } catch {}
  return text.length > max ? text.slice(0, max) + "..." : text;
}
