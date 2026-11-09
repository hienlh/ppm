import { randomBytes } from "node:crypto";
import {
  COMMENT_ID_RE, parseCommentAnchor, parsePpmId, type CommentAnchor,
} from "../../shared/design-comment-types.ts";
import type { StoredDesignComment } from "../../shared/design-comment-thread-types.ts";
import { DESIGN_GEN_RE } from "../../shared/design-types.ts";
import { resolveDesignDir } from "./design-paths.ts";
import { withRecoveredDesign } from "./design-restore-journal.ts";
import { DesignError } from "./design-error.ts";
import { readComments, writeComments } from "./comments/design-comments-store.ts";
import { elementContext, validateReanchor, type ElementContext } from "./comments/design-comment-element-context.ts";
import {
  badRequest, commentsChanged, guestOf, guestTextIsTheirs, isRaw, newAuthor, notFound, notYours, parseBody, tooMany, type Raw,
} from "./comments/design-comment-input.ts";
import {
  guestMayDeleteRoot, isMine, isOwnerEntry, quotaRefusal, visibleToLink, type CommentActor,
} from "./comments/design-comment-views.ts";

/**
 * Pinned element comments of one design: the root of each thread (replies are in
 * `design-comment-replies.service.ts`).
 *
 * Every change runs under the design's lock (so two devices commenting at once cannot lose
 * each other's write), writes `comments.json` atomically, and announces itself as
 * `comments_changed`: `.design/` is not watched, so that event is the only way another
 * device's list learns of it.
 *
 * Input arrives from the browser, and anchors originate in the page, so everything is
 * validated and capped here. The element snippet is never taken from the request; it is
 * built from the source file (see `design-comment-element-context.ts`).
 *
 * Every write takes an optional `actor`; absent means the owner. A reviewer (`kind: "guest"`)
 * acts only inside threads their link started, edits only their own text, and pins to the
 * snapshot their link shows. Ownership and quotas are checked against the list read under
 * the lock, never against an earlier read.
 */

export interface CommentWriteOptions {
  actor?: CommentActor;
  /**
   * Runs once the design lock is held, before anything is read or written; throwing refuses
   * the change. A reviewer's write can queue behind a long snapshot, and this is where it
   * finds out that its link was revoked meanwhile.
   */
  recheck?: () => void;
}

export interface AddCommentOptions extends CommentWriteOptions {
  /** The snapshot a reviewer's page showed; required for a reviewer, refused for the owner. */
  source?: { snapshotId: string };
}

function parseAnchorInput(input: Raw): CommentAnchor {
  const anchor = parseCommentAnchor(input.anchor);
  if (!anchor) throw badRequest("Invalid element anchor");
  if (input.file !== undefined && input.file !== anchor.file) throw badRequest("file does not match the anchor");
  return anchor;
}

export async function listComments(projectPath: string, slug: string): Promise<StoredDesignComment[]> {
  return readComments(await resolveDesignDir(projectPath, slug));
}

/** The server-built context for an element, without saving anything ("Send to AI" on one element). */
export async function previewElementContext(projectPath: string, slug: string, input: unknown): Promise<ElementContext> {
  if (!isRaw(input)) throw badRequest("Expected a JSON object");
  const anchor = parseAnchorInput(input);
  await resolveDesignDir(projectPath, slug);
  return elementContext(projectPath, slug, anchor);
}

export async function addComment(
  projectPath: string, slug: string, input: unknown, opts: AddCommentOptions = {},
): Promise<StoredDesignComment> {
  if (!isRaw(input)) throw badRequest("Expected a JSON object");
  const anchor = parseAnchorInput(input);
  const body = parseBody(input.body, true)!;
  const author = newAuthor(opts.actor);
  const guest = author.kind === "guest";
  if (guest && !opts.source) throw badRequest("A reviewer's comment needs the snapshot it was made on");
  if (!guest && opts.source) throw badRequest("Only a reviewer's comment is pinned to a snapshot");
  const snapshotId = opts.source?.snapshotId;
  const comment = await withRecoveredDesign(projectPath, slug, async (designDir) => {
    opts.recheck?.();
    const comments = await readComments(designDir);
    const refusal = quotaRefusal(comments, author);
    if (refusal) throw tooMany(refusal);
    const context = await elementContext(projectPath, slug, anchor, { snapshotId });
    const now = new Date().toISOString();
    const created: StoredDesignComment = {
      id: randomBytes(6).toString("hex"),
      file: anchor.file,
      anchor: { ...anchor, quote: context.quote },
      body,
      snippet: context.snippet,
      createdAt: now,
      updatedAt: now,
    };
    if (guest && snapshotId !== undefined) {
      created.author = author;
      // Only ids the server confirmed against the snapshot are kept for the reviewer's page.
      const confirmed = context.snippet !== null;
      created.pinnedAnchor = { snapshotId, ppmId: confirmed ? anchor.ppmId : null, gen: confirmed ? anchor.gen : null };
    }
    await writeComments(designDir, [...comments, created]);
    return created;
  });
  commentsChanged(projectPath, slug);
  return comment;
}

