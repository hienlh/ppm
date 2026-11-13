import { resolveMigratedSession } from "../db.service.ts";
import type { SessionDelivery, SessionWaitOutcome, WaitingCard } from "../../shared/session-collab.ts";

/**
 * Calls made with `wait: true`, each waiting for one other session to answer. A wait holds only
 * ids, a timer and a promise — never transcript text.
 *
 * Whatever ends a wait ends it once: the first of a reply, the target's turn ending, the timeout,
 * or a cancellation settles it, and every later one finds nothing to settle. A reply that finds no
 * wait (it came after the timeout, or after the waiter was stopped) is the caller's to deliver as a
 * new message; this module never drops or delivers anything itself.
 *
 * "The turn ended without a reply" must mean the turn that read the message. A provider names that
 * turn (`turn_started` with the message's client id, {@link CollabWaits.turnBound}); the first turn
 * end after that is the one. A message no provider named is judged after a short grace: if the
 * target is idle then, the message was read and nothing more is coming; if a new turn started, the
 * message went into that one and the wait goes on.
 *
 * A target that puts a card in front of the user (an approval, a question) can neither read the
 * message nor answer until the user does, which may be never: the wait ends at once as
 * `waiting_for_user`, naming the card, so the waiting AI can tell its user what is in the way
 * instead of sitting out the timeout in silence. A card already showing when the message is
 * delivered counts too ({@link WaitHandle.attach} is told what the target shows then). A session
 * tool's card the target raised to message the waiter itself does not: it stands between the wait
 * and its reply, which, once the user allows it, is the wait's result.
 */

export interface WaitReply {
  text: string;
  turnId?: string;
  sentAt: string;
}

export interface BeginWait {
  waiter: string;
  target: string;
  timeoutMs: number;
  /** The tool call's own request: a provider that gave up on the call cancels the wait. */
  signal?: AbortSignal;
}

/**
 * A wait registered before its message is delivered, so a reply that comes back faster than the
 * delivery returns is still the wait's. Until `attach`, turn ends of the target are not judged:
 * they belong to whatever the target was doing before the message reached it.
 */
export interface WaitHandle {
  outcome: Promise<SessionWaitOutcome>;
  /**
   * The message was delivered under `clientMessageId`; `bound` when its turn is already named,
   * `waitingCard` when the target was showing the user a card as the delivery returned.
   */
  attach(clientMessageId: string, delivered: SessionDelivery, bound: boolean, waitingCard: WaitingCard | null): void;
  /** Whether a turn of the target has taken the message (it was named), as far as is known now. */
  taken(): boolean;
  /** The message was never delivered: the wait ends without anyone hearing of it. */
  abandon(): void;
}

export type BeginOutcome = { ok: true; wait: WaitHandle } | { ok: false; message: string };

interface Wait {
  waiter: string;
  target: string;
  clientMessageId: string | null;
  bound: boolean;
  /** The order of the target's last turn end seen before `attach`, if any. */
  endedBeforeAttach: number | null;
  settle: (outcome: SessionWaitOutcome) => void;
}

/** How long after a turn ends an unnamed message is judged, so a queued turn can start first. */
export const UNBOUND_TURN_GRACE_MS = 3_000;
/** Turn names kept for a delivery that has not reached its wait yet; older ones are dropped. */
const MAX_RECENTLY_BOUND = 200;

