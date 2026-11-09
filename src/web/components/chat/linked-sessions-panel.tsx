/**
 * The Sessions tab of the footer's activity chip: the sessions linked to this one — its creator,
 * the sessions it created, the sessions it messaged — grouped by how they are linked, each one tap
 * from being opened.
 *
 * Every row ends in an unlink button, always visible (no hover-only control on a phone). Unlinking
 * only hides a session from this chat's list; it never stops or deletes it, which is why a session
 * still running or waiting on the person cannot be unlinked — it would take live work out of sight.
 * "Unlink idle & done" hides every finished one at once. After any unlink an Undo bar stays for six
 * seconds, and the hidden sessions sit folded under "Unlinked" at the bottom, each with Relink.
 *
 * "Stop all child sessions" sits at the foot only while a session this one created is running, and
 * asks inline before it stops anything; a stopped child becomes idle and can then be unlinked.
 */
import { Fragment, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { ChevronDown, Link, Link2Off, RotateCcw, Square } from "@/lib/icons";
import { cn } from "@/lib/utils";
import type { LinkedSessionGroups, LinkedSessionView } from "@/hooks/use-linked-sessions";
import { LINKED_STATUS_TEXT, RELATION_TEXT } from "@/lib/linked-sessions";
import { openLinkedSession, stopChildSessions } from "@/lib/session-collab-client";
import { canUnlink } from "../../../shared/linked-session-unlinks";
import type { SessionLinkRelation } from "../../../shared/session-collab";
import { LinkedStatusDot } from "./linked-session-chip";
import { ProviderBadge } from "./provider-selector";
import { StopChildSessionsConfirm } from "./stop-child-sessions-confirm";
import { FooterButton, FooterPopoverFooter } from "./footer-popover";
import { FoldGroup } from "./switch-account-view";

/** How long the Undo bar stays after an unlink. */
export const UNDO_MS = 6000;
/** How long a row takes to slide out before it moves to Unlinked. */
const LEAVE_MS = 180;

/** A session that this one created and that is still doing something. */
export function isRunningChild(l: LinkedSessionView): boolean {
  return l.relations.includes("child") && l.status !== "idle" && l.status !== "new_message";
}

const GROUP_ORDER: SessionLinkRelation[] = ["parent", "child", "messaged"];

export function LinkedSessionsPanel({ projectName, sessionId, groups, onOpened }: {
  projectName: string;
  sessionId: string;
  groups: LinkedSessionGroups;
  /** A session was opened from the list: the popover has done its job. */
  onOpened: () => void;
}) {
  const { visible, hidden, unlink, relink } = groups;
  const [confirming, setConfirming] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [leaving, setLeaving] = useState<ReadonlySet<string>>(new Set());
  const [arriving, setArriving] = useState<ReadonlySet<string>>(new Set());
  const [undo, setUndo] = useState<{ ids: string[]; text: string } | null>(null);
  const [unlinkedOpen, setUnlinkedOpen] = useState(false);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  /** Rows still sliding out: closing the popover mid-slide must not lose their unlink. */
  const pending = useRef<string[]>([]);
  const unlinkRef = useRef(unlink);
  unlinkRef.current = unlink;
  useEffect(() => () => {
    for (const t of timers.current) clearTimeout(t);
    if (pending.current.length) unlinkRef.current(pending.current);
  }, []);
  const later = (fn: () => void, ms: number) => { timers.current.push(setTimeout(fn, ms)); };

  const runningChildren = visible.filter(isRunningChild);
  const finished = visible.filter((l) => canUnlink(l.status));

  const open = (l: LinkedSessionView) => {
    onOpened();
    void openLinkedSession({ projectName, providerId: l.providerId, sessionId: l.sessionId, title: l.title });
  };

  const doUnlink = (items: LinkedSessionView[]) => {
    const ids = items.filter((l) => canUnlink(l.status)).map((l) => l.sessionId);
    if (!ids.length) return;
    setLeaving(new Set(ids));
    pending.current = [...pending.current, ...ids];
    later(() => {
      pending.current = pending.current.filter((id) => !ids.includes(id));
      setLeaving(new Set());
      unlink(ids);
      setUndo({ ids, text: ids.length === 1 ? `Unlinked “${items.find((l) => l.sessionId === ids[0])!.title}”` : `Unlinked ${ids.length} sessions` });
    }, LEAVE_MS);
  };
  const doRelink = (ids: string[]) => {
    relink(ids);
    setUndo(null);
    setArriving(new Set(ids));
    later(() => setArriving(new Set()), 220);
  };
  // The bar goes after six seconds; a later unlink restarts the count.
  useEffect(() => {
    if (!undo) return;
    const t = setTimeout(() => setUndo(null), UNDO_MS);
    return () => clearTimeout(t);
  }, [undo]);

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

  // A heading with nothing under it goes too.
  const grouped = GROUP_ORDER
    .map((relation) => ({ relation, sessions: visible.filter((l) => (l.relations[0] ?? "messaged") === relation) }))
    .filter((g) => g.sessions.length > 0);

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-linked-sessions-panel="">
      <div className="max-h-64 min-h-0 overflow-y-auto overscroll-contain p-1 max-md:max-h-none max-md:flex-1">
        {grouped.length === 0 && (
          <p className="px-2 py-3 text-center text-xs text-text-3">No linked sessions shown. Unlinked ones are below.</p>
        )}
        {grouped.map((g) => (
          <Fragment key={g.relation}>
            <div className="px-2 pb-0.5 pt-2 text-[10px] font-semibold uppercase tracking-wide text-text-3">{RELATION_TEXT[g.relation]}</div>
            {g.sessions.map((l) => (
              <SessionRow
                key={l.sessionId}
                session={l}
                leaving={leaving.has(l.sessionId)}
                arriving={arriving.has(l.sessionId)}
                onOpen={() => open(l)}
                action={canUnlink(l.status)
                  ? { kind: "unlink", onClick: () => doUnlink([l]) }
                  : { kind: "busy" }}
              />
            ))}
          </Fragment>
        ))}
      </div>

      {!confirming && (finished.length > 0 || runningChildren.length > 0) && (
        <FooterPopoverFooter>
          {finished.length > 0 && (
            <FooterButton onClick={() => doUnlink(finished)} data-unlink-finished="">
              <Link2Off />
              Unlink idle &amp; done <span className="tabular-nums">({finished.length})</span>
            </FooterButton>
          )}
          {runningChildren.length > 0 && (
            <FooterButton variant="danger" onClick={() => setConfirming(true)} className="ml-auto">
              <Square />
              Stop all child sessions
            </FooterButton>
          )}
        </FooterPopoverFooter>
      )}
      {confirming && (
        <StopChildSessionsConfirm
          titles={runningChildren.map((l) => l.title)}
          busy={stopping}
          onConfirm={() => void stopAll()}
          onCancel={() => setConfirming(false)}
        />
      )}

      {undo && (
        <div role="status" data-undo-bar="" className="footer-pop-in mx-2 mb-2 mt-1 flex items-center gap-2 rounded-lg bg-surface-hover py-1 pl-2.5 pr-1 text-xs text-text max-md:text-sm">
          <span className="min-w-0 flex-1 truncate">{undo.text}</span>
          <FooterButton onClick={() => doRelink(undo.ids)} className="font-medium !text-primary">
            <RotateCcw />
            Undo
          </FooterButton>
        </div>
      )}

      {hidden.length > 0 && (
        <div className="shrink-0 border-t border-border-soft p-1">
          <button
            type="button"
            onClick={() => setUnlinkedOpen(!unlinkedOpen)}
            aria-expanded={unlinkedOpen}
            data-unlinked-toggle=""
            className="flex min-h-[34px] w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-[13px] text-text can-hover:hover:bg-surface-hover max-md:min-h-11 max-md:text-sm"
          >
            <Link2Off className="size-4 text-text-3" />
            Unlinked
            <span className="ml-auto inline-flex items-center gap-1.5 text-[11px] tabular-nums text-text-3">
              {hidden.length}
              <ChevronDown className={cn("size-3 transition-transform duration-150 motion-reduce:transition-none", unlinkedOpen && "rotate-180")} />
            </span>
          </button>
          <FoldGroup open={unlinkedOpen}>
            <div className="max-h-40 overflow-y-auto overscroll-contain max-md:max-h-none">
              {hidden.map((l) => (
                <SessionRow key={l.sessionId} session={l} dim onOpen={() => open(l)} action={{ kind: "relink", onClick: () => doRelink([l.sessionId]) }} />
              ))}
            </div>
          </FoldGroup>
        </div>
      )}
    </div>
  );
}

