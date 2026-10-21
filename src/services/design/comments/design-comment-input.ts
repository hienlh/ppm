import { COMMENT_LIMITS } from "../../../shared/design-comment-types.ts";
import {
  GUEST_KEY_HASH_RE, parseGuestName, SHARE_LINK_ID_RE, type StoredCommentAuthor, type StoredGuestAuthor,
} from "../../../shared/design-comment-thread-types.ts";
import { emitDesignEvent } from "../design-events.ts";
import { DesignError } from "../design-error.ts";
import { bumpCommentsRevision } from "./design-comments-revision.ts";
import type { CommentActor, GuestIdentity } from "./design-comment-views.ts";

/** Input checks and refusals shared by the root-comment and reply services. */

export type Raw = Record<string, unknown>;
export const isRaw = (v: unknown): v is Raw => !!v && typeof v === "object" && !Array.isArray(v);
export const badRequest = (message: string): DesignError => new DesignError(400, "EBADCOMMENT", message);
export const notFound = (): DesignError => new DesignError(404, "ENOENT", "Comment not found");
export const tooMany = (message: string): DesignError => new DesignError(409, "ETOOMANY", message);
export const notYours = (): DesignError => new DesignError(403, "ENOTYOURS", "You can only change your own comments");
export const guestTextIsTheirs = (): DesignError => new DesignError(403, "ENOTYOURS", "A reviewer's text can only be edited by them");

export function parseBody(v: unknown, required: boolean): string | undefined {
  if (v === undefined && !required) return undefined;
  if (typeof v !== "string" || !v.trim()) throw badRequest("A comment needs some text");
  if (v.length > COMMENT_LIMITS.body) throw badRequest(`A comment is at most ${COMMENT_LIMITS.body} characters`);
  return v.trim();
}

export function commentsChanged(projectPath: string, slug: string): void {
  bumpCommentsRevision(projectPath, slug);
  emitDesignEvent("comments_changed", { projectPath, slug });
}

/** The guest identity of an actor (checked), or null for the owner. */
export function guestOf(actor: CommentActor | undefined): GuestIdentity | null {
  if (!actor || actor.kind === "owner") return null;
  if (!SHARE_LINK_ID_RE.test(actor.linkId) || !GUEST_KEY_HASH_RE.test(actor.keyHash)) throw badRequest("Invalid reviewer");
  return { linkId: actor.linkId, keyHash: actor.keyHash };
}

/** The author a new entry is stored with; a guest needs a valid name. */
export function newAuthor(actor: CommentActor | undefined): StoredCommentAuthor {
  if (!actor || actor.kind === "owner") return { kind: "owner" };
  const who = guestOf(actor)!;
  const name = parseGuestName(actor.name);
  if (!name.ok) throw badRequest(name.error);
  const author: StoredGuestAuthor = { kind: "guest", name: name.name, linkId: who.linkId, keyHash: who.keyHash };
  return author;
}
