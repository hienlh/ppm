/**
 * Every agent that is really still working, summarised in one line pinned under the
 * conversation.
 *
 * Replaces `TeamWorkingBar`: that bar only ever knew about named teammates polled over
 * REST. This one also lists a backgrounded agent and one resumed by SendMessage (which
 * writes no new card at all) — anything the transcript hub's `agent-activity` feed
 * reports as recently written to disk, merged with the team panel's richer per-member
 * poll for agent type / elapsed time.
 *
 * Liveness is entirely disk-derived on the server, never from chat state in memory, so a
 * replayed old session shows nothing here even though its cards are still in the
 * transcript.
 *
 * However many agents run, the bar is one line — avatars, "N agents running · N done"
 * and the first agent's current step — that opens a list capped at three rows which
 * scrolls inside itself, so a session fanning out to a dozen agents cannot push the
 * conversation off the screen. With a single agent there is nothing to list: the line is
 * that agent and opens its session directly. A finished agent stays on the list while
 * one launched beside it still runs.
 */
import { useEffect, useId, useMemo, useState } from "react";
import { Bot, ChevronRight, ChevronUp } from "@/lib/icons";
import { useAgentActivity } from "@/hooks/use-agent-activity";
import type { TeamMemberActivity } from "@/hooks/use-team-activity-feed";
import {
  buildRunningRows,
  findCardLabel,
  finishedSiblingRows,
  type RunningAgentRow,
} from "@/lib/running-agent-rows";
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

/** Avatars drawn before the rest collapse into "+N". */
const MAX_AVATARS = 3;

/** What a row shows, resolved once from the hub row and the chat's own card. */
interface AgentView {
  row: RunningAgentRow;
  name: string;
  prompt?: string;
  step?: string;
  elapsed?: string;
}

