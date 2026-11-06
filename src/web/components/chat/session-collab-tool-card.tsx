/**
 * The card for the `ppm-sessions` tools: which session was created or messaged, whether the AI is
 * still waiting for it to answer, the answer once it came (or why none did), and an Open button
 * that takes the user to that session. `session_status` lists each session it asked about.
 */
import { useState } from "react";
import { CheckCircle2, ChevronDown, ChevronRight, Loader2, MessageSquare, Search, UserPlus, XCircle } from "@/lib/icons";
import { cn } from "@/lib/utils";
import { useSessionListStore } from "@/stores/session-list-store";
import { openLinkedSession, providerLabel } from "@/lib/session-collab-client";
import {
  sessionCollabToolResult, sessionStatusText, waitEndedText, type SessionCollabToolCall,
} from "@/lib/session-collab-tool-call";
import { tabToolResultText } from "@/lib/tab-tool-call";
import type { SessionStatus } from "../../../shared/session-collab";
import { MarkdownContent } from "./message-markdown";
import { ProviderBadge } from "./provider-selector";
import { useAgentSessionContext } from "./agent-session-context";

/** A session's title and provider as the session list knows them, for a target named by id only. */
function useKnownSession(sessionId: string | undefined): { title?: string; providerId?: string } {
  return useSessionListStore((s) => {
    if (!sessionId) return EMPTY;
    for (const entry of Object.values(s.byProject)) {
      const hit = entry.sessions.find((x) => x.id === sessionId);
      if (hit) return hit;
    }
    return EMPTY;
  });
}
const EMPTY: { title?: string; providerId?: string } = {};