/**
 * `body`, `resolved` (true/false), `sent` (true: stamp `sentAt`) and `anchor` (`{ppmId,
 * gen}` the canvas found the element under, re-validated against the source; 409 if it
 * does not hold up). At least one must be given. A reviewer may send `body` only, on their
 * own root; the owner may send anything but `body` on a reviewer's root. A re-anchor moves
 * `anchor` only: a reviewer's `pinnedAnchor` stays where they pinned it.
 */
export async function updateComment(
  projectPath: string, slug: string, id: string, patch: unknown, opts: CommentWriteOptions = {},
): Promise<StoredDesignComment> {
  if (!COMMENT_ID_RE.test(id)) throw notFound();
  if (!isRaw(patch)) throw badRequest("Expected a JSON object");
  const guest = guestOf(opts.actor);
  const body = parseBody(patch.body, false);
  const resolved = patch.resolved === undefined ? undefined : patch.resolved === true ? true : patch.resolved === false ? false : null;
  if (resolved === null) throw badRequest("resolved must be true or false");
  if (patch.sent !== undefined && patch.sent !== true) throw badRequest("sent can only be true");
  let move: { ppmId: number; gen: string } | undefined;
  if (patch.anchor !== undefined) {
    const a = isRaw(patch.anchor) ? patch.anchor : {};
    const ppmId = parsePpmId(a.ppmId);
    if (typeof ppmId !== "number" || typeof a.gen !== "string" || !DESIGN_GEN_RE.test(a.gen)) throw badRequest("Invalid anchor update");
    move = { ppmId, gen: a.gen };
  }
  if (body === undefined && resolved === undefined && patch.sent === undefined && !move) throw badRequest("Nothing to update");
  if (guest && (resolved !== undefined || patch.sent !== undefined || move)) {
    throw new DesignError(403, "ENOTALLOWED", "A reviewer can only edit the text of their comment");
  }

  const updated = await withRecoveredDesign(projectPath, slug, async (designDir) => {
    opts.recheck?.();
    const comments = await readComments(designDir);
    const index = comments.findIndex((c) => c.id === id && (!guest || visibleToLink(c, guest.linkId)));
    if (index < 0) throw notFound();
    const current = comments[index]!;
    if (guest && !isMine(current, guest)) throw notYours();
    if (!guest && body !== undefined && !isOwnerEntry(current)) throw guestTextIsTheirs();
    const now = new Date().toISOString();
    const next: StoredDesignComment = { ...current, updatedAt: now };
    if (body !== undefined) next.body = body;
    if (resolved === true && !next.resolvedAt) next.resolvedAt = now;
    if (resolved === false) delete next.resolvedAt;
    if (patch.sent === true) next.sentAt = now;
    if (move) {
      next.snippet = await validateReanchor(projectPath, slug, next.anchor, move);
      next.anchor = { ...next.anchor, ppmId: move.ppmId, gen: move.gen };
    }
    comments[index] = next;
    await writeComments(designDir, comments);
    return next;
  });
  commentsChanged(projectPath, slug);
  return updated;
}

/** The owner deletes any thread; a reviewer only their own, and only while it has no replies. */
export async function deleteComment(projectPath: string, slug: string, id: string, opts: CommentWriteOptions = {}): Promise<void> {
  if (!COMMENT_ID_RE.test(id)) throw notFound();
  const guest = guestOf(opts.actor);
  await withRecoveredDesign(projectPath, slug, async (designDir) => {
    opts.recheck?.();
    const comments = await readComments(designDir);
    const target = comments.find((c) => c.id === id && (!guest || visibleToLink(c, guest.linkId)));
    if (!target) throw notFound();
    if (guest && !isMine(target, guest)) throw notYours();
    if (guest && !guestMayDeleteRoot(target, guest)) {
      throw new DesignError(409, "EHASREPLIES", "This comment has replies, so it can no longer be deleted; edit it instead");
    }
    await writeComments(designDir, comments.filter((c) => c !== target));
  });
  commentsChanged(projectPath, slug);
}
