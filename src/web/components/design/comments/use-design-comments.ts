import { useCallback, useEffect, useMemo, useState } from "react";
import {
  createDesignComment, deleteDesignComment, listDesignComments, updateDesignComment, type CommentPatch,
} from "@/lib/design/api-design-comments";
import { isOpenComment, type CommentAnchor, type DesignComment } from "../../../../shared/design-comment-types";

/**
 * One design's comments, kept in step with the server.
 *
 * `.design/` is not watched, so the list refreshes on `design:comments_changed` — which also
 * covers another device commenting on the same design. Every change this client makes is
 * applied locally at once from the server's answer; the event that follows only confirms it.
 * Refetches are debounced, because marking N comments sent is N events.
 */

export const COMMENTS_CHANGED_EVENT = "design:comments_changed";

export interface DesignCommentsState {
  comments: DesignComment[] | null;
  /** Open comments in the order they were made; a pin's number is its index here plus one. */
  open: DesignComment[];
  resolved: DesignComment[];
  error: string | null;
  reload: () => void;
  add: (anchor: CommentAnchor, body: string) => Promise<DesignComment>;
  update: (id: string, patch: CommentPatch) => Promise<DesignComment>;
  remove: (id: string) => Promise<void>;
}

const byCreated = (a: DesignComment, b: DesignComment) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0);

export function useDesignComments(projectName: string, slug: string): DesignCommentsState {
  const [comments, setComments] = useState<DesignComment[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(() => {
    listDesignComments(projectName, slug)
      .then((list) => { setComments(list); setError(null); })
      .catch((e) => setError((e as Error).message || "Could not load the comments"));
  }, [projectName, slug]);

  useEffect(() => {
    setComments(null);
    reload();
    let timer: ReturnType<typeof setTimeout> | null = null;
    const onChanged = (e: Event) => {
      const d = (e as CustomEvent<{ projectName?: string; slug?: string }>).detail;
      if (d?.projectName !== projectName || d.slug !== slug) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(reload, 150);
    };
    window.addEventListener(COMMENTS_CHANGED_EVENT, onChanged);
    return () => {
      if (timer) clearTimeout(timer);
      window.removeEventListener(COMMENTS_CHANGED_EVENT, onChanged);
    };
  }, [projectName, slug, reload]);

  const replace = useCallback((next: DesignComment) => {
    setComments((list) => {
      const rest = (list ?? []).filter((c) => c.id !== next.id);
      return [...rest, next].sort(byCreated);
    });
  }, []);

  const add = useCallback(async (anchor: CommentAnchor, body: string) => {
    const created = await createDesignComment(projectName, slug, anchor, body);
    replace(created);
    return created;
  }, [projectName, slug, replace]);

  const update = useCallback(async (id: string, patch: CommentPatch) => {
    const next = await updateDesignComment(projectName, slug, id, patch);
    replace(next);
    return next;
  }, [projectName, slug, replace]);

  const remove = useCallback(async (id: string) => {
    await deleteDesignComment(projectName, slug, id);
    setComments((list) => (list ?? []).filter((c) => c.id !== id));
  }, [projectName, slug]);

  const { open, resolved } = useMemo(() => {
    const sorted = [...(comments ?? [])].sort(byCreated);
    return { open: sorted.filter(isOpenComment), resolved: sorted.filter((c) => !isOpenComment(c)) };
  }, [comments]);

  return { comments, open, resolved, error, reload, add, update, remove };
}
