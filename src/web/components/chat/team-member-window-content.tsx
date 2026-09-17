/**
 * Floating-window body replaying one teammate's whole work session, live.
 *
 * The transcript is fetched on demand and only for the member being opened —
 * a single teammate transcript reaches several MB, so loading all of a team's
 * transcripts up front is not an option, and following one means tailing it by
 * byte offset rather than re-reading it (`useMemberTranscriptTail`). Steps
 * render through the same `SubagentChildren` view the inline Agent card uses,
 * so a teammate's session looks identical wherever it is read.
 */

import { Loader2, RefreshCw } from "@/lib/icons";
import { cn } from "@/lib/utils";
import { useMemberTranscriptTail } from "@/hooks/use-member-transcript-tail";
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
  const { events, loading, error, refresh } = useMemberTranscriptTail(teamName, memberName);

  return (
    <div className="flex flex-col h-full min-h-0 bg-surface">
      <div className="flex items-center gap-2 px-3 py-1.5 border-b border-border/30 shrink-0">
        <span className="text-xs font-medium truncate">{memberName}</span>
        <span className="text-[10px] text-text-subtle">
          {events.length > 0 ? `${events.length} steps` : ""}
        </span>
        <button
          type="button"
          onClick={refresh}
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