export function RunningAgentsBar({ projectName, providerId, sessionId, messages, teamName, teamMembers }: RunningAgentsBarProps) {
  const running = useAgentActivity({ projectName, providerId, sessionId });
  const openAgentSession = useOpenAgentSession();
  const runningRows = useMemo(() => buildRunningRows(running, teamMembers), [running, teamMembers]);
  const doneRows = useMemo(() => finishedSiblingRows(messages, runningRows), [messages, runningRows]);
  // Labels scan the whole transcript; the elapsed tick re-renders every second, so read them
  // only when the transcript or the rows change.
  const labels = useMemo(() => new Map(
    [...runningRows, ...doneRows].filter((r) => r.cardId).map((r) => [r.cardId!, findCardLabel(messages, r.cardId!)]),
  ), [messages, runningRows, doneRows]);
  const coarse = usePrefersCoarsePointer();
  const [open, setOpen] = useState(false);
  const listId = useId();
  useElapsedTick(runningRows.length > 0);

  const total = runningRows.length + doneRows.length;
  const single = total === 1;
  // A batch that shrinks to one agent, or ends, has no list left to keep open; the next
  // batch starts collapsed rather than inheriting this one's state.
  useEffect(() => { if (total <= 1) setOpen(false); }, [total]);

  if (!sessionId || runningRows.length === 0) return null;

  const view = (row: RunningAgentRow): AgentView => {
    const label = row.cardId ? labels.get(row.cardId) : null;
    const name = row.memberName ?? label?.handle ?? (label?.description || "Agent");
    const startedAt = row.startedAt ?? label?.launchedAt;
    return {
      row,
      name,
      prompt: label?.description || undefined,
      step: row.lastStep ?? shortAgentType(row.agentType),
      elapsed: row.done || !startedAt ? undefined : formatDuration(startedAt),
    };
  };
  const views = [...runningRows, ...doneRows].map(view);
  const lead = views[0]!;

  const openView = (v: AgentView) => openAgentSession({
    projectName,
    providerId,
    sessionId,
    source: v.row.cardId ? { kind: "card", cardId: v.row.cardId } : { kind: "member", teamName, memberName: v.row.memberName! },
    title: `Session — ${v.name}`,
    prompt: v.prompt,
  });

  const summaryCls = cn(
    "flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-text-2 transition-colors md:px-3.5 can-hover:hover:bg-panel-2",
    coarse ? "min-h-11" : "min-h-10",
  );

  return (
    <div className="shrink-0 border-t border-border bg-panel">
      {single ? (
        <button type="button" onClick={() => openView(lead)} className={summaryCls} title={`Open ${lead.name}'s session`}>
          <LiveDot done={false} />
          <span className="min-w-0 shrink truncate font-semibold text-text">{lead.name}</span>
          {!!lead.step && <span className="hidden min-w-0 flex-1 truncate font-mono text-text-3 sm:block">{lead.step}</span>}
          {!!lead.elapsed && <span className="ml-auto shrink-0 font-mono text-[11px] text-text-3">{lead.elapsed}</span>}
          <ChevronRight className="size-3.5 shrink-0 text-text-3" />
        </button>
      ) : (
        <button
          type="button"
          onClick={() => setOpen(!open)}
          aria-expanded={open}
          aria-controls={open ? listId : undefined}
          className={summaryCls}
        >
          <LiveDot done={false} />
          <AvatarStack count={total} />
          <span className="flex-1 whitespace-nowrap font-semibold text-text sm:flex-none">
            {runningRows.length} {runningRows.length === 1 ? "agent" : "agents"} running
          </span>
          {doneRows.length > 0 && <span className="whitespace-nowrap text-text-3">· {doneRows.length} done</span>}
          <span className="hidden min-w-0 flex-1 truncate text-text-3 sm:block">
            — <b className="font-medium text-text-2">{lead.name}</b>
            {!!lead.step && <> · <span className="font-mono">{lead.step}</span></>}
          </span>
          <ChevronUp
            className={cn("size-3.5 shrink-0 text-text-3 transition-transform motion-reduce:transition-none", open && "rotate-180")}
          />
        </button>
      )}

      {!single && open && (
        // 44px rows: three of them and the list stops growing.
        <ul id={listId} className="max-h-[140px] list-none overflow-y-auto overscroll-contain px-2 pb-2">
          {views.map((v) => (
            <li key={v.row.key}>
              <button
                type="button"
                onClick={() => openView(v)}
                className="flex w-full min-h-11 items-center gap-2.5 rounded-xl px-2 py-1 text-left text-text transition-colors can-hover:hover:bg-panel-2"
                title={`Open ${v.name}'s session`}
              >
                <LiveDot done={!!v.row.done} />
                <span className="flex min-w-0 flex-1 flex-col gap-px">
                  <span className={cn("truncate text-[13px] font-medium", v.row.done && "text-text-2")}>{v.name}</span>
                  <span className={cn("truncate font-mono text-[11px]", v.row.failed ? "text-error" : "text-text-3")}>
                    {v.row.failed ? "Failed" : v.row.done ? "Finished" : v.step ?? "Starting…"}
                  </span>
                </span>
                {!!v.elapsed && <span className="shrink-0 font-mono text-[11px] text-text-3">{v.elapsed}</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Pulsing dot while running; a still grey one once finished. */
function LiveDot({ done }: { done: boolean }) {
  return (
    <span className="relative flex size-2 shrink-0">
      {!done && <span className="absolute inline-flex size-full animate-ping rounded-full bg-success opacity-55 motion-reduce:animate-none" />}
      <span className={cn("relative inline-flex size-2 rounded-full", done ? "bg-text-3" : "bg-success")} />
    </span>
  );
}

function AvatarStack({ count }: { count: number }) {
  const shown = Math.min(count, MAX_AVATARS);
  return (
    <span className="flex shrink-0 items-center" aria-hidden="true">
      {Array.from({ length: shown }, (_, i) => (
        <span
          key={i}
          className="-ml-1.5 grid size-5 place-items-center rounded-full border-2 border-panel bg-accent-2/15 text-accent-2 first:ml-0"
        >
          <Bot className="size-3" />
        </span>
      ))}
      {count > MAX_AVATARS && (
        <span className="-ml-1.5 grid size-5 place-items-center rounded-full border-2 border-panel bg-panel-2 text-[10px] font-semibold text-text-2">
          +{count - MAX_AVATARS}
        </span>
      )}
    </span>
  );
}

/** Re-render once a second while something runs, so elapsed times keep counting. */
function useElapsedTick(active: boolean): void {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, [active]);
}
