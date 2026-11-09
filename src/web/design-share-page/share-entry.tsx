import { useId, useState } from "react";
import { Pencil, ShieldCheck, Trash2 } from "@/lib/icons";
import type { CommentAuthor } from "../../shared/design-comment-types";
import { bylineOf, type RootDelete } from "./share-thread-model";
import { ShareTextForm } from "./share-composer";
import { buttonQuiet, cx, formatDateTime } from "./share-ui";

/**
 * One comment or reply: byline, time, the text, and the reviewer's own actions on it.
 *
 * Everything a reviewer or the owner wrote is rendered as a React text node and nothing
 * else — never markup, never markdown — so a body cannot become part of this page, which
 * shares its origin with PPM. The owner's byline is a badge, which no typed name can be.
 */

export function Byline({ author }: { author: CommentAuthor }) {
  const by = bylineOf(author);
  if (by.owner) {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-owner px-2 py-0.5 text-xs font-semibold text-owner-fg">
        <ShieldCheck className="size-3.5" /> Owner
      </span>
    );
  }
  return <span className="min-w-0 truncate text-sm font-semibold">{by.name}</span>;
}

export function ShareEntry({ author, createdAt, updatedAt, body, mine, onEdit, onDelete, deleteRule }: {
  author: CommentAuthor;
  createdAt: string;
  updatedAt: string;
  body: string;
  mine: boolean;
  onEdit?: (body: string) => Promise<boolean>;
  onDelete?: () => Promise<boolean>;
  /** For a thread's root; a reply is deletable whenever it is the reviewer's own. */
  deleteRule?: RootDelete | null;
}) {
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [blockedShown, setBlockedShown] = useState(false);
  const reasonId = useId();
  const blocked = deleteRule && !deleteRule.allowed ? deleteRule.reason : null;
  const canDelete = mine && onDelete && deleteRule !== null;

  return (
    <div className="flex flex-col gap-1">
      <div className="flex min-w-0 items-center gap-2">
        <Byline author={author} />
        {mine && <span className="shrink-0 text-xs text-text-3">(you)</span>}
        <span className="ml-auto shrink-0 text-xs text-text-3">
          {formatDateTime(createdAt)}{updatedAt !== createdAt ? " · edited" : ""}
        </span>
      </div>
      {editing && onEdit ? (
        <ShareTextForm submitLabel="Save" placeholder="Edit your comment" initial={body} autoFocus compact
          onCancel={() => setEditing(false)}
          onSubmit={async (next) => { const ok = await onEdit(next); if (ok) setEditing(false); return ok; }} />
      ) : (
        <p className="whitespace-pre-wrap break-words text-sm leading-relaxed text-text">{body}</p>
      )}
      {mine && !editing && (onEdit || canDelete) && (
        <div className="-ml-3 flex flex-wrap items-center gap-1">
          {onEdit && (
            <button type="button" className={buttonQuiet} onClick={() => setEditing(true)}>
              <Pencil className="size-4" /> Edit
            </button>
          )}
          {canDelete && !confirming && (
            // A blocked delete stays a working button: tapping it says why, rather than doing nothing.
            <button type="button" className={cx(buttonQuiet, blocked && "opacity-60")}
              aria-expanded={blocked ? blockedShown : undefined} aria-controls={blocked ? reasonId : undefined}
              onClick={() => (blocked ? setBlockedShown((v) => !v) : setConfirming(true))}>
              <Trash2 className="size-4" /> Delete
            </button>
          )}
          {confirming && (
            <>
              <span className="px-1 text-sm text-text-2">Delete this?</span>
              <button type="button" className={cx(buttonQuiet, "text-error")}
                onClick={async () => { const ok = await onDelete!(); if (!ok) setConfirming(false); }}>
                Delete
              </button>
              <button type="button" className={buttonQuiet} onClick={() => setConfirming(false)}>Keep</button>
            </>
          )}
        </div>
      )}
      {blocked && blockedShown && <p id={reasonId} className="text-xs text-text-2" role="status">{blocked}</p>}
    </div>
  );
}
