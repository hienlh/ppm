import { resolveMigratedSession } from "../db.service.ts";
import type { SessionDelivery } from "../../shared/session-collab.ts";

/**
 * Messages one session's AI sent another that the recipient's AI has not read yet — what
 * `session_status` reports as `unreadReplies`.
 *
 * A delivered message is a user message of the recipient, so "read" means a turn of the recipient
 * took it, not that the recipient's AI asked about it. Counting every delivery until the recipient
 * called `session_status` reported a reply as unread after the recipient had already answered it
 * in the turn the reply opened. A message counts until:
 *
 * - a provider names the turn it went into (`turn_started` with its client id), or
 * - a turn of the recipient ends after it was inserted into that turn or opened it. A message
 *   queued behind an approval or a compaction runs in the turn after the one running when it came,
 *   so it needs two turn ends.
 *
 * A reply handed over as the result of a wait is never added: the waiting call returned it. Holds
 * only ids, never message text.
 */

interface Pending {
  from: string;
  to: string;
  /** Turn ends of the recipient still to come before the message has surely been read. */
  turnEnds: number;
}

const MAX_PENDING = 5_000;

export function createCollabUnread(deps: { canonical: (sessionId: string) => string; max?: number }) {
  /** By client message id, oldest first, so the cap drops the longest-standing entries. */
  const pending = new Map<string, Pending>();
  const max = deps.max ?? MAX_PENDING;
  const same = (a: string, b: string): boolean => a === b || deps.canonical(a) === deps.canonical(b);
  const isPair = (p: Pending, from: string, to: string): boolean => same(p.from, from) && same(p.to, to);

  return {
    /** `from` delivered a message to `to` under `clientMessageId`, and no turn has taken it yet. */
    add(from: string, to: string, clientMessageId: string, delivered: SessionDelivery): void {
      pending.delete(clientMessageId);
      pending.set(clientMessageId, { from, to, turnEnds: delivered === "queued" ? 2 : 1 });
      if (pending.size > max) pending.delete(pending.keys().next().value!);
    },
    /** A provider named the turn this message went into: its AI has it. */
    turnBound(clientMessageId: string): void {
      pending.delete(clientMessageId);
    },
    /** A turn of `sessionId` ended: messages it was given are read, queued ones move up. */
    turnEnded(sessionId: string): void {
      for (const [id, p] of pending) {
        if (!same(p.to, sessionId)) continue;
        if (--p.turnEnds <= 0) pending.delete(id);
      }
    },
    /** Unread messages from `from` to `to`. */
    peek(from: string, to: string): number {
      let n = 0;
      for (const p of pending.values()) if (isPair(p, from, to)) n++;
      return n;
    },
    /** Like {@link peek}, and forgets them: `to` has now been told about them. */
    take(from: string, to: string): number {
      let n = 0;
      for (const [id, p] of pending) {
        if (!isPair(p, from, to)) continue;
        pending.delete(id);
        n++;
      }
      return n;
    },
    size: (): number => pending.size,
  };
}

export type CollabUnread = ReturnType<typeof createCollabUnread>;

export const collabUnread = createCollabUnread({ canonical: (sessionId) => resolveMigratedSession(sessionId) });
