/**
 * Line comments left in a chat's Review tab, per session, kept on this device until they are sent
 * to the chat (or cleared). Saved in `localStorage` so a reload or a closed tab loses none.
 */
import { create } from "zustand";
import type { ReviewLineComment } from "@/lib/line-comments";

const KEY = "ppm.reviewComments";
/** Sessions whose comments are kept; the oldest unsent ones go past this. */
const MAX_SESSIONS = 50;

type BySession = Record<string, ReviewLineComment[]>;

function read(): BySession {
  try {
    const raw = globalThis.localStorage?.getItem(KEY);
    const parsed = raw ? JSON.parse(raw) as unknown : null;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as BySession : {};
  } catch {
    return {};
  }
}

function write(all: BySession): void {
  const keys = Object.keys(all);
  const kept = keys.length > MAX_SESSIONS ? Object.fromEntries(keys.slice(-MAX_SESSIONS).map((k) => [k, all[k]!])) : all;
  try { globalThis.localStorage?.setItem(KEY, JSON.stringify(kept)); } catch { /* full or private: this session only */ }
}

interface ReviewCommentsState {
  bySession: BySession;
  /** Add a comment, or replace the one with the same id; an empty body removes it. */
  save: (sessionId: string, comment: ReviewLineComment) => void;
  remove: (sessionId: string, id: string) => void;
  clear: (sessionId: string) => void;
}

export const useReviewComments = create<ReviewCommentsState>((set, get) => {
  const put = (sessionId: string, list: ReviewLineComment[]) => {
    const next = { ...get().bySession };
    if (list.length) {
      // Re-inserted, so the session most recently commented on is the last one trimmed.
      delete next[sessionId];
      next[sessionId] = list;
    } else delete next[sessionId];
    write(next);
    set({ bySession: next });
  };
  return {
    bySession: read(),
    save: (sessionId, comment) => {
      const list = (get().bySession[sessionId] ?? []).filter((c) => c.id !== comment.id);
      put(sessionId, comment.body.trim() ? [...list, comment] : list);
    },
    remove: (sessionId, id) => put(sessionId, (get().bySession[sessionId] ?? []).filter((c) => c.id !== id)),
    clear: (sessionId) => put(sessionId, []),
  };
});

const NONE: ReviewLineComment[] = [];
export function useSessionReviewComments(sessionId: string | undefined): ReviewLineComment[] {
  return useReviewComments((s) => (sessionId ? s.bySession[sessionId] ?? NONE : NONE));
}

/** The id of the comment on one line: one comment per line and side. */
export function reviewCommentId(path: string, side: "new" | "old", line: number): string {
  return path + "\n" + side + "\n" + line;
}
