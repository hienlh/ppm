/**
 * Whether the user's OK or reply, forwarded from one of the Assistant's cards, really reached its
 * manager chat — the card says "answered" from the moment the words leave, so a second surface
 * cannot forward too, and this is what keeps that from becoming a lie.
 *
 * Words that started or joined a turn are delivered there and then. Words queued behind the
 * running turn (it waits on an approval) live only in that chat's in-memory queue: they are
 * delivered when the next turn opens with them (`turn_started` names their client id), and lost if
 * the turn dies or PPM restarts first. So:
 * - a `turn_started` naming the words marks the card delivered;
 * - when the manager chat's turn ends with words still pending, the next turn has
 *   {@link DELIVERY_GRACE_MS} to open with them, or the card is opened again with a note;
 * - at startup every card still pending is opened again: nothing queued survives a restart, and
 *   a card answered just before PPM stopped may never have had its words sent at all.
 */
import { createLogger } from "../logger.ts";
import { chatLifecycle } from "../chat-control/chat-lifecycle.ts";
import { resolveMigratedSession } from "../db.service.ts";
import { assistantClock, type AssistantClock, type Cancel } from "../assistant-wake/assistant-clock.ts";
import { assistantCards, type AssistantCards } from "./assistant-cards.service.ts";
import { listUndeliveredAnswerRows, type CardRow } from "./assistant-cards-db.ts";

const log = createLogger("assistant-cards");

/** How long the next turn has to open with words queued behind a turn that ended. */
export const DELIVERY_GRACE_MS = 2 * 60_000;
/** Client ids of turns that opened lately, for words recorded as queued after their turn began. */
const RECENT_BOUND_MAX = 200;

export const NOT_DELIVERED_NOTE = "Your answer did not reach the manager chat; send it again.";

export interface CardDeliveryDeps {
  cards: Pick<AssistantCards, "amendAnswer" | "reopen">;
  undelivered(): CardRow[];
  clock: Pick<AssistantClock, "setTimer">;
  canonical(sessionId: string): string;
}

export function createCardDelivery(deps: CardDeliveryDeps) {
  const recentlyBound: string[] = [];
  const timers = new Map<string, Cancel>();

  function reopen(row: CardRow, why: string): void {
    if (deps.cards.reopen(row.id, NOT_DELIVERED_NOTE)) log.warn(`card ${row.id}: the user's words did not reach the manager chat (${why}); opened again`);
  }

  return {
    /** A turn opened with the message sent under `clientMessageId`. */
    turnBound(clientMessageId: string): void {
      recentlyBound.push(clientMessageId);
      if (recentlyBound.length > RECENT_BOUND_MAX) recentlyBound.splice(0, recentlyBound.length - RECENT_BOUND_MAX);
      for (const row of deps.undelivered()) {
        if (row.answer?.clientMessageId === clientMessageId) deps.cards.amendAnswer(row.id, { delivery: "delivered" });
      }
    },

    turnStarted: (clientMessageId: string): boolean => recentlyBound.includes(clientMessageId),

    /** A chat's turn ended: words queued behind it must open the next one soon. */
    turnEnded(sessionId: string): void {
      const target = deps.canonical(sessionId);
      for (const row of deps.undelivered()) {
        const to = row.answer?.deliveredTo;
        if (!to || deps.canonical(to) !== target || timers.has(row.id)) continue;
        timers.set(row.id, deps.clock.setTimer(() => {
          timers.delete(row.id);
          const still = deps.undelivered().find((r) => r.id === row.id);
          if (still) reopen(still, "no turn opened with them after the turn they waited on ended");
        }, DELIVERY_GRACE_MS));
      }
    },

    /** At startup: nothing queued survived the restart. */
    sweep(): void {
      for (const row of deps.undelivered()) reopen(row, "PPM restarted before they were delivered");
    },

    stop(): void {
      for (const cancel of timers.values()) cancel();
      timers.clear();
    },
  };
}

export type CardDelivery = ReturnType<typeof createCardDelivery>;

/** The process-wide reconciler; its listeners are attached by {@link startCardDelivery}. */
export const cardDelivery = createCardDelivery({
  cards: assistantCards, undelivered: listUndeliveredAnswerRows, clock: assistantClock, canonical: resolveMigratedSession,
});

/** Starts listening and settles what a restart left. Returns the stop. */
export function startCardDelivery(): () => void {
  let gone = false;
  let offBinding: (() => void) | null = null;
  // Loaded on use: the chat socket layer imports the card services.
  void import("../../server/ws/chat.ts").then(({ onTurnBinding }) => {
    if (gone) return;
    offBinding = onTurnBinding((b) => { if (b.clientMessageId) cardDelivery.turnBound(b.clientMessageId); });
  }).catch((e) => log.warn(`turn bindings unavailable for card delivery: ${(e as Error).message}`));
  const offEnded = chatLifecycle.on("turn_ended", (e) => cardDelivery.turnEnded(e.sessionId));
  try {
    cardDelivery.sweep();
  } catch (e) {
    log.warn(`could not settle undelivered card answers: ${(e as Error).message}`);
  }
  return () => { gone = true; offBinding?.(); offEnded(); cardDelivery.stop(); };
}
