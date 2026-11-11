/**
 * Starts PPM Assistant's cards: what PPM sees in manager chats, the rules and budget events, the
 * two manager news sources of the wake queue, and the restart sweep. Called by the Assistant hub's
 * startup, after the watch service, so every unattended turn goes through the one wake queue.
 */
import { chatLifecycle } from "../chat-control/chat-lifecycle.ts";
import { chatControl } from "../chat-control/chat-control.ts";
import { addNotificationSuppressor } from "../chat-control/notification-suppressor.ts";
import { managerChats } from "../assistant-managers/manager-chats.service.ts";
import { managerRulesEvents } from "../assistant-managers/manager-rules-events.ts";
import { assistantBudgetEvents } from "../assistant/assistant-budget-events.ts";
import { getMainSession } from "../assistant/assistant-main-session.ts";
import { assistantClock } from "../assistant-wake/assistant-clock.ts";
import { assistantWakeQueue } from "../assistant-wake/assistant-wake-queue.ts";
import { createCardWakeSource, createLateReplySource } from "../assistant-wake/manager-wake-sources.ts";
import { createLogger } from "../logger.ts";
import { assistantCards } from "./assistant-cards.service.ts";
import { countSessionCardsSince, findOpenCardsBy, findOpenRequestCard } from "./assistant-cards-db.ts";
import { budgetEventCard, rulesEventCard, type EventCardsDeps } from "./assistant-event-cards.ts";
import { sweepGoneRequestCards } from "./assistant-card-actions.ts";
import { startCardDelivery } from "./card-delivery.ts";
import { createManagerSignals, type ManagerSignals } from "./manager-signals.ts";
import { setManagerAskedHook } from "./manager-reply-expectations.ts";

const log = createLogger("assistant-cards");

let stops: Array<() => void> = [];
let signals: ManagerSignals | null = null;

const mainSessionId = (): string | null => {
  try {
    return getMainSession()?.sessionId ?? null;
  } catch {
    return null;
  }
};

export function startAssistantCards(): void {
  if (signals) return;
  const lateReplies = createLateReplySource((id) => assistantWakeQueue.schedule(id));
  const eventDeps: EventCardsDeps = {
    cards: assistantCards, now: () => assistantClock.now(), openBy: (kind, field, value) => findOpenCardsBy(kind, field, value),
  };
  signals = createManagerSignals({
    lifecycle: chatLifecycle,
    cards: assistantCards,
    clock: assistantClock,
    managerFor: (sessionId) => managerChats.forSession(sessionId),
    openRequestCard: findOpenRequestCard,
    reportsSince: (sessionId, kinds, since) => countSessionCardsSince([sessionId], kinds, since),
    lateReply: (reply) => lateReplies.add(reply),
  });
  signals.start();
  const live = signals;
  setManagerAskedHook((assistant, manager, project, queued) => live.expectReply(assistant, manager, project, queued));
  stops = [
    assistantWakeQueue.addSource(createCardWakeSource({
      mainSession: mainSessionId,
      projectNameOf: (row) => assistantCards.toCard(row).projectName ?? "a project",
      setWake: (id, wake) => assistantCards.setWake(id, wake),
    })),
    assistantWakeQueue.addSource(lateReplies),
    // A new card may carry news: the main session hears of it as soon as the queue lets it.
    assistantCards.onChange((_card, change) => {
      const main = mainSessionId();
      if (change === "created" && main) assistantWakeQueue.schedule(main);
    }),
    managerRulesEvents.on((e) => rulesEventCard(eventDeps, e)),
    assistantBudgetEvents.on((e) => budgetEventCard(eventDeps, e)),
    // A turn that only carries manager news needs no "Chat completed": its cards are the news.
    // A watch report keeps its own push (the watch service's), so a batch with one is left alone.
    addNotificationSuppressor((sessionId, kind) => {
      const sources = assistantWakeQueue.carrying(sessionId);
      return kind === "done" && sources.length > 0 && !sources.includes("watch");
    }),
  ];
  // An answer whose words never reached its manager chat opens its card again (now, for a restart).
  stops.push(startCardDelivery());
  try {
    sweepGoneRequestCards({ cards: assistantCards, control: chatControl, now: () => assistantClock.now() });
  } catch (e) {
    log.warn(`could not settle the cards a restart left: ${(e as Error).message}`);
  }
  // News a restart left pending goes out on the queue's first tick.
  assistantWakeQueue.start();
  assistantWakeQueue.tick();
  log.info("Assistant cards started");
}

export function stopAssistantCards(): void {
  for (const stop of stops) stop();
  stops = [];
  signals?.stop();
  signals = null;
  setManagerAskedHook(null);
}
