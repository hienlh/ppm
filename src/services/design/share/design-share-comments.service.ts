import { createHash, randomBytes } from "node:crypto";
import { lstat } from "node:fs/promises";
import { join } from "node:path";
import type { Stats } from "node:fs";
import type { DesignCommentGuestView, StoredDesignComment } from "../../../shared/design-comment-thread-types.ts";
import { GUEST_KEY_RE } from "../../../shared/design-share-guest-types.ts";
import { dotDesignDir } from "../design-paths.ts";
import { COMMENTS_FILE, readComments } from "../comments/design-comments-store.ts";
import { commentsRevision } from "../comments/design-comments-revision.ts";
import { guestThreads, toGuestView, type CommentActor } from "../comments/design-comment-views.ts";
import { addComment, deleteComment, updateComment } from "../design-comments.service.ts";
import { addReply, deleteReply, updateReply } from "../design-comment-replies.service.ts";
import type { ResolvedShareLink } from "./design-share-resolve.ts";
import { assertGuestLinkOpen } from "./design-share-guest-link.ts";

/**
 * The comment service as a reviewer reaches it: identity from the browser key, the link's
 * own threads only, and every answer in the reviewer's view (no key hashes, no snippets).
 * Ownership, quotas and visibility are enforced by the comment services under the design
 * lock; this layer only shapes the call and the answer.
 *
 * Polls are cheap: the ETag is built from a per-design revision counter, the file's `stat`
 * and the asker, so an unchanged list is answered without reading `comments.json`, and a
 * changed one is parsed once per change, not once per reviewer.
 */

/** Test seam: how the comment file is read and stat'ed. */
export const guestCommentsIo = {
  read: (designDir: string): Promise<StoredDesignComment[]> => readComments(designDir),
  stat: (path: string): Promise<Stats> => lstat(path),
};

const BOOT_ID = randomBytes(8).toString("hex");
const MAX_CACHED_DESIGNS = 16;

interface FileStamp { mtimeMs: number; size: number; ino: number; revision: number }
const parsed = new Map<string, { stamp: FileStamp; comments: StoredDesignComment[] }>();

/** SHA-256 hex of a well-formed browser key, or null for none or a malformed one. */
export function guestKeyHash(key: string | undefined): string | null {
  return key && GUEST_KEY_RE.test(key) ? createHash("sha256").update(key).digest("hex") : null;
}

async function stampOf(resolved: ResolvedShareLink): Promise<FileStamp> {
  const revision = commentsRevision(resolved.link.projectPath, resolved.link.slug);
  try {
    const st = await guestCommentsIo.stat(join(dotDesignDir(resolved.designDir), COMMENTS_FILE));
    return { mtimeMs: st.mtimeMs, size: st.size, ino: Number(st.ino), revision };
  } catch {
    return { mtimeMs: 0, size: -1, ino: 0, revision };
  }
}

const sameStamp = (a: FileStamp, b: FileStamp): boolean =>
  a.mtimeMs === b.mtimeMs && a.size === b.size && a.ino === b.ino && a.revision === b.revision;

function etagOf(stamp: FileStamp, resolved: ResolvedShareLink, keyHash: string | null): string {
  const parts = [BOOT_ID, stamp.revision, stamp.mtimeMs, stamp.size, stamp.ino, resolved.link.id, resolved.link.snapshotId, keyHash?.slice(0, 16) ?? "-"];
  return `"${createHash("sha256").update(parts.join("|")).digest("base64url").slice(0, 27)}"`;
}

/** The list's ETag for this reviewer, from one `stat`. */
export async function guestCommentsEtag(resolved: ResolvedShareLink, keyHash: string | null): Promise<string> {
  return etagOf(await stampOf(resolved), resolved, keyHash);
}

/**
 * The link's threads as `keyHash`'s reviewer sees them, the version the link shows now (a
 * page still showing another one was opened before a re-pin), and the ETag. The ETag covers
 * the version too, so a re-pin never answers 304.
 */
