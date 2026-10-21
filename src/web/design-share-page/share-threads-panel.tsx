import { useState } from "react";
import { ChevronDown, ChevronRight, MessageSquare, X } from "@/lib/icons";
import type { PinStatus } from "../components/design/comments/use-comment-pins";
import { pinStatusText, type GuestThread } from "./share-thread-model";
import { Byline } from "./share-entry";
import { buttonQuiet, cx } from "./share-ui";

/**
 * The list of a link's threads: open ones numbered like their pins, resolved ones folded
 * under "Resolved (n)". Who the reviewer is, and the way to change it, sits at the top.
 */

function ThreadRow({ thread, number, status, active, onOpen }: {
  thread: GuestThread;
  number: number | null;
  status: PinStatus;
  active: boolean;
  onOpen: () => void;
}) {
  const note = pinStatusText(status, number, !!thread.resolvedAt);
  return (
    <li>
      <button type="button" onClick={onOpen} aria-current={active ? "true" : undefined}
        className={cx("flex min-h-11 w-full items-start gap-3 px-4 py-3 text-left active:bg-panel-2 can-hover:hover:bg-panel-2",
          active && "bg-panel-2")}>
        <span className={cx("mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold",
          number === null ? "bg-panel-2 text-text-3" : "bg-primary text-primary-fg")} aria-hidden="true">
          {number ?? "✓"}
        </span>
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex min-w-0 items-center gap-2"><Byline author={thread.author} /></span>
          <span className="line-clamp-2 whitespace-pre-wrap break-words text-sm text-text-2">{thread.body}</span>
          <span className="text-xs text-text-3">
            {thread.replies.length === 1 ? "1 reply" : `${thread.replies.length} replies`}
            {note && note !== `Pin ${number}` ? ` · ${note}` : ""}
          </span>
        </span>
      </button>
    </li>
  );
}

export function ShareThreadsPanel({ open, resolved, numbers, statusOf, activeId, name, expiryText, onOpen, onChangeName, onClose }: {
  open: GuestThread[];
  resolved: GuestThread[];
  numbers: ReadonlyMap<string, number>;
  statusOf: (id: string) => PinStatus;
  activeId: string | null;
  name: string | null;
  expiryText: string | null;
  onOpen: (id: string) => void;
  onChangeName: () => void;
  onClose?: () => void;
}) {
  const [showResolved, setShowResolved] = useState(false);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-border py-1 pl-4 pr-2">
        <h2 className="flex-1 text-sm font-semibold">Comments ({open.length})</h2>
        {onClose && (
          <button type="button" className={buttonQuiet} onClick={onClose} aria-label="Close comments">
            <X className="size-5" />
          </button>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-2 px-4 py-2 text-xs text-text-2">
        <span className="min-w-0 flex-1 truncate">{name ? `Commenting as ${name}` : "You will be asked for a name when you first write"}</span>
        {name && <button type="button" className={cx(buttonQuiet, "text-xs")} onClick={onChangeName}>Change name</button>}
      </div>
      {expiryText && <p className="shrink-0 px-4 pb-2 text-xs text-text-3">{expiryText}</p>}
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain border-t border-border">
        {open.length === 0 && resolved.length === 0 && (
          <div className="flex flex-col items-center gap-2 px-6 py-10 text-center text-sm text-text-2">
            <MessageSquare className="size-6 text-text-3" />
            No comments yet. Choose Comment, then the part of the design you want to talk about.
          </div>
        )}
        <ul aria-label="Open comments">
          {open.map((t) => (
            <ThreadRow key={t.id} thread={t} number={numbers.get(t.id) ?? null} status={statusOf(t.id)}
              active={activeId === t.id} onOpen={() => onOpen(t.id)} />
          ))}
        </ul>
        {resolved.length > 0 && (
          <div className="border-t border-border">
            <button type="button" className={cx(buttonQuiet, "w-full justify-start rounded-none px-4")}
              aria-expanded={showResolved} onClick={() => setShowResolved((v) => !v)}>
              {showResolved ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />} Resolved ({resolved.length})
            </button>
            {showResolved && (
              <ul aria-label="Resolved comments">
                {resolved.map((t) => (
                  <ThreadRow key={t.id} thread={t} number={null} status={statusOf(t.id)}
                    active={activeId === t.id} onOpen={() => onOpen(t.id)} />
                ))}
              </ul>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
