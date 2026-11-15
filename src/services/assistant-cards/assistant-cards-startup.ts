/**
 * Starts PPM Assistant's cards: what PPM sees in manager chats (and the cards other chats wait on),
 * the rules and budget events, the
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
import { CARD_RETENTION_MS, countSessionCardsSince, findOpenCardsBy, findOpenRequestCard, pruneOldCardRows } from "./assistant-cards-db.ts";
import { budgetEventCard, rulesEventCard, type EventCardsDeps } from "./assistant-event-cards.ts";
import { sweepGoneRequestCards } from "./assistant-card-actions.ts";
import { startCardDelivery } from "./card-delivery.ts";
import { cardReplyFollowups, startCardReplyFollowups } from "./card-reply-followup.ts";
import { createManagerSignals, type ManagerSignals } from "./manager-signals.ts";
import { setManagerAskedHook } from "./manager-reply-expectations.ts";
import { ordinaryChatFor, type OrdinaryChatDeps } from "./ordinary-chat-cards.ts";
import { configService } from "../config.service.ts";
import { getSessionDesignSlug, getSessionTitle, resolveMigratedSession } from "../db.service.ts";
import { turnSecretScrubber } from "../vault/turn-secret-scrubber.ts";
import { chatService } from "../chat.service.ts";
import { isAssistantSession } from "../assistant/assistant-session.ts";
import { parentOf } from "../session-collab/session-links.service.ts";

const log = createLogger("assistant-cards");

/** Where the chats whose cards the Assistant shows are told apart and named (`ordinary-chat-cards.ts`). */
const ordinaryChatDeps: OrdinaryChatDeps = {
  projects: () => configService.get("projects"),
  isAssistant: (sessionId) => isAssistantSession(sessionId),
  isManager: (sessionId) => managerChats.forSession(sessionId) !== null,
  isDesign: (sessionId) => getSessionDesignSlug(resolveMigratedSession(sessionId)) !== null,
  parentOf,
  turnOrigin: (sessionId) => chatControl()?.liveState(sessionId)?.turnOrigin,
  // The user's rename, else the title the chat shows (its provider's, from the first message).
  title: (sessionId) => getSessionTitle(sessionId) || chatService.getSession(sessionId)?.title || null,
};

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
    chatFor: (p) => ordinaryChatFor(p, ordinaryChatDeps),
    // A vault value the turn read never reaches the card store, its broadcast or a backup.
    scrub: (value, sessionId) => turnSecretScrubber.scrubIn(value, sessionId),
    openRequestCard: findOpenRequestCard,
    reportsSince: (sessionId, kinds, since) => countSessionCardsSince([sessionId], kinds, since),
    lateReply: (reply) => lateReplies.add(reply),
    // Started before the follow-ups below, so a turn's reply is still known when it ends.
    answersCardReply: (sessionId) => cardReplyFollowups.answering(sessionId).length > 0,
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
  // The manager's answer to a reply on a card goes back to where the user replied.
  stops.push(startCardReplyFollowups());
  try {
    const pruned = pruneOldCardRows(assistantClock.now() - CARD_RETENTION_MS);
    if (pruned > 0) log.info(`${pruned} card(s) older than 90 days and no longer waiting removed`);
  } catch (e) {
    log.warn(`could not prune old cards: ${(e as Error).message}`);
  }
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
