import { useCallback, useEffect, useMemo, useState } from "react";
import {
  addDesignCommentReply, createDesignComment, deleteDesignComment, deleteDesignCommentReply, deleteShareLinkThreads,
  listDesignComments, updateDesignComment, updateDesignCommentReply, type CommentPatch,
} from "@/lib/design/api-design-comments";
import { isOpenComment, type CommentAnchor } from "../../../../shared/design-comment-types";
import type { DesignCommentOwnerView } from "../../../../shared/design-comment-thread-types";

/**
 * One design's comments, kept in step with the server.
 *
 * `.design/` is not watched, so the list refreshes on `design:comments_changed` — which also
 * covers another device commenting on the same design. Every change this client makes is
 * applied locally at once from the server's answer; the event that follows only confirms it.
 * Refetches are debounced, because marking N comments sent is N events. A deleted reply or a
 * link's threads come back with no body to apply, so those are dropped locally the same way.
 */

export const COMMENTS_CHANGED_EVENT = "design:comments_changed";

type Thread = DesignCommentOwnerView;

export interface DesignCommentsState {
  comments: Thread[] | null;
  /** Open comments in the order they were made; a pin's number is its index here plus one. */
  open: Thread[];
  resolved: Thread[];
  error: string | null;
  reload: () => void;
  add: (anchor: CommentAnchor, body: string) => Promise<Thread>;
  update: (id: string, patch: CommentPatch) => Promise<Thread>;
  remove: (id: string) => Promise<void>;
  reply: (id: string, body: string) => Promise<Thread>;
  editReply: (id: string, replyId: string, body: string) => Promise<Thread>;
  removeReply: (id: string, replyId: string) => Promise<void>;
  /** Every thread reviewers on one share link started. */
  removeLinkThreads: (linkId: string) => Promise<void>;
}

const byCreated = (a: Thread, b: Thread) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0);

export function useDesignComments(projectName: string, slug: string): DesignCommentsState {
  const [comments, setComments] = useState<Thread[] | null>(null);
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

  const replace = useCallback((next: Thread) => {
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

  const reply = useCallback(async (id: string, body: string) => {
    const thread = await addDesignCommentReply(projectName, slug, id, body);
    replace(thread);
    return thread;
  }, [projectName, slug, replace]);

  const editReply = useCallback(async (id: string, replyId: string, body: string) => {
    const thread = await updateDesignCommentReply(projectName, slug, id, replyId, body);
    replace(thread);
    return thread;
  }, [projectName, slug, replace]);

  const removeReply = useCallback(async (id: string, replyId: string) => {
    await deleteDesignCommentReply(projectName, slug, id, replyId);
    setComments((list) => (list ?? []).map((c) => (c.id === id ? { ...c, replies: c.replies.filter((r) => r.id !== replyId) } : c)));
  }, [projectName, slug]);

  const removeLinkThreads = useCallback(async (linkId: string) => {
    await deleteShareLinkThreads(projectName, slug, linkId);
    setComments((list) => (list ?? []).filter((c) => !(c.author.kind === "guest" && c.author.linkId === linkId)));
  }, [projectName, slug]);

  const { open, resolved } = useMemo(() => {
    const sorted = [...(comments ?? [])].sort(byCreated);
    return { open: sorted.filter(isOpenComment), resolved: sorted.filter((c) => !isOpenComment(c)) };
  }, [comments]);

  return { comments, open, resolved, error, reload, add, update, remove, reply, editReply, removeReply, removeLinkThreads };
}
