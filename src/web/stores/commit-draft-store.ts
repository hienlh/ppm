/**
 * The commit message being written, one per repository, shared by every
 * surface on this page — Source Control, the Review tab — so typing in one
 * shows in the other on the same keystroke.
 *
 * The server holds the copy that other pages and the Git Graph panel read
 * (`/git/commit-draft`). Edits are saved 300 ms after the last keystroke; while
 * one is pending, a change announced from elsewhere is not read back over it.
 * Entries are keyed by the draft's URL, which already names project and repo.
 */
import { create } from "zustand";
import { api } from "@/lib/api-client";
import { uuidV4 } from "@/lib/device-id";
import type { CommitDraft } from "../../shared/git-changes";

/** This page in a `git:commit-draft` broadcast, so it can skip the echo of its own typing. */
export const COMMIT_DRAFT_CLIENT_ID = uuidV4();

const SAVE_DELAY_MS = 300;

interface DraftEntry {
  message: string;
  loaded: boolean;
  /** Typed here and not yet saved. */
  dirty: boolean;
}

interface CommitDraftState {
  drafts: Record<string, DraftEntry>;
  load: (url: string) => Promise<void>;
  edit: (url: string, message: string) => void;
  /**
   * Save now and wait until no save is in flight. A commit waits for this:
   * otherwise a save still on the wire lands after the commit cleared the
   * message, and puts the committed text back.
   */
  flush: (url: string) => Promise<void>;
  /** Another page or panel changed it: read it again, unless an edit here is pending. */
  refresh: (url: string) => Promise<void>;
  /**
   * A commit used `committed`: empty the box and drop any pending save of it — unless
   * the box no longer holds it, i.e. it was typed in while the commit's hooks ran.
   */
  consumed: (url: string, committed: string) => void;
}

const timers = new Map<string, ReturnType<typeof setTimeout>>();
const saving = new Map<string, Promise<void>>();

function cancelSave(url: string): void {
  const timer = timers.get(url);
  if (timer !== undefined) clearTimeout(timer);
  timers.delete(url);
}

export const useCommitDraftStore = create<CommitDraftState>()((set, get) => {
  const patch = (url: string, next: Partial<DraftEntry>) =>
    set((s) => ({
      drafts: { ...s.drafts, [url]: { message: "", loaded: false, dirty: false, ...s.drafts[url], ...next } },
    }));

  const read = async (url: string) => {
    const draft = await api.get<CommitDraft>(url);
    // Typing that started while the read was in flight wins.
    if (get().drafts[url]?.dirty) return;
    patch(url, { message: draft.message, loaded: true });
  };

  return {
    drafts: {},

    load: async (url) => {
      if (get().drafts[url]?.loaded) return;
      await read(url).catch(() => patch(url, { loaded: true }));
    },

    edit: (url, message) => {
      patch(url, { message, dirty: true, loaded: true });
      cancelSave(url);
      timers.set(url, setTimeout(() => { void get().flush(url); }, SAVE_DELAY_MS));
    },

    flush: async (url) => {
      cancelSave(url);
      // One save at a time, in order: a later one must never be overtaken.
      while (saving.has(url)) await saving.get(url)!.catch(() => undefined);
      const entry = get().drafts[url];
      if (!entry?.dirty) return;
      const save = api.put(url, { message: entry.message, clientId: COMMIT_DRAFT_CLIENT_ID }).then(() => undefined);
      saving.set(url, save);
      try {
        await save;
        // Only settle if nothing newer was typed while the save was in flight. A failed
        // save leaves it unsaved, so the older copy on the server is not read back over it.
        if (get().drafts[url]?.message === entry.message) patch(url, { dirty: false });
      } finally {
        saving.delete(url);
      }
    },

    refresh: async (url) => {
      if (get().drafts[url]?.dirty) return;
      await read(url).catch(() => undefined);
    },

    consumed: (url, committed) => {
      if (get().drafts[url]?.message.trim() !== committed.trim()) return;
      cancelSave(url);
      patch(url, { message: "", dirty: false, loaded: true });
    },
  };
});

/** Save whatever is pending before the page goes away. */
if (typeof window !== "undefined") {
  window.addEventListener("pagehide", () => {
    for (const url of [...timers.keys()]) void useCommitDraftStore.getState().flush(url);
  });
}
