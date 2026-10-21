import { useState } from "react";
import { toast } from "sonner";
import { ArrowLeft, CheckCircle, Pencil, RotateCcw, Send, Trash2 } from "@/lib/icons";
import { Button } from "@/components/ui/button";
import { formatRelativeDate } from "@/lib/format-date";
import type { DesignCommentOwnerView } from "../../../../shared/design-comment-thread-types";
import { PIN_STATUS_LABEL, type PinStatus } from "./use-comment-pins";
import { CommentAuthorLabel, isReviewer } from "./comment-author-label";
import { CommentThreadReplies, type ThreadReplyActions } from "./comment-thread-replies";
import { CommentThreadTextBox } from "./comment-thread-text-box";

/**
 * One thread, in the comments panel's place (beside the canvas on desktop, in its bottom
 * sheet on a phone): the comment, who wrote it and through which link, its replies, a reply
 * box, and the thread's actions at the bottom, in the thumb zone. The owner edits only their
 * own comment. A reviewer's thread can also take every thread from the same link with it,
 * which asks once more first.
 */

export interface ThreadActions extends ThreadReplyActions {
  onBack: () => void;
  onEditBody: (body: string) => Promise<void>;
  onResolve: (resolved: boolean) => void;
  onSend: () => void;
  onDelete: () => void;
  onDeleteLinkThreads: (linkId: string) => Promise<void>;
}

export function CommentThreadView({ thread, number, status, actions, focusReply }: {
  thread: DesignCommentOwnerView;
  /** The pin's number while the thread is open, null once resolved. */
  number: number | null;
  status: PinStatus | null;
  actions: ThreadActions;
  focusReply?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [confirmLink, setConfirmLink] = useState(false);
  const author = thread.author;
  const label = status ? PIN_STATUS_LABEL[status] : undefined;
  const deleteLinkThreads = (linkId: string) => {
    actions.onDeleteLinkThreads(linkId)
      .then(actions.onBack)
      .catch((e) => toast.error("Could not delete those threads", { description: (e as Error).message }));
  };

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="comment-thread" data-thread-id={thread.id}>
      <div className="flex h-11 shrink-0 items-center gap-1 border-b border-border px-1 md:h-9">
        <button type="button" onClick={actions.onBack} aria-label="Back to comments"
          className="flex min-h-11 items-center gap-1 rounded-md px-2 text-xs font-semibold text-text-subtle hover:bg-surface-elevated md:min-h-7">
          <ArrowLeft className="size-4" /> Comments
        </button>
        <span className="flex-1" />
        {number !== null && (
          <span className="mr-2 flex size-5 items-center justify-center rounded-full bg-primary text-[11px] font-semibold text-primary-foreground">{number}</span>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        <div className="flex min-w-0 items-baseline gap-1 text-xs text-text-2">
          <CommentAuthorLabel author={author} />
          <span className="shrink-0 text-text-subtle">· {formatRelativeDate(thread.createdAt)}</span>
        </div>
        <div className="mt-0.5 truncate text-xs text-text-subtle">
          &lt;{thread.anchor.tag}&gt; in {thread.file}
          {label && <> · <span className={status === "detached" ? "text-warning" : undefined}>{label}</span></>}
          {thread.resolvedAt && " · Resolved"}
          {thread.sentAt && " · Sent"}
        </div>
        {editing ? (
          <div className="mt-2">
            <CommentThreadTextBox label="Edit your comment" initial={thread.body} placeholder="What should change here?" submitLabel="Save"
              autoFocus onCancel={() => setEditing(false)}
              onSubmit={async (body) => { await actions.onEditBody(body); setEditing(false); }} />
          </div>
        ) : (
          <p className="mt-2 whitespace-pre-wrap break-words text-sm leading-relaxed">{thread.body}</p>
        )}
        {!editing && !isReviewer(author) && (
          <button type="button" onClick={() => setEditing(true)}
            className="mt-1 flex min-h-11 items-center gap-1 rounded-md px-2 text-xs text-text-subtle hover:bg-surface-elevated md:min-h-7">
            <Pencil className="size-3.5" /> Edit
          </button>
        )}
        <div className="mt-4">
          <CommentThreadReplies thread={thread} actions={actions} focusReply={focusReply} />
        </div>
      </div>
      <div className="flex shrink-0 flex-col gap-2 border-t border-border p-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]">
        {isReviewer(author) && (confirmLink ? (
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className="flex-1">Delete every thread from “{author.linkLabel}”, replies included?</span>
            <Button variant="outline" size="sm" className="min-h-11 md:min-h-8" onClick={() => setConfirmLink(false)}>Keep</Button>
            <Button variant="destructive" size="sm" className="min-h-11 md:min-h-8" onClick={() => deleteLinkThreads(author.linkId)}>Delete all</Button>
          </div>
        ) : (
          <button type="button" onClick={() => setConfirmLink(true)}
            className="min-h-11 self-start rounded-md px-2 text-xs text-text-subtle hover:text-destructive md:min-h-7">
            Delete all threads from “{author.linkLabel}”…
          </button>
        ))}
        {/* The side panel is narrow on desktop, so the primary action takes a row of its own there. */}
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" className="min-h-11 flex-1 text-destructive md:min-h-9" onClick={actions.onDelete}>
            <Trash2 className="size-4" /> Delete
          </Button>
          <Button variant="outline" className="min-h-11 flex-1 md:min-h-9" onClick={() => actions.onResolve(!thread.resolvedAt)}>
            {thread.resolvedAt ? <><RotateCcw className="size-4" /> Reopen</> : <><CheckCircle className="size-4" /> Resolve</>}
          </Button>
          <Button className="min-h-11 flex-1 md:min-h-9 md:basis-full" onClick={actions.onSend}><Send className="size-4" /> Send to AI</Button>
        </div>
      </div>
    </div>
  );
}
