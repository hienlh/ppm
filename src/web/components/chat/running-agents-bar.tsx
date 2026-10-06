/**
 * Every agent that is really still working, pinned under the conversation.
 *
 * Replaces `TeamWorkingBar`: that bar only ever knew about named teammates
 * polled over REST. This one also lists a backgrounded agent and one resumed
 * by SendMessage (which writes no new card at all) — anything the transcript
 * hub's `agent-activity` feed reports as recently written to disk, merged with
 * the team panel's richer per-member poll for agent type / elapsed time.
 *
 * Liveness is entirely disk-derived on the server, never from chat state in
 * memory, so a replayed old session shows nothing here even though its cards
 * are still in the transcript.
 *
 * From `FOLD_FROM` agents on, the list scrolls inside about three rows under an
 * "N agents running" header that folds it away — open on desktop, folded on a
 * phone. Unbounded, a session fanning out to a dozen agents pushed the
 * conversation off the screen.
 */
import { useId, useMemo, useState } from "react";
import { Bot, ChevronRight, Users } from "@/lib/icons";
import { useAgentActivity } from "@/hooks/use-agent-activity";
import { useIsMobile } from "@/hooks/use-is-mobile";
import type { TeamMemberActivity } from "@/hooks/use-team-activity-feed";
import { buildRunningRows, findCardLabel } from "@/lib/running-agent-rows";
import { formatDuration, shortAgentType } from "./team-member-activity-format";
import { useOpenAgentSession } from "./use-open-agent-session";
import { usePrefersCoarsePointer } from "@/components/os-explorer/use-coarse-long-press";
import { cn } from "@/lib/utils";
import type { ChatMessage } from "../../../types/chat";
import type { AgentTranscriptProviderId } from "../../../shared/agent-transcript-protocol";

interface RunningAgentsBarProps {
  projectName: string;
  providerId: AgentTranscriptProviderId;
  sessionId: string | null;
  /** For labelling a card row from what the chat already knows about it. */
  messages: ChatMessage[];
  /** The session's implicit team name, for a member row's `source`. */
  teamName: string;
  teamMembers: TeamMemberActivity[];
}

/** From this many rows on, the list gets a header to fold it under and stops growing. */
export const FOLD_FROM = 4;

export function RunningAgentsBar({ projectName, providerId, sessionId, messages, teamName, teamMembers }: RunningAgentsBarProps) {
  const running = useAgentActivity({ projectName, providerId, sessionId });
  const openAgentSession = useOpenAgentSession();
  const rows = useMemo(() => buildRunningRows(running, teamMembers), [running, teamMembers]);
  // Touch needs the 44px minimum even at desktop width; a mouse keeps the tighter 36px row.
  const coarse = usePrefersCoarsePointer();
  const rowHeight = coarse ? "min-h-[44px]" : "min-h-[36px]";
  const isMobile = useIsMobile();
  const [open, setOpen] = useState(!isMobile);
  const listId = useId();

  if (!sessionId || rows.length === 0) return null;
  const foldable = rows.length >= FOLD_FROM;

  return (
    <div className="shrink-0 border-t border-border bg-surface-elevated/60 px-2 py-1.5 space-y-1">
      {foldable && (
        <button
          type="button"
          onClick={() => setOpen(!open)}
          aria-expanded={open}
          aria-controls={listId}
          className={cn("flex w-full items-center gap-2 rounded px-1 text-left text-xs hover:bg-surface transition-colors", rowHeight)}
        >
          <ChevronRight className={cn("size-3.5 shrink-0 text-text-subtle transition-transform", open && "rotate-90")} />
          <span className="font-medium text-text-primary">{rows.length} agents running</span>
        </button>
      )}
      {(!foldable || open) && (
        <div
          id={listId}
          // Three rows (two at touch height) and most of the next, so the list visibly scrolls.
          className={cn("space-y-1", foldable && "overflow-y-auto", foldable && (coarse ? "max-h-32" : "max-h-36"))}
        >
          {rows.map((row) => {
            const label = row.cardId ? findCardLabel(messages, row.cardId) : null;
            const name = row.memberName ?? label?.handle ?? null;
            const description = label?.description || (row.cardId ? "Agent" : row.memberName!);
            const elapsed = row.startedAt ? formatDuration(row.startedAt) : undefined;
            const agentType = shortAgentType(row.agentType);

            return (
              <button
                key={row.key}
                type="button"
                onClick={() => openAgentSession({
                  projectName,
                  providerId,
                  sessionId,
                  source: row.cardId ? { kind: "card", cardId: row.cardId } : { kind: "member", teamName, memberName: row.memberName! },
                  title: name ? `Session — ${name}` : "Agent session",
                  prompt: label?.description,
                })}
                className={cn(
                  "flex w-full items-center gap-2 rounded px-1 py-1.5 text-left text-xs hover:bg-surface transition-colors",
                  rowHeight,
                )}
                title={name ? `Open ${name}'s session` : "Open agent session"}
              >
                <span className="relative flex size-2 shrink-0">
                  <span className="absolute inline-flex size-full animate-ping rounded-full bg-emerald-400 opacity-60" />
                  <span className="relative inline-flex size-2 rounded-full bg-emerald-500" />
                </span>
                {row.memberName
                  ? <Users className="size-3.5 shrink-0 text-accent-2" />
                  : <Bot className="size-3.5 shrink-0 text-primary" />}
                <span className="font-medium text-text-primary shrink-0">{name ?? description}</span>
                {!!agentType && <span className="text-text-3 shrink-0 hidden sm:inline">{agentType}</span>}
                {!!row.lastStep && (
                  <span className="flex-1 truncate text-text-subtle" title={row.lastStep}>
                    {row.lastStep}
                  </span>
                )}
                {!!elapsed && <span className="ml-auto shrink-0 text-text-3 font-mono">{elapsed}</span>}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
