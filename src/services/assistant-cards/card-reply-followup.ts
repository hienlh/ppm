/**
 * The manager's answer to a reply the user gave on a card, sent back to where the user replied.
 *
 * A reply is a question as often as an instruction ("go ahead — that won't cost much, right?"), and
 * its answer used to stay inside the manager chat, which a user on their phone never opens. Now the
 * turn the reply opened is followed (`card-reply-followup-tracker.ts`) and, when it ends, its final
 * text is put under the card in PPM and handed to the Telegram bridge, which answers in the chat the
 * reply came from, under the card's message (`assistant-telegram-card-followups.ts`).
 *
 * A turn that opened a card answered with it: the card is kept as the answer (`newCards`) and the
 * turn's text is dropped, since it says what the card says and the two read as one message twice.
 *
 * The text kept on the card is cut to {@link CARD_FOLLOWUP_MAX_CHARS}; what goes to Telegram is
 * further redacted and subject to the project's detail level there, exactly as the card was.
 */
import { createLogger } from "../logger.ts";
import { chatLifecycle, type ChatLifecycleEvents } from "../chat-control/chat-lifecycle.ts";
import { chatControl } from "../chat-control/chat-control.ts";
import { resolveMigratedSession } from "../db.service.ts";
import { assistantClock } from "../assistant-wake/assistant-clock.ts";
import { CARD_FOLLOWUP_MAX_CHARS } from "../../shared/assistant-limits.ts";
import type { AssistantCard, CardFollowUp } from "../../shared/assistant-cards.ts";
import { assistantCards, type AssistantCards } from "./assistant-cards.service.ts";
import { turnSecretScrubber } from "../vault/turn-secret-scrubber.ts";
import { CARD_REPLY_PREVIEW_CHARS, markdownPreview } from "../../shared/plain-text-preview.ts";
import {
  createFollowupTracker, cutFollowupText, type FollowupResult, type FollowupTracker, type TurnOutcome,
} from "./card-reply-followup-tracker.ts";

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
export function deliverCardFollowup(deps: CardFollowupDeps, input: FollowupResult): void {
  // The user's words go no further than the preview kept on the card: nothing on the way out needs
  // them, and they are not scrubbed until they are stored.
  const { reply: replied, ...result } = input;
  const card = deps.cards.get(result.cardId);
  if (!card) return;
  if (result.stopped) {
    // Nothing to keep under the card: partial text is not an answer. A reply typed in PPM has the
    // manager chat a click away; one typed on Telegram is told, since the user waits there.
    log.info(`card ${card.id}: the manager's turn was stopped before it answered the user's ${result.origin.channel} reply`);
    if (result.origin.channel !== "telegram" || card.status === "open") return;
    handOn(deps, { ...result, card, stored: { text: "", truncated: false, at: deps.now() } });
    return;
  }
  // The manager's answer is the AI's own text: a vault value it repeats is replaced before the card
  // keeps it (in `ppm.db`) or it is handed on — and before the cut, so the cut cannot halve one.
  // The new cards' titles are the AI's text too, named under this card and in Telegram's pointer line.
  const text = turnSecretScrubber.scrub(result.text);
  const newCards = result.newCards.map((c) => ({ id: c.id, title: turnSecretScrubber.scrub(c.title) }));
  // A new card is the answer: the turn's text only says again what the card says, so only the card
  // is named under this one (and the bridge sends the card itself under the user's message).
  const answeredWithCard = newCards.length > 0;
  const cut = answeredWithCard ? { text: "", truncated: false } : cutFollowupText(text, CARD_FOLLOWUP_MAX_CHARS, result.overflow);
  // The start of the user's own reply, shown with the answer on a folded card. PPM writes it into
  // `ppm.db`, so it is scrubbed like the answer, and whole before it is cut.
  const reply = markdownPreview(turnSecretScrubber.scrub(replied ?? ""), CARD_REPLY_PREVIEW_CHARS);
  const stored: CardFollowUp = {
    text: cut.text, truncated: cut.truncated, at: deps.now(), ...(answeredWithCard ? { newCards } : {}),
    ...(reply ? { reply } : {}),
  };
  if (!deps.cards.setFollowUp(card.id, stored)) {
    // The card waits again ("your answer did not reach the manager chat; send it again"): an answer
    // on the phone would contradict it, and the user would send the same words twice.
    log.info(`card ${card.id}: the manager's answer is not sent (the card waits again)`);
    return;
  }
  log.info(answeredWithCard
    ? `card ${card.id}: the manager answered the user's ${result.origin.channel} reply with ${newCards.length} new card(s) (${newCards.map((c) => c.id).join(", ")}); its text is not passed on`
    : `card ${card.id}: the manager answered the user's ${result.origin.channel} reply (${text.length} chars${cut.truncated ? ", cut" : ""})`);
  handOn(deps, { ...result, text, newCards, card: deps.cards.get(card.id) ?? card, stored });
}

function handOn(deps: CardFollowupDeps, delivery: CardFollowupDelivery): void {
  try {
    deps.sink()?.send(delivery);
  } catch (e) {
    log.warn(`card ${delivery.card.id}: the manager's answer could not be handed on: ${(e as Error).message}`);
  }
}

let sink: CardFollowupSink | null = null;

/** The process-wide tracker; its listeners are attached by {@link startCardReplyFollowups}. */
export const cardReplyFollowups: FollowupTracker = createFollowupTracker({
  canonical: resolveMigratedSession,
  isIdle: (sessionId) => !(chatControl()?.liveState(sessionId)?.running ?? false),
  turnId: (sessionId) => chatControl()?.liveState(sessionId)?.turnId,
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

/**
 * How a turn ended, for the follow-up. A Stop is not always reported as `stopped`: on the first turn
 * of a fresh Claude subprocess the provider ends an aborted turn with a normal `done`, and the turn
 * stop is not recorded, so `turn_ended` says `done` with `cancelledBy` set. Whoever asked, a turn
 * cut short has no answer.
 */
export function followupOutcome(e: Pick<ChatLifecycleEvents["turn_ended"], "outcome" | "cancelledBy">): TurnOutcome {
  return e.cancelledBy ? "stopped" : e.outcome;
}

/** Starts listening; returns the stop. */
export function startCardReplyFollowups(): () => void {
  const offs = [
    chatLifecycle.on("stream", (e) => cardReplyFollowups.onStream(e.sessionId, e.event)),
    chatLifecycle.on("turn_ended", (e) => cardReplyFollowups.onTurnEnded(e.sessionId, {
      outcome: followupOutcome(e), ...(e.turnStillRunning ? { turnStillRunning: true } : {}),
    })),
    chatLifecycle.on("migrated", (e) => cardReplyFollowups.onMigrated(e.oldSessionId, e.newSessionId)),
    assistantCards.onChange((card, change) => { if (change === "created") cardReplyFollowups.onCardCreated(card); }),
  ];
  return () => {
    for (const off of offs) off();
    cardReplyFollowups.clear();
  };
}