export function createCollabWaits(deps: {
  canonical: (sessionId: string) => string;
  /** Whether the session has no turn running now. */
  isIdle: (sessionId: string) => boolean;
  graceMs?: number;
}) {
  const waits = new Set<Wait>();
  /** Turn names that came before their wait was attached, with the order they came in. */
  const recentlyBound = new Map<string, number>();
  /** Orders turn names and turn ends, so `attach` can tell whether the named turn has ended. */
  let seq = 0;
  const graceMs = deps.graceMs ?? UNBOUND_TURN_GRACE_MS;
  const same = (a: string, b: string): boolean => a === b || deps.canonical(a) === deps.canonical(b);

  function begin(input: BeginWait): BeginOutcome {
    for (const w of waits) {
      if (same(w.waiter, input.waiter) && same(w.target, input.target)) {
        return { ok: false, message: "You are already waiting for this session; one wait per session at a time." };
      }
    }
    let wait!: Wait;
    const outcome = new Promise<SessionWaitOutcome>((done) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const onAbort = () => wait.settle({ replied: false, reason: "cancelled" });
      wait = {
        waiter: input.waiter, target: input.target, clientMessageId: null, bound: false, endedBeforeAttach: null,
        settle: (result) => {
          if (!waits.delete(wait)) return;
          if (timer) clearTimeout(timer);
          input.signal?.removeEventListener("abort", onAbort);
          done(result);
        },
      };
      waits.add(wait);
      if (input.signal?.aborted) return wait.settle({ replied: false, reason: "cancelled" });
      input.signal?.addEventListener("abort", onAbort, { once: true });
      timer = setTimeout(() => wait.settle({ replied: false, reason: "timeout" }), Math.max(0, input.timeoutMs));
    });
    return {
      ok: true,
      wait: {
        outcome,
        attach: (clientMessageId, _delivered, bound, waitingCard) => {
          wait.clientMessageId = clientMessageId;
          const boundAt = recentlyBound.get(clientMessageId);
          recentlyBound.delete(clientMessageId);
          wait.bound = wait.bound || bound || boundAt !== undefined;
          // The turn that took the message was named, and ended, before the delivery returned.
          if (boundAt !== undefined && wait.endedBeforeAttach !== null && wait.endedBeforeAttach > boundAt) {
            wait.settle({ replied: false, reason: "turn_ended_without_reply" });
            return;
          }
          // A card the target showed during the delivery counts only while it still shows one:
          // answered meanwhile, the target is free to reply.
          if (waitingCard) wait.settle({ replied: false, reason: "waiting_for_user", card: waitingCard });
        },
        taken: () => wait.bound,
        abandon: () => wait.settle({ replied: false, reason: "cancelled" }),
      },
    };
  }

  /**
   * `sender` messaged `recipient`: if `recipient` is waiting for `sender`, the message is that
   * wait's reply and the call returns it. True when a wait took it — then it must not also be
   * delivered as a message.
   */
  function claimReply(sender: string, recipient: string, reply: WaitReply): boolean {
    for (const w of waits) {
      if (!same(w.waiter, recipient) || !same(w.target, sender)) continue;
      w.settle({ replied: true, text: reply.text, ...(reply.turnId ? { turnId: reply.turnId } : {}), sentAt: reply.sentAt });
      return true;
    }
    return false;
  }

  /** The waiter was stopped, or the user wrote to it: its waits end as cancelled. */
  function cancelWaiter(waiter: string): number {
    let n = 0;
    for (const w of [...waits]) {
      if (!same(w.waiter, waiter)) continue;
      w.settle({ replied: false, reason: "cancelled" });
      n++;
    }
    return n;
  }

  /**
   * A provider named the turn a delivered message went into. It can do so before the delivery has
   * returned to its wait, so recent names are kept for `attach` to find.
   */
  function turnBound(clientMessageId: string): void {
    let matched = false;
    for (const w of waits) {
      if (w.clientMessageId !== clientMessageId) continue;
      w.bound = true;
      matched = true;
    }
    if (matched) return;
    recentlyBound.set(clientMessageId, ++seq);
    if (recentlyBound.size > MAX_RECENTLY_BOUND) recentlyBound.delete(recentlyBound.keys().next().value!);
  }

  /**
   * A turn of `sessionId` ended. A wait whose waiter it is cannot still be in its tool call, so it
   * is over; a wait on it as the target ends without a reply once that turn read the message.
   */
  function turnEnded(sessionId: string): void {
    for (const w of [...waits]) {
      if (same(w.waiter, sessionId)) {
        w.settle({ replied: false, reason: "cancelled" });
        continue;
      }
      if (!same(w.target, sessionId)) continue;
      // Not attached yet: remembered, and judged by `attach` against when the message's turn was named.
      if (w.clientMessageId === null) {
        w.endedBeforeAttach = ++seq;
        continue;
      }
      if (w.bound) {
        w.settle({ replied: false, reason: "turn_ended_without_reply" });
        continue;
      }
      const timer = setTimeout(() => {
        if (!waits.has(w) || w.bound) return;
        if (deps.isIdle(w.target)) w.settle({ replied: false, reason: "turn_ended_without_reply" });
      }, graceMs);
      (timer as { unref?: () => void }).unref?.();
    }
  }

  /**
   * `sessionId` put a card in front of the user: every wait on it ends now with that card (see the
   * header), except the wait of `raisedFor`, the session the card was raised to message. A wait
   * whose delivery has not returned yet is judged by `attach`, against what the target shows then.
   */
  function targetWaitingForUser(sessionId: string, card: WaitingCard, raisedFor: string | null = null): number {
    let n = 0;
    for (const w of [...waits]) {
      if (!same(w.target, sessionId) || w.clientMessageId === null) continue;
      if (raisedFor !== null && same(w.waiter, raisedFor)) continue;
      w.settle({ replied: false, reason: "waiting_for_user", card });
      n++;
    }
    return n;
  }

  return {
    begin, claimReply, cancelWaiter, turnBound, turnEnded, targetWaitingForUser,
    isWaiting: (waiter: string, target: string): boolean => [...waits].some((w) => same(w.waiter, waiter) && same(w.target, target)),
    /** Every session `waiter` is waiting for now. */
    targetsOf: (waiter: string): string[] => [...waits].filter((w) => same(w.waiter, waiter)).map((w) => w.target),
    size: () => waits.size,
  };
}

export type CollabWaits = ReturnType<typeof createCollabWaits>;

let idleProbe: (sessionId: string) => boolean = () => true;

/** `ws/chat.ts` owns the sessions' phases; it registers how to ask whether one is idle. */
export function setCollabIdleProbe(probe: (sessionId: string) => boolean): void {
  idleProbe = probe;
}

export const collabWaits = createCollabWaits({
  canonical: (sessionId) => resolveMigratedSession(sessionId),
  isIdle: (sessionId) => idleProbe(sessionId),
});
