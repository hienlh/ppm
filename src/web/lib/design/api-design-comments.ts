import { api, projectUrl } from "@/lib/api-client";
import type { CommentAnchor, CommentQuote, DesignComment } from "../../../shared/design-comment-types";

/**
 * `/api/project/:name/designs/:slug/comments`. The server builds each element's snippet
 * from the source file itself; nothing the page reported about its own markup is sent.
 */

const base = (projectName: string, slug: string) =>
  `${projectUrl(projectName)}/designs/${encodeURIComponent(slug)}/comments`;

export interface CommentPatch {
  body?: string;
  resolved?: boolean;
  sent?: true;
  anchor?: { ppmId: number; gen: string };
}

/** Normalised at the boundary: callers render the list straight away. */
export async function listDesignComments(projectName: string, slug: string): Promise<DesignComment[]> {
  const data = await api.get<DesignComment[] | null>(base(projectName, slug));
  return Array.isArray(data) ? data : [];
}

export function createDesignComment(projectName: string, slug: string, anchor: CommentAnchor, body: string): Promise<DesignComment> {
  return api.post<DesignComment>(base(projectName, slug), { file: anchor.file, anchor, body });
}

export function updateDesignComment(projectName: string, slug: string, id: string, patch: CommentPatch): Promise<DesignComment> {
  return api.patch<DesignComment>(`${base(projectName, slug)}/${encodeURIComponent(id)}`, patch);
}

export function deleteDesignComment(projectName: string, slug: string, id: string): Promise<void> {
  return api.del(`${base(projectName, slug)}/${encodeURIComponent(id)}`);
}

/** The server-built snippet for one element, without saving a comment. */
export function designElementContext(
  projectName: string, slug: string, anchor: CommentAnchor,
): Promise<{ snippet: string | null; quote: CommentQuote }> {
  return api.post<{ snippet: string | null; quote: CommentQuote }>(`${base(projectName, slug)}/context`, { anchor });
}
