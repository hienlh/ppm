import { useState } from "react";
import { toast } from "sonner";
import { Pencil, Trash2 } from "@/lib/icons";
import { formatRelativeDate } from "@/lib/format-date";
import type { DesignCommentOwnerView } from "../../../../shared/design-comment-thread-types";
import { CommentAuthorLabel, isReviewer } from "./comment-author-label";
import { CommentThreadTextBox } from "./comment-thread-text-box";

/**
 * A thread's replies, oldest first, and the box to add one. The owner may edit only their
 * own replies — a reviewer's words are theirs — but may delete any reply. Every action is an
 * inline button, visible on touch as well as with a mouse, so the thread needs no second
 * menu or sheet stacked on the one it is shown in.
 */

export interface ThreadReplyActions {
  onReply: (body: string) => Promise<void>;
  onEditReply: (replyId: string, body: string) => Promise<void>;
  onDeleteReply: (replyId: string) => Promise<void>;
}

const actionButton = "flex min-h-11 items-center gap-1 rounded-md px-2 text-xs text-text-subtle hover:bg-surface-elevated md:min-h-7";

export function CommentThreadReplies({ thread, actions, focusReply }: {
  thread: DesignCommentOwnerView;
  actions: ThreadReplyActions;
  focusReply?: boolean;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  const remove = (replyId: string) => {
    actions.onDeleteReply(replyId).catch((e) => toast.error("Could not delete the reply", { description: (e as Error).message }));
  };

  return (
    <div className="flex flex-col gap-3">
      {thread.replies.length > 0 && (
        <ol className="flex flex-col gap-3 border-l-2 border-border pl-3" aria-label="Replies">
          {thread.replies.map((r) => (
            <li key={r.id} className="flex flex-col gap-1" data-reply-id={r.id}>
              <div className="flex min-w-0 items-baseline gap-1 text-xs text-text-2">
                <CommentAuthorLabel author={r.author} />
                <span className="shrink-0 text-text-subtle">· {formatRelativeDate(r.createdAt)}</span>
              </div>
              {editing === r.id ? (
                <CommentThreadTextBox
                  label="Edit your reply"
                  initial={r.body}
                  placeholder="Your reply"
                  submitLabel="Save"
                  autoFocus
                  onCancel={() => setEditing(null)}
                  onSubmit={async (body) => { await actions.onEditReply(r.id, body); setEditing(null); }}
                />
              ) : (
                <p className="whitespace-pre-wrap break-words text-sm">{r.body}</p>
              )}
              {editing !== r.id && (
                <div className="flex gap-2">
                  {!isReviewer(r.author) && (
                    <button type="button" className={actionButton} onClick={() => setEditing(r.id)}>
                      <Pencil className="size-3.5" /> Edit
                    </button>
                  )}
                  <button type="button" className={`${actionButton} hover:text-destructive`} onClick={() => remove(r.id)}>
                    <Trash2 className="size-3.5" /> Delete
                  </button>
                </div>
              )}
            </li>
          ))}
        </ol>
      )}
      <CommentThreadTextBox
        label="Reply"
        placeholder={isReviewer(thread.author) ? `Reply to ${thread.author.name}` : "Reply"}
        submitLabel="Reply"
        autoFocus={focusReply}
        onSubmit={actions.onReply}
      />
    </div>
  );
}
