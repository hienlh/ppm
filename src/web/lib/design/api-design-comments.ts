import { api, projectUrl } from "@/lib/api-client";
import type { CommentAnchor, CommentQuote } from "../../../shared/design-comment-types";
import type { DesignCommentOwnerView } from "../../../shared/design-comment-thread-types";

/**
 * `/api/project/:name/designs/:slug/comments`. The server builds each element's snippet
 * from the source file itself; nothing the page reported about its own markup is sent.
 * Every answer is the owner's view of a thread: authors named, replies listed.
 */

const designBase = (projectName: string, slug: string) => `${projectUrl(projectName)}/designs/${encodeURIComponent(slug)}`;
const base = (projectName: string, slug: string) => `${designBase(projectName, slug)}/comments`;
const replyUrl = (projectName: string, slug: string, id: string, replyId?: string) =>
  `${base(projectName, slug)}/${encodeURIComponent(id)}/replies${replyId ? `/${encodeURIComponent(replyId)}` : ""}`;

export interface CommentPatch {
  body?: string;
  resolved?: boolean;
  sent?: true;
  anchor?: { ppmId: number; gen: string };
}

/** Normalised at the boundary: callers render the list straight away. */
export async function listDesignComments(projectName: string, slug: string): Promise<DesignCommentOwnerView[]> {
  const data = await api.get<DesignCommentOwnerView[] | null>(base(projectName, slug));
  return Array.isArray(data) ? data : [];
}

export function createDesignComment(projectName: string, slug: string, anchor: CommentAnchor, body: string): Promise<DesignCommentOwnerView> {
  return api.post<DesignCommentOwnerView>(base(projectName, slug), { file: anchor.file, anchor, body });
}

/** A reviewer's root accepts everything but `body`, which only its reviewer may change. */
export function updateDesignComment(projectName: string, slug: string, id: string, patch: CommentPatch): Promise<DesignCommentOwnerView> {
  return api.patch<DesignCommentOwnerView>(`${base(projectName, slug)}/${encodeURIComponent(id)}`, patch);
}

export function deleteDesignComment(projectName: string, slug: string, id: string): Promise<void> {
  return api.del(`${base(projectName, slug)}/${encodeURIComponent(id)}`);
}

/** Each reply call answers with the whole thread as it now stands. */
export function addDesignCommentReply(projectName: string, slug: string, id: string, body: string): Promise<DesignCommentOwnerView> {
  return api.post<DesignCommentOwnerView>(replyUrl(projectName, slug, id), { body });
}

/** The owner's own replies only; a reviewer's words are never edited for them. */
export function updateDesignCommentReply(
  projectName: string, slug: string, id: string, replyId: string, body: string,
): Promise<DesignCommentOwnerView> {
  return api.patch<DesignCommentOwnerView>(replyUrl(projectName, slug, id, replyId), { body });
}

/**
 * The server answers with the thread, but `api.del` reads no body; the list catches up on
 * the `design:comments_changed` that follows, as it does for a deleted root.
 */
export function deleteDesignCommentReply(projectName: string, slug: string, id: string, replyId: string): Promise<void> {
  return api.del(replyUrl(projectName, slug, id, replyId));
}

/** Deletes every thread reviewers on one share link started (the server answers `{deleted: n}`). */
export function deleteShareLinkThreads(projectName: string, slug: string, linkId: string): Promise<void> {
  return api.del(`${designBase(projectName, slug)}/shares/${encodeURIComponent(linkId)}/comments`);
}

/** The server-built snippet for one element, without saving a comment. */
export function designElementContext(
  projectName: string, slug: string, anchor: CommentAnchor,
): Promise<{ snippet: string | null; quote: CommentQuote }> {
  return api.post<{ snippet: string | null; quote: CommentQuote }>(`${base(projectName, slug)}/context`, { anchor });
}
