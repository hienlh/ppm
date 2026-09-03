/**
 * Floating-window body replaying one teammate's whole work session.
 *
 * The transcript is fetched on demand and only for the member being opened —
 * a single teammate transcript reaches several MB, so loading all of a team's
 * transcripts up front is not an option. Steps render through the same
 * `SubagentChildren` view the inline Agent card uses, so a teammate's session
 * looks identical wherever it is read.
 */

import { useEffect, useState } from "react";
import { Loader2, RefreshCw } from "lucide-react";
import { api } from "@/lib/api-client";
import { cn } from "@/lib/utils";
import type { ChatEvent } from "../../../types/chat";
import type { WindowContentProps } from "@/components/floating-window/window-content-registry";
import { SubagentChildren } from "./tool-cards";

/** Payload the team panel puts on the window when opening it. */
export interface TeamMemberWindowPayload {
  teamName: string;
  memberName: string;
  projectName?: string;
}

export default function TeamMemberWindowContent({ payload }: WindowContentProps) {
  const { teamName, memberName, projectName } = (payload ?? {}) as unknown as TeamMemberWindowPayload;
  const [events, setEvents] = useState<ChatEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Bumped by the refresh button; a working teammate keeps appending steps.
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    if (!teamName || !memberName) {
      setError("Missing team or member");
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    api
      .get<{ events?: ChatEvent[] }>(
        `/api/teams/${encodeURIComponent(teamName)}/members/${encodeURIComponent(memberName)}/transcript`,
      )
      .then((res) => {
        if (cancelled) return;
        setEvents(res?.events ?? []);
      })
      .catch(() => {
        if (!cancelled) setError("Could not read this member's session");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [teamName, memberName, reloadKey]);

  return (
    <div className="flex flex-col h-full min-h-0 bg-surface">
      <div className="flex items-center gap-2 px-3 py-1.5 border-b border-border/30 shrink-0">
        <span className="text-xs font-medium truncate">{memberName}</span>
        <span className="text-[10px] text-text-subtle">
          {events.length > 0 ? `${events.length} steps` : ""}
        </span>
        <button
          type="button"
          onClick={() => setReloadKey((k) => k + 1)}
          className="ml-auto text-text-subtle hover:text-foreground p-1 shrink-0"
          aria-label="Reload session"
        >
          <RefreshCw className={cn("size-3", loading && "animate-spin")} />
        </button>
      </div>

      {loading && events.length === 0 ? (
        <div className="flex-1 flex items-center justify-center gap-2 text-xs text-text-subtle">
          <Loader2 className="size-3 animate-spin" />
          Loading session…
        </div>
      ) : error ? (
        <div className="flex-1 flex items-center justify-center text-xs text-error px-4 text-center">{error}</div>
      ) : events.length === 0 ? (
        <div className="flex-1 flex items-center justify-center text-xs text-text-subtle">
          This member has no recorded session
        </div>
      ) : (
        <SubagentChildren
          events={events}
          projectName={projectName}
          className="flex-1 min-h-0 overflow-y-auto px-3 py-2 space-y-1"
        />
      )}
    </div>
  );
}
