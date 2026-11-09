import {
  COMMENT_LIMITS, type CommentAnchor, type CommentAuthor, type DesignComment, type DesignCommentReply,
} from "./design-comment-types";

/**
 * Comment threads once reviewers take part: authors as stored, and the two projections the
 * routes answer with. The stored shape carries a guest's key hash; neither view does.
 */

/**
 * A guest as stored. `keyHash` (SHA-256 hex of the reviewer's browser key) is what makes an
 * entry "theirs"; it never leaves the server. `linkId` is the share link they came through.
 */
export interface StoredGuestAuthor { kind: "guest"; name: string; linkId: string; keyHash: string }
export type StoredCommentAuthor = { kind: "owner" } | StoredGuestAuthor;
/** The owner's view of an author: which link a guest came through, by its label. */
export type OwnerViewAuthor = { kind: "owner" } | { kind: "guest"; name: string; linkId: string; linkLabel: string };

export type StoredDesignComment = DesignComment<StoredCommentAuthor>;
export type StoredCommentReply = DesignCommentReply<StoredCommentAuthor>;

/** What the owner's routes answer with: the author is always named, replies always listed. */
export interface DesignCommentOwnerView extends DesignComment<OwnerViewAuthor> {
  author: OwnerViewAuthor;
  replies: DesignCommentReply<OwnerViewAuthor>[];
}

export interface GuestCommentReplyView extends DesignCommentReply {
  /** Written by the reviewer asking. */
  mine: boolean;
}

/**
 * What a reviewer sees of a thread: no snippet, no sent stamp, no link or key of anyone,
 * and an anchor whose `ppmId`/`gen` are the pinned ones while the link still shows that
 * snapshot (null otherwise, so the page finds the element by its quote).
 */
export interface DesignCommentGuestView {
  id: string;
  file: string;
  anchor: CommentAnchor;
  body: string;
  createdAt: string;
  updatedAt: string;
  resolvedAt?: string;
  author: CommentAuthor;
  mine: boolean;
  replies: GuestCommentReplyView[];
}

/** The owner view's label for a guest whose link row has since been deleted. */
export const REMOVED_LINK_LABEL = "Removed link";

/** A share link's id, as `design_share_links` issues them. */
export const SHARE_LINK_ID_RE = /^[0-9a-f]{12}$/;
/** SHA-256 hex of a guest's browser key. */
export const GUEST_KEY_HASH_RE = /^[0-9a-f]{64}$/;

// Control characters, line breaks and the bidi controls (overrides, isolates, marks) that
// could make a name read as something else.
const NAME_STRIPPED = /[\p{Cc}\p{Zl}\p{Zp}\p{Bidi_Control}]/gu;

/**
 * A guest's display name: control characters and line breaks removed, trimmed, 1 to
 * {@link COMMENT_LIMITS.guestName} characters, and never "Owner" — the owner's entries carry
 * `kind: "owner"`, but a reviewer named Owner would still read as them in a list. The
 * reserved check ignores case, invisible format characters and compatibility forms
 * (fullwidth letters, a zero-width space inside the word).
 */
export function parseGuestName(v: unknown): { ok: true; name: string } | { ok: false; error: string } {
  if (typeof v !== "string") return { ok: false, error: "A name is needed" };
  const name = v.replace(NAME_STRIPPED, "").trim();
  const length = [...name].length;
  if (length === 0) return { ok: false, error: "A name is needed" };
  if (length > COMMENT_LIMITS.guestName) return { ok: false, error: `A name is at most ${COMMENT_LIMITS.guestName} characters` };
  if (name.normalize("NFKC").replace(/\p{Cf}/gu, "").trim().toLowerCase() === "owner") {
    return { ok: false, error: "That name is reserved" };
  }
  return { ok: true, name };
}