export async function listGuestThreads(
  resolved: ResolvedShareLink, keyHash: string | null,
): Promise<{ threads: DesignCommentGuestView[]; versionId: string; etag: string }> {
  const stamp = await stampOf(resolved);
  const hit = parsed.get(resolved.designDir);
  let comments: StoredDesignComment[];
  if (hit && sameStamp(hit.stamp, stamp)) {
    comments = hit.comments;
  } else {
    // Read after the stat: a write landing in between makes the list newer than its ETag,
    // which only means the next poll sends it again.
    comments = await guestCommentsIo.read(resolved.designDir);
    parsed.delete(resolved.designDir);
    parsed.set(resolved.designDir, { stamp, comments });
    if (parsed.size > MAX_CACHED_DESIGNS) parsed.delete(parsed.keys().next().value!);
  }
  return {
    threads: guestThreads(comments, resolved.link, keyHash ?? ""),
    versionId: resolved.link.snapshotId,
    etag: etagOf(stamp, resolved, keyHash),
  };
}

function actorOf(resolved: ResolvedShareLink, keyHash: string, name?: unknown): CommentActor {
  return { kind: "guest", linkId: resolved.link.id, keyHash, name: typeof name === "string" ? name : undefined };
}

/**
 * A reviewer's write options: who they are, and the link checked again under the design
 * lock, since the write may have queued behind a snapshot while the owner revoked the link.
 */
function guestOpts(resolved: ResolvedShareLink, keyHash: string, extra: { name?: unknown; versionId?: string } = {}) {
  return {
    actor: actorOf(resolved, keyHash, extra.name),
    recheck: () => assertGuestLinkOpen(resolved, extra.versionId),
  };
}

type Body = Record<string, unknown>;

/**
 * A new thread, pinned to the version the reviewer's page shows (`versionId`). A page left
 * open across a re-pin still shows the old one, and its anchor means nothing in the new one,
 * so that comment is refused (409) rather than pinned where it was not made.
 */
export async function addGuestComment(resolved: ResolvedShareLink, keyHash: string, body: Body): Promise<DesignCommentGuestView> {
  const { link } = resolved;
  // Compared under the lock with the row as it is then (after the input itself is checked),
  // so the snapshot the comment is pinned to is the one that check confirmed.
  const versionId = typeof body.versionId === "string" ? body.versionId : "";
  const created = await addComment(link.projectPath, link.slug, { anchor: body.anchor, body: body.body }, {
    ...guestOpts(resolved, keyHash, { name: body.name, versionId }), source: { snapshotId: versionId },
  });
  return toGuestView(created, link, keyHash);
}

export async function updateGuestComment(
  resolved: ResolvedShareLink, keyHash: string, id: string, body: Body,
): Promise<DesignCommentGuestView> {
  const { link } = resolved;
  const updated = await updateComment(link.projectPath, link.slug, id, { body: body.body }, guestOpts(resolved, keyHash));
  return toGuestView(updated, link, keyHash);
}

export async function deleteGuestComment(resolved: ResolvedShareLink, keyHash: string, id: string): Promise<void> {
  await deleteComment(resolved.link.projectPath, resolved.link.slug, id, guestOpts(resolved, keyHash));
}

export async function addGuestReply(
  resolved: ResolvedShareLink, keyHash: string, threadId: string, body: Body,
): Promise<DesignCommentGuestView> {
  const { link } = resolved;
  const { thread } = await addReply(link.projectPath, link.slug, threadId, { body: body.body }, guestOpts(resolved, keyHash, { name: body.name }));
  return toGuestView(thread, link, keyHash);
}

export async function updateGuestReply(
  resolved: ResolvedShareLink, keyHash: string, threadId: string, replyId: string, body: Body,
): Promise<DesignCommentGuestView> {
  const { link } = resolved;
  const { thread } = await updateReply(link.projectPath, link.slug, threadId, replyId, { body: body.body }, guestOpts(resolved, keyHash));
  return toGuestView(thread, link, keyHash);
}

export async function deleteGuestReply(
  resolved: ResolvedShareLink, keyHash: string, threadId: string, replyId: string,
): Promise<DesignCommentGuestView> {
  const { link } = resolved;
  const thread = await deleteReply(link.projectPath, link.slug, threadId, replyId, guestOpts(resolved, keyHash));
  return toGuestView(thread, link, keyHash);
}
