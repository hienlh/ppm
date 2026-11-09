/**
 * The sessions linked to this one — its creator, the sessions it created, and those it exchanged
 * messages with — pinned under the conversation beside the running-agents bar, each with its live
 * status and one tap to open it.
 *
 * The bar folds away to one summary line ("3 linked sessions", with a dot when one of them needs
 * the person or has a new message) and opens again with one tap; the choice is remembered on this
 * device. Open on a desktop, the chips sit in one line with a collapse button at the end. Open on
 * a phone, the summary line stays as the header and the chips list under it, capped at three rows.
 * "Stop all child sessions" shows in the open bar while any session this one created is running,
 * and asks first.
 */
import { useId, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { ChevronDown, ChevronUp, Square } from "@/lib/icons";
import { cn } from "@/lib/utils";
import { useIsMobile } from "@/hooks/use-is-mobile";
import { useLinkedSessions, type LinkedSessionView } from "@/hooks/use-linked-sessions";
import { LINKED_STATUS_TEXT } from "@/lib/linked-sessions";
import { openLinkedSession, stopChildSessions } from "@/lib/session-collab-client";
import { useSettingsStore } from "@/stores/settings-store";
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

/** The session that most wants the person's eye: one waiting on them first, then an unread answer. */
function attentionSession(linked: LinkedSessionView[]): LinkedSessionView | undefined {
  return linked.find((l) => l.status === "needs_approval") ?? linked.find((l) => l.status === "new_message");
}

export function LinkedSessionsBarView({ projectName, sessionId, linked }: {
  projectName: string;
  sessionId: string;
  linked: LinkedSessionView[];
}) {
  const isMobile = useIsMobile();
  const expandedPref = useSettingsStore((s) => s.linkedSessionsExpanded);
  const setExpanded = useSettingsStore((s) => s.setLinkedSessionsExpanded);
  const [confirming, setConfirming] = useState(false);
  const [stopping, setStopping] = useState(false);
  const listId = useId();
  const runningChildren = linked.filter((l) => l.relations.includes("child") && l.status !== "idle" && l.status !== "new_message");
  const running = linked.filter((l) => l.status === "running").length;
  const attention = attentionSession(linked);
  // Until the person chooses, a desktop has room for the chips and a phone does not.
  const expanded = expandedPref ?? !isMobile;
  const toggle = () => setExpanded(!expanded);

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

  // One tap folds or unfolds the bar: the whole line when folded, and the header on a phone.
  const summary = (
    <button
      type="button"
      onClick={toggle}
      aria-expanded={expanded}
      aria-controls={expanded ? listId : undefined}
      data-linked-sessions-toggle=""
      title={expanded ? "Hide linked sessions" : "Show linked sessions"}
      className="flex min-h-11 w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-text-2 transition-colors md:min-h-8 md:px-3.5 can-hover:hover:bg-panel-2"
    >
      {attention && (
        <span data-linked-attention={attention.status} className="flex shrink-0">
          <LinkedStatusDot status={attention.status} />
        </span>
      )}
      <span className="whitespace-nowrap font-semibold text-text">
        {linked.length} linked {linked.length === 1 ? "session" : "sessions"}
      </span>
      {running > 0 && <span className="whitespace-nowrap text-text-3">· {running} running</span>}
      {attention && <span className="sr-only">· {LINKED_STATUS_TEXT[attention.status]}</span>}
      <ChevronUp className={cn("ml-auto size-3.5 shrink-0 text-text-3 transition-transform motion-reduce:transition-none", expanded && "rotate-180")} />
    </button>
  );

  let body: ReactNode;
  if (!expanded) {
    body = summary;
  } else if (isMobile) {
    body = (
      <>
        {summary}
        <div id={listId} className="space-y-1.5 px-2 pb-2">
          <ul className="max-h-[150px] list-none space-y-1 overflow-y-auto overscroll-contain">
            {linked.map((l) => (
              <li key={l.sessionId}><LinkedSessionChip session={l} onOpen={() => openSession(l)} className="w-full" /></li>
            ))}
          </ul>
          {stopButton}
        </div>
      </>
    );
  } else {
    body = (
      <div className="flex min-w-0 items-center gap-2 px-3 py-1 md:px-3.5">
        <span className="hidden shrink-0 text-xs text-text-3 md:inline">Linked</span>
        <div id={listId} className="flex min-w-0 flex-1 gap-1.5 overflow-x-auto">
          {linked.map((l) => <LinkedSessionChip key={l.sessionId} session={l} onOpen={() => openSession(l)} className="max-w-[16rem] shrink-0" />)}
        </div>
        {stopButton}
        <button
          type="button"
          onClick={toggle}
          aria-expanded={true}
          aria-controls={listId}
          aria-label="Hide linked sessions"
          title="Hide linked sessions"
          data-linked-sessions-toggle=""
          className="flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-lg text-text-3 transition-colors md:min-h-8 md:min-w-8 can-hover:hover:bg-panel-2 can-hover:hover:text-text"
        >
          <ChevronDown className="size-3.5" />
        </button>
      </div>
    );
  }

  return (
    <div className="shrink-0 border-t border-border bg-panel" data-linked-sessions-bar={expanded ? "expanded" : "collapsed"}>
      {body}
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