export function SessionCollabToolCard({ call, toolUseId, output, isError, done, projectName }: {
  call: SessionCollabToolCall;
  toolUseId?: string;
  output?: string;
  isError: boolean;
  done: boolean;
  projectName?: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const chat = useAgentSessionContext();
  const project = chat?.projectName || projectName || "";
  const result = output === undefined || isError ? null : sessionCollabToolResult(output);
  const rawText = output === undefined ? "" : tabToolResultText(output);

  const targetId = call.tool === "create_session" ? result?.sessionId : call.tool === "send_to_session" ? call.sessionId : undefined;
  const known = useKnownSession(targetId);
  const title = result?.title ?? known.title ?? (call.tool === "create_session" ? call.title : undefined);
  const providerId = result?.providerId ?? known.providerId ?? (call.tool === "create_session" ? call.provider : undefined) ?? chat?.providerId;
  const waiting = !done && !isError && call.tool !== "session_status" && call.wait;
  const reply = result?.reply;

  const verb = call.tool === "create_session" ? "Created" : call.tool === "send_to_session" ? "Message to" : "Session status";
  const Icon = call.tool === "create_session" ? UserPlus : call.tool === "send_to_session" ? MessageSquare : Search;
  const open = (sessionId: string, provider: string | undefined, name?: string, turnId?: string) =>
    void openLinkedSession({ projectName: project, providerId: provider ?? "", sessionId, title: name, turnId });

  return (
    <div data-tool-ref={toolUseId} data-session-collab-card={call.tool} className="rounded-[11px] border border-info/30 overflow-hidden text-xs bg-panel">
      <div className="flex items-center min-w-0">
        <button
          type="button"
          onClick={() => setExpanded(!expanded)}
          aria-expanded={expanded}
          className="flex items-center gap-2.5 px-2.5 py-2 flex-1 min-w-0 text-left can-hover:hover:bg-panel-2/40 transition-colors max-md:min-h-11"
        >
          <span className="inline-flex items-center justify-center size-6 rounded-[7px] shrink-0 bg-info/15 text-info">
            <Icon className="size-3.5" />
          </span>
          <span className="flex min-w-0 items-center gap-1.5 text-text font-medium">
            <span className="shrink-0">{verb}</span>
            {call.tool !== "session_status" && title && <span className="min-w-0 truncate text-text-subtle">{title}</span>}
            {call.tool !== "session_status" && providerId && <ProviderBadge providerId={providerId} />}
            {call.tool === "session_status" && result?.sessions && (
              <span className="text-text-subtle">· {result.sessions.length} {result.sessions.length === 1 ? "session" : "sessions"}</span>
            )}
          </span>
          <span className="ml-auto flex items-center gap-2 shrink-0">
            {waiting && <span className="text-[10px] text-primary" data-collab-waiting="">waiting for reply…</span>}
            {reply?.replied && <span className="text-[10px] text-success">replied</span>}
            {reply && !reply.replied && <span className="text-[10px] text-warning">no reply</span>}
            {isError
              ? <XCircle className="size-3.5 text-error" />
              : done ? <CheckCircle2 className="size-3.5 text-success" /> : <Loader2 className="size-3.5 text-primary animate-spin" />}
            {expanded ? <ChevronDown className="size-3 text-text-3" /> : <ChevronRight className="size-3 text-text-3" />}
          </span>
        </button>
        {targetId && (
          <button
            type="button"
            onClick={() => open(targetId, providerId, title)}
            title={`Open ${title ?? "the session"}`}
            className="shrink-0 mr-1 px-2.5 h-7 rounded-md text-primary font-medium can-hover:hover:bg-accent-wash transition-colors max-md:h-11 max-md:min-w-11"
          >
            Open session
          </button>
        )}
      </div>
      {isError && rawText && <p className="px-2.5 pb-2 text-error whitespace-pre-wrap break-words select-text">{rawText}</p>}
      {reply && !reply.replied && <p className="px-2.5 pb-2 text-text-subtle" data-collab-no-reply={reply.reason}>{waitEndedText(reply.reason)}</p>}
      {reply?.replied && (
        <ReplyBlock text={reply.text} projectName={project}
          onOpen={targetId ? () => open(targetId, providerId, title, reply.turnId) : undefined} />
      )}
      {expanded && (
        <div className="px-2.5 pb-2 space-y-1.5 select-text">
          {call.tool === "create_session" && call.task && <Excerpt label="Task" text={call.task} />}
          {call.tool === "send_to_session" && call.message && <Excerpt label="Message" text={call.message} />}
          {result?.status && call.tool !== "session_status" && <StatusLine status={result.status} />}
          {result?.sessions?.map((s) => (
            <StatusLine key={s.sessionId} status={s} onOpen={() => open(s.sessionId, s.providerId, s.title)} />
          ))}
          {!result && !isError && rawText && <pre className="max-h-60 overflow-auto whitespace-pre-wrap break-words font-mono text-text-subtle">{rawText}</pre>}
        </div>
      )}
    </div>
  );
}

/** The other session's answer: two lines until opened. */
function ReplyBlock({ text, projectName, onOpen }: { text: string; projectName: string; onOpen?: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="mx-2.5 mb-2 rounded-md border border-border bg-background/60 px-2 py-1.5" data-collab-reply="">
      <div className={cn("text-text-secondary break-words select-text", !open && "line-clamp-2")}>
        <MarkdownContent content={text} projectName={projectName} rawHtml={false} />
      </div>
      <div className="mt-1 flex gap-3">
        <button type="button" onClick={() => setOpen(!open)} className="min-h-11 md:min-h-0 text-primary/80 can-hover:hover:text-primary">
          {open ? "Show less" : "Show reply"}
        </button>
        {onOpen && (
          <button type="button" onClick={onOpen} className="min-h-11 md:min-h-0 text-primary/80 can-hover:hover:text-primary">
            Open the turn that replied
          </button>
        )}
      </div>
    </div>
  );
}

function Excerpt({ label, text }: { label: string; text: string }) {
  return (
    <div>
      <p className="text-text-3">{label}</p>
      <p className="whitespace-pre-wrap break-words text-text-secondary line-clamp-6">{text}</p>
    </div>
  );
}

function StatusLine({ status, onOpen }: { status: SessionStatus; onOpen?: () => void }) {
  const body = (
    <>
      <ProviderBadge providerId={status.providerId} />
      <span className="min-w-0 truncate font-medium text-text">{status.title}</span>
      <span className="shrink-0 text-text-subtle">· {sessionStatusText(status)}</span>
      {status.unreadReplies > 0 && <span className="shrink-0 text-info">· {status.unreadReplies} unread</span>}
    </>
  );
  if (!onOpen) {
    return <p className="flex min-w-0 items-center gap-1.5" title={providerLabel(status.providerId)}>{body}</p>;
  }
  return (
    <button type="button" onClick={onOpen} className="flex w-full min-w-0 items-center gap-1.5 rounded-md text-left max-md:min-h-11 can-hover:hover:bg-panel-2/40">
      {body}
    </button>
  );
}