type RowAction = { kind: "unlink"; onClick: () => void } | { kind: "relink"; onClick: () => void } | { kind: "busy" };

function SessionRow({ session: l, action, onOpen, leaving, arriving, dim }: {
  session: LinkedSessionView;
  action: RowAction;
  onOpen: () => void;
  leaving?: boolean;
  arriving?: boolean;
  /** An unlinked row: its status no longer matters here, so it reads quieter. */
  dim?: boolean;
}) {
  const title = action.kind === "relink" ? `Relink — show “${l.title}” in this chat again`
    : action.kind === "unlink" ? `Unlink — hide “${l.title}” from this chat`
    : "Still working — stop it before unlinking";
  return (
    <div
      data-linked-session={l.sessionId}
      data-linked-status={l.status}
      className={cn(
        "flex items-center gap-0.5 rounded-md transition-[opacity,transform] duration-200 motion-reduce:transition-none",
        leaving && "translate-x-4 opacity-0",
        arriving && "footer-from-right",
      )}
    >
      <button
        type="button"
        onClick={onOpen}
        title={l.title}
        className="flex min-h-[34px] min-w-0 flex-1 items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-[13px] transition-[background-color,transform] duration-150 motion-safe:active:scale-[0.97] can-hover:hover:bg-surface-hover max-md:min-h-11 max-md:text-sm"
      >
        {dim ? <span className="size-2 shrink-0 rounded-full bg-text-3" aria-hidden="true" /> : <LinkedStatusDot status={l.status} />}
        {l.providerId ? <ProviderBadge providerId={l.providerId} size="sm" /> : <span className="size-3.5 shrink-0" />}
        <span className={cn("min-w-0 flex-1 truncate", dim && "text-text-2")}>{l.title}</span>
        <span className={cn("shrink-0 text-[11px]", l.status === "needs_approval" && !dim ? "text-error" : "text-text-3")}>
          {LINKED_STATUS_TEXT[l.status]}
        </span>
      </button>
      <button
        type="button"
        // aria-disabled rather than disabled: a disabled button shows no tooltip in every browser,
        // and the tooltip is what says why this one cannot be unlinked yet.
        onClick={action.kind === "busy" ? undefined : action.onClick}
        aria-disabled={action.kind === "busy" || undefined}
        aria-label={action.kind === "relink" ? `Relink ${l.title}` : `Unlink ${l.title}`}
        title={title}
        data-unlink-action={action.kind}
        className="grid size-8 shrink-0 place-items-center rounded-md text-text-3 transition-[background-color,color,transform] duration-150 motion-safe:active:scale-[0.97] can-hover:hover:bg-surface-hover can-hover:hover:text-text aria-disabled:cursor-not-allowed aria-disabled:opacity-35 aria-disabled:active:scale-100 aria-disabled:can-hover:hover:bg-transparent [@media(hover:none)]:size-11"
      >
        {action.kind === "relink" ? <Link className="size-3.5" /> : <Link2Off className="size-3.5" />}
      </button>
    </div>
  );
}
