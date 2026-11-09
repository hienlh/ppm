import { randomBytes } from "node:crypto";
import { COMMENT_ID_RE } from "../../shared/design-comment-types.ts";
import {
  SHARE_LINK_ID_RE, type StoredCommentReply, type StoredDesignComment,
} from "../../shared/design-comment-thread-types.ts";
import { withRecoveredDesign } from "./design-restore-journal.ts";
import { readComments, writeComments } from "./comments/design-comments-store.ts";
import {
  badRequest, commentsChanged, guestOf, guestTextIsTheirs, isRaw, newAuthor, notFound, notYours, parseBody, tooMany,
} from "./comments/design-comment-input.ts";
import { isMine, isOwnerEntry, quotaRefusal, visibleToLink, type GuestIdentity } from "./comments/design-comment-views.ts";
import type { CommentWriteOptions } from "./design-comments.service.ts";

/**
 * Replies inside a comment thread, and removing every thread one share link brought in.
 *
 * Same discipline as the root comments: one design lock per change, an atomic write, and a
 * `comments_changed` event. A reviewer reaches a thread only when their link started it
 * (anything else is a 404, indistinguishable from a missing thread) and changes only their
 * own replies. The owner may reply anywhere and delete any reply, but never edits a
 * reviewer's words.
 */

export interface ReplyChange {
  thread: StoredDesignComment;
  reply: StoredCommentReply;
}

const notFoundIfBadId = (...ids: string[]): void => {
  if (ids.some((id) => !COMMENT_ID_RE.test(id))) throw notFound();
};

/** Runs `change` on one thread under the lock and writes the result back. */
async function changeThread<T>(
  projectPath: string, slug: string, threadId: string, guest: GuestIdentity | null, recheck: (() => void) | undefined,
  change: (thread: StoredDesignComment, all: StoredDesignComment[]) => { thread: StoredDesignComment; result: T },
): Promise<T> {
  const result = await withRecoveredDesign(projectPath, slug, async (designDir) => {
    recheck?.();
    const comments = await readComments(designDir);
    const index = comments.findIndex((c) => c.id === threadId && (!guest || visibleToLink(c, guest.linkId)));
    if (index < 0) throw notFound();
    const out = change(comments[index]!, comments);
    comments[index] = out.thread;
    await writeComments(designDir, comments);
    return out.result;
  });
  commentsChanged(projectPath, slug);
  return result;
}

function findReply(thread: StoredDesignComment, replyId: string): StoredCommentReply {
  const reply = thread.replies?.find((r) => r.id === replyId);
  if (!reply) throw notFound();
  return reply;
}

/** `{ body }`. Answers the thread as it now stands and the new reply. */
export async function addReply(
  projectPath: string, slug: string, threadId: string, input: unknown, opts: CommentWriteOptions = {},
): Promise<ReplyChange> {
  notFoundIfBadId(threadId);
  if (!isRaw(input)) throw badRequest("Expected a JSON object");
  const body = parseBody(input.body, true)!;
  const author = newAuthor(opts.actor);
  return changeThread(projectPath, slug, threadId, guestOf(opts.actor), opts.recheck, (thread, all) => {
    const refusal = quotaRefusal(all, author, thread);
    if (refusal) throw tooMany(refusal);
    const now = new Date().toISOString();
    const reply: StoredCommentReply = { id: randomBytes(6).toString("hex"), body, author, createdAt: now, updatedAt: now };
    const next = { ...thread, replies: [...(thread.replies ?? []), reply] };
    return { thread: next, result: { thread: next, reply } };
  });
}

/** `{ body }`, on a reply the actor wrote. */
export async function updateReply(
  projectPath: string, slug: string, threadId: string, replyId: string, input: unknown, opts: CommentWriteOptions = {},
): Promise<ReplyChange> {
  notFoundIfBadId(threadId, replyId);
  if (!isRaw(input)) throw badRequest("Expected a JSON object");
  const body = parseBody(input.body, true)!;
  const guest = guestOf(opts.actor);
  return changeThread(projectPath, slug, threadId, guest, opts.recheck, (thread) => {
    const current = findReply(thread, replyId);
    if (guest && !isMine(current, guest)) throw notYours();
    if (!guest && !isOwnerEntry(current)) throw guestTextIsTheirs();
    const reply: StoredCommentReply = { ...current, body, updatedAt: new Date().toISOString() };
    const next = { ...thread, replies: thread.replies!.map((r) => (r.id === replyId ? reply : r)) };
    return { thread: next, result: { thread: next, reply } };
  });
}

/** The owner deletes any reply; a reviewer only their own. Answers the thread as it now stands. */
export async function deleteReply(
  projectPath: string, slug: string, threadId: string, replyId: string, opts: CommentWriteOptions = {},
): Promise<StoredDesignComment> {
  notFoundIfBadId(threadId, replyId);
  const guest = guestOf(opts.actor);
  return changeThread(projectPath, slug, threadId, guest, opts.recheck, (thread) => {
    const current = findReply(thread, replyId);
    if (guest && !isMine(current, guest)) throw notYours();
    const next: StoredDesignComment = { ...thread };
    const rest = thread.replies!.filter((r) => r !== current);
    if (rest.length) next.replies = rest;
    else delete next.replies;
    return { thread: next, result: next };
  });
}

/**
 * Deletes every thread reviewers on `linkId` started, replies included, and answers how many
 * went. Works for a link whose row is already gone, which is when its threads are most
 * likely to be cleared. Nothing is written, and no event sent, when there were none.
 */
export async function deleteThreadsOfLink(projectPath: string, slug: string, linkId: string): Promise<number> {
  if (!SHARE_LINK_ID_RE.test(linkId)) throw notFound();
  const removed = await withRecoveredDesign(projectPath, slug, async (designDir) => {
    const comments = await readComments(designDir);
    const rest = comments.filter((c) => !visibleToLink(c, linkId));
    if (rest.length !== comments.length) await writeComments(designDir, rest);
    return comments.length - rest.length;
  });
  if (removed > 0) commentsChanged(projectPath, slug);
  return removed;
}
