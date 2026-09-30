/**
 * Floating-window body replaying one agent's or teammate's work session, live.
 *
 * Generalised from the old team-member-only window: any card (an Agent/Task tool call) or
 * named teammate streams through the same hub subscription (`useAgentSessionStream`), so a
 * running background agent, a resumed SendMessage teammate and an old finished session all
 * render through the same steps view. Nested Agent rows inside the stream stay expanded
 * inline — `variant="window"` on `SubagentChildren` is what stops a nested Agent card from
 * trying to open a second window for work this window is already the live view of.
 */
import { useMemo, useState } from "react";
import { ChevronDown, ChevronRight, Loader2 } from "@/lib/icons";
import { cn } from "@/lib/utils";
import { useAgentSessionStream } from "@/hooks/use-agent-session-stream";
import { usePrefersCoarsePointer } from "@/components/os-explorer/use-coarse-long-press";
import { fallbackKey, useAgentSessionFallbackStore } from "./agent-session-fallback-store";
import type { WindowContentProps } from "@/components/floating-window/window-content-registry";
import type { AgentTranscriptProviderId, AgentTranscriptSourceKind } from "../../../shared/agent-transcript-protocol";
import type { ChatEvent } from "../../../types/chat";
import { SubagentChildren } from "./tool-cards";

/** Payload a window or sheet opens an agent/teammate session with — the identity the hub
 *  subscribes on, plus display-only extras the opener already knows. */
export interface AgentSessionWindowPayload {
  projectName: string;
  providerId: AgentTranscriptProviderId;
  sessionId: string;
  source: AgentTranscriptSourceKind;
  /** Window/sheet title — the opener names it (member handle, card description, …). */
  title?: string;
  /** The Agent/Task tool call's own prompt, shown as a collapsible header for a card source. */
  prompt?: string;
}

function stepCount(events: ChatEvent[]): number {
  return events.filter((e) => e.type === "tool_use").length;
}

type Status = "loading" | "running" | "failed" | "done";

function StatusBadge({ status }: { status: Status }) {
  if (status === "loading") return null;
  if (status === "running") {
    return (
      <span className="flex items-center gap-1 text-[10px] text-primary shrink-0">
        <Loader2 className="size-2.5 animate-spin" /> running
      </span>
    );
  }
  if (status === "failed") return <span className="text-[10px] text-error shrink-0">failed</span>;
  return <span className="text-[10px] text-success shrink-0">done</span>;
}

export default function AgentSessionWindowContent({ payload }: WindowContentProps) {
  const p = (payload ?? {}) as unknown as AgentSessionWindowPayload;
  const key = p.sessionId ? fallbackKey(p.sessionId, p.source) : "";
  const fallbackEvents = useAgentSessionFallbackStore((s) => (key ? s.entries[key] : undefined));
  const { events, available, running, loading, error } = useAgentSessionStream({
    projectName: p.projectName,
    providerId: p.providerId,
    sessionId: p.sessionId,
    source: p.source,
    fallbackEvents,
  });
  const [promptOpen, setPromptOpen] = useState(false);
  // Touch needs the 44px minimum even at desktop window width; a mouse does not.
  const coarse = usePrefersCoarsePointer();

  const steps = useMemo(() => stepCount(events), [events]);
  // Best-effort only: the transcript carries no explicit terminal marker of its own, so a
  // stream that stopped ("running" went false) on an error result is read as failed.
  const tail = events[events.length - 1];
  const tailFailed = !running && !!tail && tail.type === "tool_result" && !!tail.isError;
  const status: Status = loading ? "loading" : running ? "running" : tailFailed ? "failed" : "done";

  return (
    <div className="flex flex-col h-full min-h-0 bg-surface @container">
      <div className="flex items-center gap-2 px-3 py-1.5 border-b border-border/30 shrink-0">
        <span className="truncate text-xs font-medium">{p.title ?? "Agent session"}</span>
        {events.length > 0 && <span className="text-[10px] text-text-subtle shrink-0">{steps} steps</span>}
        <StatusBadge status={status} />
        {!available && !loading && (
          <span
            className="ml-auto text-[10px] text-text-subtle shrink-0"
            title="No live transcript for this session — showing steps already held in memory"
          >
            offline
          </span>
        )}
      </div>

      {!!p.prompt && (
        <div className="border-b border-border/30 shrink-0">
          <button
            type="button"
            onClick={() => setPromptOpen((v) => !v)}
            className={cn(
              "flex w-full items-center gap-1.5 px-3 py-1.5 text-[11px] text-text-subtle hover:text-foreground",
              coarse ? "min-h-[44px]" : "min-h-[28px]",
            )}
          >
            {promptOpen ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
            Prompt
          </button>
          {promptOpen && (
            <div className="px-3 pb-2 text-[11px] text-text-secondary whitespace-pre-wrap select-text">
              {p.prompt}
            </div>
          )}
        </div>
      )}

      {loading && events.length === 0 ? (
        <div className="flex-1 flex items-center justify-center gap-2 text-xs text-text-subtle">
          <Loader2 className="size-3 animate-spin" />
          Loading session…
        </div>
      ) : events.length === 0 ? (
        <div className="flex-1 flex items-center justify-center text-xs text-text-subtle px-4 text-center">
          {error ? "Could not load this session" : "No recorded steps"}
        </div>
      ) : (
        <SubagentChildren
          events={events}
          projectName={p.projectName}
          variant="window"
          className="flex-1 min-h-0 overflow-y-auto px-3 py-2 space-y-1"
        />
      )}
    </div>
  );
}
