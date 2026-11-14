/**
 * The manager's answer to a reply the user gave on a card, sent back to where the user replied.
 *
 * A reply is a question as often as an instruction ("go ahead — that won't cost much, right?"), and
 * its answer used to stay inside the manager chat, which a user on their phone never opens. Now the
 * turn the reply opened is followed (`card-reply-followup-tracker.ts`) and, when it ends, its final
 * text is put under the card in PPM and handed to the Telegram bridge, which answers in the chat the
 * reply came from, under the card's message (`assistant-telegram-card-followups.ts`).
 *
 * The text kept on the card is cut to {@link CARD_FOLLOWUP_MAX_CHARS}; what goes to Telegram is
 * further redacted and subject to the project's detail level there, exactly as the card was.
 */
import { createLogger } from "../logger.ts";
import { chatLifecycle } from "../chat-control/chat-lifecycle.ts";
import { chatControl } from "../chat-control/chat-control.ts";
import { resolveMigratedSession } from "../db.service.ts";
import { assistantClock } from "../assistant-wake/assistant-clock.ts";
import { CARD_FOLLOWUP_MAX_CHARS } from "../../shared/assistant-limits.ts";
import type { AssistantCard, CardFollowUp } from "../../shared/assistant-cards.ts";
import { assistantCards, type AssistantCards } from "./assistant-cards.service.ts";
import { createFollowupTracker, cutFollowupText, type FollowupResult, type FollowupTracker } from "./card-reply-followup-tracker.ts";

const log = createLogger("assistant-cards");

/** A finished follow-up, with the card as it is now and what was kept on it. */
export interface CardFollowupDelivery extends FollowupResult {
  card: AssistantCard;
  stored: CardFollowUp;
}

/** Where follow-ups go beyond the card in PPM: the Telegram bridge while it runs. */
export interface CardFollowupSink {
  send(delivery: CardFollowupDelivery): void;
}

export interface CardFollowupDeps {
  cards: Pick<AssistantCards, "get" | "setFollowUp">;
  now(): number;
  sink(): CardFollowupSink | null;
}

/** Keeps the answer on the card, then hands it on; a sink that throws never reaches the chat. */
export function deliverCardFollowup(deps: CardFollowupDeps, result: FollowupResult): void {
  const card = deps.cards.get(result.cardId);
  if (!card) return;
  const cut = cutFollowupText(result.text, CARD_FOLLOWUP_MAX_CHARS, result.overflow);
  const stored: CardFollowUp = { text: cut.text, truncated: cut.truncated, at: deps.now() };
  if (!deps.cards.setFollowUp(card.id, stored)) log.info(`card ${card.id}: the manager's answer is not kept on it (the card waits again)`);
  log.info(`card ${card.id}: the manager answered the user's ${result.origin.channel} reply (${result.text.length} chars${cut.truncated ? ", cut" : ""})`);
  try {
    deps.sink()?.send({ ...result, card: deps.cards.get(card.id) ?? card, stored });
  } catch (e) {
    log.warn(`card ${card.id}: the manager's answer could not be handed on: ${(e as Error).message}`);
  }
}

let sink: CardFollowupSink | null = null;

/** The process-wide tracker; its listeners are attached by {@link startCardReplyFollowups}. */
export const cardReplyFollowups: FollowupTracker = createFollowupTracker({
  canonical: resolveMigratedSession,
  isIdle: (sessionId) => !(chatControl()?.liveState(sessionId)?.running ?? false),
  now: () => assistantClock.now(),
  setTimer: (fn, ms) => assistantClock.setTimer(fn, ms),
  deliver: (result) => deliverCardFollowup({ cards: assistantCards, now: () => assistantClock.now(), sink: () => sink }, result),
});

/** The bridge started: follow-ups also go to Telegram. */
export function attachCardFollowupSink(s: CardFollowupSink): void {
  sink = s;
}

export function detachCardFollowupSink(s?: CardFollowupSink): void {
  if (!s || sink === s) sink = null;
}

/** Starts listening; returns the stop. */
export function startCardReplyFollowups(): () => void {
  const offs = [
    chatLifecycle.on("stream", (e) => cardReplyFollowups.onStream(e.sessionId, e.event)),
    chatLifecycle.on("turn_ended", (e) => cardReplyFollowups.onTurnEnded(e.sessionId, e.turnStillRunning)),
    chatLifecycle.on("migrated", (e) => cardReplyFollowups.onMigrated(e.oldSessionId, e.newSessionId)),
    assistantCards.onChange((card, change) => { if (change === "created") cardReplyFollowups.onCardCreated(card); }),
  ];
  return () => {
    for (const off of offs) off();
    cardReplyFollowups.clear();
  };
}
