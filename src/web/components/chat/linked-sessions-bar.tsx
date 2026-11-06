/**
 * The sessions linked to this one — its creator, the sessions it created, and those it exchanged
 * messages with — pinned under the conversation beside the running-agents bar, each with its live
 * status and one tap to open it.
 *
 * On a desktop the chips sit in one line. On a phone more than one collapses into a summary line,
 * as the agents bar does, that opens a list capped at three rows. "Stop all child sessions" shows
 * while any session this one created is running, and asks first.
 */
import { useEffect, useId, useState } from "react";
import { toast } from "sonner";
import { ChevronUp, Square } from "@/lib/icons";
import { cn } from "@/lib/utils";
import { useIsMobile } from "@/hooks/use-is-mobile";
import { useLinkedSessions, type LinkedSessionView } from "@/hooks/use-linked-sessions";
import { openLinkedSession, stopChildSessions } from "@/lib/session-collab-client";
import type { ChatMessage } from "../../../types/chat";
import { LinkedSessionChip, LinkedStatusDot } from "./linked-session-chip";
import { StopChildSessionsConfirm } from "./stop-child-sessions-confirm";

export function LinkedSessionsBar({ projectName, sessionId, messages }: {
  projectName: string;
  sessionId: string | null;
  messages: ChatMessage[];
}) {
  const linked = useLinkedSessions(projectName, sessionId, messages);
  return sessionId && linked.length > 0
    ? <LinkedSessionsBarView projectName={projectName} sessionId={sessionId} linked={linked} />
    : null;
}

export function LinkedSessionsBarView({ projectName, sessionId, linked }: {
  projectName: string;
  sessionId: string;
  linked: LinkedSessionView[];
}) {
  const isMobile = useIsMobile();
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [stopping, setStopping] = useState(false);
  const listId = useId();
  const runningChildren = linked.filter((l) => l.relations.includes("child") && l.status !== "idle" && l.status !== "new_message");
  const running = linked.filter((l) => l.status === "running").length;
  const collapse = isMobile && linked.length > 1;
  useEffect(() => { if (!collapse) setOpen(false); }, [collapse]);

  const openSession = (l: LinkedSessionView) =>
    void openLinkedSession({ projectName, providerId: l.providerId, sessionId: l.sessionId, title: l.title });

  const stopAll = async () => {
    setStopping(true);
    try {
      await stopChildSessions(projectName, sessionId);
      setConfirming(false);
    } catch (e) {
      toast.error("Could not stop the child sessions", { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setStopping(false);
    }
  };

  const stopButton = runningChildren.length > 0 && (
    <button
      type="button"
      onClick={() => setConfirming(true)}
      className="flex min-h-11 shrink-0 items-center gap-1.5 rounded-lg px-2 text-xs font-medium text-error transition-colors md:min-h-8 can-hover:hover:bg-error/10"
    >
      <Square className="size-3.5" />
      Stop all child sessions
    </button>
  );
  const lead = linked.find((l) => l.status === "needs_approval") ?? linked[0]!;

  return (
    <div className="shrink-0 border-t border-border bg-panel" data-linked-sessions-bar="">
      {collapse ? (
        <button
          type="button"
          onClick={() => setOpen(!open)}
          aria-expanded={open}
          aria-controls={open ? listId : undefined}
          className="flex min-h-11 w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-text-2"
        >
          <LinkedStatusDot status={lead.status} />
          <span className="whitespace-nowrap font-semibold text-text">{linked.length} linked sessions</span>
          {running > 0 && <span className="whitespace-nowrap text-text-3">· {running} running</span>}
          <ChevronUp className={cn("ml-auto size-3.5 shrink-0 text-text-3 transition-transform motion-reduce:transition-none", open && "rotate-180")} />
        </button>
      ) : (
        <div className="flex min-w-0 items-center gap-2 px-3 py-1 md:px-3.5">
          <span className="hidden shrink-0 text-xs text-text-3 md:inline">Linked</span>
          <div className="flex min-w-0 flex-1 gap-1.5 overflow-x-auto">
            {linked.map((l) => <LinkedSessionChip key={l.sessionId} session={l} onOpen={() => openSession(l)} className="max-w-[16rem] shrink-0" />)}
          </div>
          {stopButton}
        </div>
      )}
      {collapse && open && (
        <div id={listId} className="space-y-1.5 px-2 pb-2">
          <ul className="max-h-[150px] list-none space-y-1 overflow-y-auto overscroll-contain">
            {linked.map((l) => (
              <li key={l.sessionId}><LinkedSessionChip session={l} onOpen={() => openSession(l)} className="w-full" /></li>
            ))}
          </ul>
          {stopButton}
        </div>
      )}
      {confirming && (
        <StopChildSessionsConfirm
          titles={runningChildren.map((l) => l.title)}
          busy={stopping}
          onConfirm={() => void stopAll()}
          onCancel={() => setConfirming(false)}
        />
      )}
    </div>
  );
}
