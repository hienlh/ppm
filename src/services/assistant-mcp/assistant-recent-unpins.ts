/**
 * Chats the Assistant unpinned itself in the last day, held in memory only. A pin is the user's
 * "keep this one", so a later card that would delete the chat says it was pinned until the
 * Assistant took the pin away: two calls, each harmless to look at, must not add up to deleting
 * something the user marked to keep without the card saying so.
 *
 * Lost on a restart, which only ever makes a card say less than it could; the pin itself is in
 * PPM's database and every card reads that first.
 */

export const RECENT_UNPIN_WINDOW_MS = 24 * 60 * 60 * 1000;
/** Bounds the record against a runaway loop; the oldest entries go first. */
const MAX_RECORDED = 500;

export interface RecentUnpins {
  /** The Assistant took the pin off `sessionId` at `at`. */
  record(sessionId: string, at: number): void;
  /** When the Assistant unpinned the chat within the window before `now`, or null. */
  unpinnedAt(sessionId: string, now: number): number | null;
  /** The chat was pinned again or deleted: nothing left to tell. */
  forget(sessionId: string): void;
}

export function createRecentUnpins(windowMs: number = RECENT_UNPIN_WINDOW_MS): RecentUnpins {
  const unpins = new Map<string, number>();
  const prune = (now: number) => {
    for (const [id, at] of unpins) if (now - at > windowMs) unpins.delete(id);
  };
  return {
    record(sessionId, at) {
      prune(at);
      unpins.delete(sessionId);
      unpins.set(sessionId, at);
      while (unpins.size > MAX_RECORDED) unpins.delete(unpins.keys().next().value!);
    },
    unpinnedAt(sessionId, now) {
      const at = unpins.get(sessionId);
      return at !== undefined && now - at <= windowMs ? at : null;
    },
    forget(sessionId) {
      unpins.delete(sessionId);
    },
  };
}

export const assistantRecentUnpins: RecentUnpins = createRecentUnpins();
