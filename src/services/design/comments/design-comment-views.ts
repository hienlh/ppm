import { COMMENT_LIMITS, type CommentAuthor } from "../../../shared/design-comment-types.ts";
import {
  REMOVED_LINK_LABEL,
  type DesignCommentGuestView, type DesignCommentOwnerView, type OwnerViewAuthor,
  type StoredCommentAuthor, type StoredCommentReply, type StoredDesignComment,
} from "../../../shared/design-comment-thread-types.ts";

/**
 * Who may see and change which comment, how many each party may write, and what each side
 * is shown. Pure: the service applies these under the design lock, to the list it just read.
 *
 * A guest's key hash never appears in either view. The owner sees which link a reviewer came
 * through; a reviewer sees names and whether an entry is their own, nothing more.
 */

/** A reviewer, as the guest routes identify one: their link and the hash of their key. */
export interface GuestIdentity {
  linkId: string;
  keyHash: string;
}

/** Who is making a change. A guest's `name` is needed only to write something new. */
export type CommentActor = { kind: "owner" } | ({ kind: "guest"; name?: string } & GuestIdentity);

type Authored = { author?: StoredCommentAuthor };

export function isOwnerEntry(entry: Authored): boolean {
  return !entry.author || entry.author.kind === "owner";
}

export function isMine(entry: Authored, who: GuestIdentity): boolean {
  const a = entry.author;
  return a?.kind === "guest" && a.linkId === who.linkId && a.keyHash === who.keyHash;
}

/**
 * A reviewer sees a thread only when a reviewer on the same link started it. Links are
 * isolated from one another, and the owner's own notes are never shown to anyone.
 */
export function visibleToLink(root: Authored, linkId: string): boolean {
  return root.author?.kind === "guest" && root.author.linkId === linkId;
}

/** A guest may delete their own root only while nobody has replied; after that it is edit-only. */
export function guestMayDeleteRoot(root: StoredDesignComment, who: GuestIdentity): boolean {
  return isMine(root, who) && !root.replies?.length;
}

/** Guest entries (roots and replies) in the list, all of them or one link's. */
export function countGuestEntries(comments: readonly StoredDesignComment[], linkId?: string): number {
  const counts = (a: StoredCommentAuthor | undefined) => a?.kind === "guest" && (linkId === undefined || a.linkId === linkId);
  let n = 0;
  for (const c of comments) {
    if (counts(c.author)) n++;
    for (const r of c.replies ?? []) if (counts(r.author)) n++;
  }
  return n;
}

export function countOwnerRoots(comments: readonly StoredDesignComment[]): number {
  return comments.filter(isOwnerEntry).length;
}

/**
 * Why `author` may not add a root (no `thread`) or a reply to `thread`, or null when it may.
 * The owner's roots have a cap of their own, so reviewers filling theirs never lock the owner
 * out; the owner's replies in a reviewer's thread count against no reviewer cap.
 */
export function quotaRefusal(
  comments: readonly StoredDesignComment[],
  author: StoredCommentAuthor | undefined,
  thread?: StoredDesignComment,
): string | null {
  if (thread && (thread.replies?.length ?? 0) >= COMMENT_LIMITS.maxReplies) {
    return `A thread holds at most ${COMMENT_LIMITS.maxReplies} replies`;
  }
  if (author?.kind === "guest") {
    if (countGuestEntries(comments, author.linkId) >= COMMENT_LIMITS.maxGuestEntriesPerLink) {
      return `A share link holds at most ${COMMENT_LIMITS.maxGuestEntriesPerLink} comments and replies`;
    }
    if (countGuestEntries(comments) >= COMMENT_LIMITS.maxGuestEntries) {
      return `A design holds at most ${COMMENT_LIMITS.maxGuestEntries} reviewer comments and replies`;
    }
    return null;
  }
  if (!thread && countOwnerRoots(comments) >= COMMENT_LIMITS.maxComments) {
    return `A design holds at most ${COMMENT_LIMITS.maxComments} comments; delete resolved ones first`;
  }
  return null;
}

function ownerAuthor(a: StoredCommentAuthor | undefined, labels: ReadonlyMap<string, string>): OwnerViewAuthor {
  if (!a || a.kind === "owner") return { kind: "owner" };
  return { kind: "guest", name: a.name, linkId: a.linkId, linkLabel: labels.get(a.linkId) ?? REMOVED_LINK_LABEL };
}

function guestAuthor(a: StoredCommentAuthor | undefined): CommentAuthor {
  return !a || a.kind === "owner" ? { kind: "owner" } : { kind: "guest", name: a.name };
}

/** The owner's view: every field but the key hash, and each guest's link by its label. */
export function toOwnerView(c: StoredDesignComment, linkLabels: ReadonlyMap<string, string>): DesignCommentOwnerView {
  const { author, replies, ...rest } = c;
  return {
    ...rest,
    author: ownerAuthor(author, linkLabels),
    replies: (replies ?? []).map((r: StoredCommentReply) => ({
      id: r.id, body: r.body, author: ownerAuthor(r.author, linkLabels), createdAt: r.createdAt, updatedAt: r.updatedAt,
    })),
  };
}

/**
 * A reviewer's view of one thread on `link`. Built field by field, so nothing added to the
 * stored shape later reaches a reviewer by accident. The anchor's `ppmId`/`gen` come from
 * the pinned anchor only, and only while the link still shows the snapshot it was made on:
 * the stored ones follow the owner's live file and mean nothing in the snapshot.
 */
export function toGuestView(
  c: StoredDesignComment, link: { id: string; snapshotId: string }, keyHash: string,
): DesignCommentGuestView {
  const who = { linkId: link.id, keyHash };
  const pinned = c.pinnedAnchor?.snapshotId === link.snapshotId ? c.pinnedAnchor : null;
  const view: DesignCommentGuestView = {
    id: c.id,
    file: c.file,
    anchor: { ...c.anchor, ppmId: pinned?.ppmId ?? null, gen: pinned?.gen ?? null },
    body: c.body,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
    author: guestAuthor(c.author),
    mine: isMine(c, who),
    replies: (c.replies ?? []).map((r) => ({
      id: r.id, body: r.body, author: guestAuthor(r.author), createdAt: r.createdAt, updatedAt: r.updatedAt, mine: isMine(r, who),
    })),
  };
  if (c.resolvedAt) view.resolvedAt = c.resolvedAt;
  return view;
}

/** Every thread a reviewer on `link` may see, in their view. */
export function guestThreads(
  comments: readonly StoredDesignComment[], link: { id: string; snapshotId: string }, keyHash: string,
): DesignCommentGuestView[] {
  return comments.filter((c) => visibleToLink(c, link.id)).map((c) => toGuestView(c, link, keyHash));
}
