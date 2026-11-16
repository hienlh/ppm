/**
 * The user's OK on a needs-decision card, and the user's own reply to a card — from PPM or from
 * Telegram, through the same checks.
 *
 * - **OK** is an approval. It is offered only where the whole decision is shown and nothing hidden
 *   (`card-ok-rule.ts`), names the exact draft by its hash, and is compare-and-set on the card:
 *   the first OK on any surface wins and forwards once; a later one is told who answered, when.
 * - **A choice** works the same on a card that offers several (`payload.options`): the button names
 *   one option by its id, the server looks that option up on the stored card, and forwards it with
 *   its id and label in the user-words block. Such a card takes no OK, and an ordinary card no choice.
 * - **A reply** goes word for word to the card's manager chat. A card that no longer waits, or is
 *   older than {@link STALE_REPLY_MS}, asks first ("send anyway?"). A reply to an approval or
 *   question card refuses that request, as typing in the manager chat would. The manager's answer
 *   to a reply comes back to where it was typed (`card-reply-followup.ts`); an OK gets none.
 *
 * The card is marked answered before the words leave, so a second surface cannot forward too; if
 * the forward fails, the card is opened again and the error said. Until the manager chat has taken
 * the words into a turn the answer stays `delivery: "pending"`: a restart, or a queue that dies
 * with its turn, opens the card again rather than leaving it saying the answer was given.
 */
import { assistantCards, type AssistantCards } from "./assistant-cards.service.ts";
import { assistantClock } from "../assistant-wake/assistant-clock.ts";
import { getAssistantSettings } from "../assistant/assistant-settings.service.ts";
import { CARD_REPLY_MAX_CHARS, STALE_REPLY_MS } from "../../shared/assistant-limits.ts";
import { OK_CARD_KINDS, type AssistantCard, type AssistantCardAnswer } from "../../shared/assistant-cards.ts";
import { cardOkOffered } from "./card-ok-rule.ts";
import { forwardUserWords, repliesToManager, type CardActor, type ForwardHow, type ForwardResult } from "./forward-verbatim.ts";
import { realForwardEnv } from "./forward-verbatim-env.ts";
import { cardDelivery } from "./card-delivery.ts";
import { validateReplyImages } from "./card-reply-images.ts";
import type { FollowupOrigin } from "./card-reply-followup-tracker.ts";

export type CardReplyResult =
  | { ok: true; card: AssistantCard; to: "manager" | "assistant"; projectName?: string }
  | { ok: false; status: 400 | 404 | 409 | 502; error: string; card?: AssistantCard; question?: string };

export interface CardReplyDeps {
  cards: AssistantCards;
  now(): number;
  /** The user's time zone (Settings), for the times the user is told. */
  zone(): string | undefined;
  forward(card: AssistantCard, text: string, how: ForwardHow): Promise<ForwardResult>;
  /** Whether a turn already opened with the words sent under this id (they were taken in). */
  turnStarted?(clientMessageId: string): boolean;
}

const realDeps: CardReplyDeps = {
  cards: assistantCards,
  now: () => assistantClock.now(),
  zone: () => getAssistantSettings().timezone,
  forward: (card, text, how) => forwardUserWords(card, text, how, realForwardEnv),
  turnStarted: (clientMessageId) => cardDelivery.turnStarted(clientMessageId),
};

const SHA256_RE = /^[0-9a-f]{64}$/;

/**
 * How the words went in, on the card this caller answered. Words that started or joined a turn
 * reached the model; words queued behind the running turn (a waiting approval) live only in that
 * chat's queue until the next turn opens with them, so the card stays `pending` until the
 * reconciler (`card-delivery.ts`) sees that turn start, or opens the card again if it never does.
 */
function recordDelivery(deps: CardReplyDeps, id: string, forwarded: Extract<ForwardResult, { ok: true }>): void {
  if (forwarded.to === "manager" && forwarded.delivered === "queued" && forwarded.clientMessageId
    && !(deps.turnStarted?.(forwarded.clientMessageId) ?? false)) {
    deps.cards.amendAnswer(id, { delivery: "pending", clientMessageId: forwarded.clientMessageId, deliveredTo: forwarded.sessionId });
    return;
  }
  deps.cards.amendAnswer(id, { delivery: "delivered", ...(forwarded.to === "manager" ? { deliveredTo: forwarded.sessionId } : {}) });
}
/**
 * Where the manager's answer to a reply goes back: the Telegram chat it was typed in (under the
 * card's message there), or the card in PPM. An OK gets none: it decides, it does not ask.
 */
export function followupOrigin(actor: CardActor): FollowupOrigin | null {
  if (actor.channel === "ppm") return { channel: "ppm" };
  if (!actor.telegramChatId) return null;
  return {
    channel: "telegram", chatId: actor.telegramChatId,
    ...(actor.telegramReplyTo ? { replyTo: actor.telegramReplyTo } : {}),
    ...(actor.telegramMessageId ? { messageId: actor.telegramMessageId } : {}),
  };
}

const where = (channel: string): string => (channel === "telegram" ? "on Telegram" : channel === "chat" ? "in the manager chat" : "in PPM");

/** "14:02" today, "9 Nov 14:02" another day, in the user's zone. */
export function cardTimeText(ms: number, now: number, zone?: string): string {
  const fmt = (opts: Intl.DateTimeFormatOptions) => {
    try {
      return new Intl.DateTimeFormat("en-GB", { ...opts, ...(zone ? { timeZone: zone } : {}) }).format(ms);
    } catch {
      return new Intl.DateTimeFormat("en-GB", opts).format(ms);
    }
  };
  const time = fmt({ hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  return dayKey(ms, zone) === dayKey(now, zone) ? time : `${fmt({ day: "numeric", month: "short" })} ${time}`;
}

function dayKey(ms: number, zone?: string): string {
  try {
    return new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit", ...(zone ? { timeZone: zone } : {}) }).format(ms);
  } catch {
    return new Date(ms).toDateString();
  }
}

/** "Already answered on Telegram at 22:41": what a second answer is told. */
export function alreadyAnsweredText(card: AssistantCard, now: number, zone?: string): string {
  const a = card.answer;
  if (!a) return "This card is no longer waiting.";
  return `Already answered ${where(a.channel)} at ${cardTimeText(a.at, now, zone)}.`;
}

/** The question a reply to a stale card asks before anything is sent. */
export function staleQuestion(card: AssistantCard, now: number, zone?: string): string {
  if (card.status !== "open") {
    const at = card.answer?.at ?? card.updatedAt;
    return `This card was ${card.status === "answered" ? "answered" : "closed"} at ${cardTimeText(at, now, zone)} — send anyway?`;
  }
  return `This card is from ${cardTimeText(card.createdAt, now, zone)} — send anyway?`;
}

/** The checks a pressed answer (OK or a choice) shares: a card that takes one, open, shown whole. */
function pressRefusal(card: AssistantCard | null, deps: CardReplyDeps, what: "an OK" | "a choice"): CardReplyResult | null {
  if (!card) return { ok: false, status: 404, error: "No such card" };
  if (!OK_CARD_KINDS.includes(card.kind)) return { ok: false, status: 400, error: `This card does not take ${what}` };
  if (card.status !== "open") return { ok: false, status: 409, error: "already_answered", card, question: alreadyAnsweredText(card, deps.now(), deps.zone()) };
  if (!cardOkOffered(card)) return { ok: false, status: 400, error: "This card is not shown in full here; open the manager chat to decide." };
  return null;
}

/** Why a card whose pressed answer never left waits again; the note sends it out once more. */
export const PRESS_NOT_SENT_NOTE = "Your answer was not sent to the manager chat. Press it again, or reply.";

/**
 * Marks the card answered, then forwards the pressed answer. Compare-and-set: of two surfaces
 * pressing at once only the first forwards. A forward that fails (or throws) opens the card again
 * with a note: every copy lost its buttons when the card was answered, and the note is what sends
 * the card out again with fresh ones (`card-outbound.ts`) and says why in PPM.
 */
async function answerByPress(
  card: AssistantCard, answer: Pick<AssistantCardAnswer, "ok" | "choice" | "note">, text: string,
  how: ForwardHow, deps: CardReplyDeps,
): Promise<CardReplyResult> {
  if (!repliesToManager(card)) return { ok: false, status: 400, error: "This card has no manager chat" };
  const moved = deps.cards.transition(card.id, "answered", {
    by: "user", channel: how.actor.channel, at: deps.now(), ...answer, delivery: "pending",
  });
  if (!moved.ok) {
    const now = moved.card ?? card;
    return { ok: false, status: 409, error: "already_answered", card: now, question: alreadyAnsweredText(now, deps.now(), deps.zone()) };
  }
  let forwarded: ForwardResult;
  try {
    forwarded = await deps.forward(card, text, how);
  } catch (e) {
    forwarded = { ok: false, error: (e as Error).message || "the send failed" };
  }
  if (!forwarded.ok) {
    deps.cards.reopen(card.id, PRESS_NOT_SENT_NOTE);
    const current = deps.cards.get(card.id);
    return { ok: false, status: 502, error: `Not sent: ${forwarded.error}`, ...(current ? { card: current } : {}) };
  }
  recordDelivery(deps, card.id, forwarded);
  return { ok: true, card: moved.card, to: forwarded.to, ...(forwarded.to === "manager" ? { projectName: forwarded.projectName } : {}) };
}

/** The words forwarded for a choice: what the user said by pressing its button. */
export const choiceText = (label: string): string => `I choose: ${label}`;

export async function okCard(id: string, body: unknown, actor: CardActor, deps: CardReplyDeps = realDeps): Promise<CardReplyResult> {
  const card = deps.cards.get(id);
  const refused = pressRefusal(card, deps, "an OK");
  if (refused) return refused;
  if (!card) return { ok: false, status: 404, error: "No such card" };
  if (card.payload.options?.length) return { ok: false, status: 400, error: "This card asks you to pick one of its choices, not for an OK." };
  const draft = card.payload.draft;
  const sent = body && typeof body === "object" ? (body as Record<string, unknown>).draftSha256 : undefined;
  if (draft ? sent !== draft.sha256 : sent !== undefined && sent !== null) {
    return { ok: false, status: 409, error: "The draft is not the one this OK was given for; look at the card again." };
  }
  if (draft && !SHA256_RE.test(draft.sha256)) return { ok: false, status: 400, error: "This card's draft has no valid hash" };
  return answerByPress(card, { ok: true, note: `OK given ${where(actor.channel)}` }, "OK", {
    actor, ok: true, supersede: false, ...(draft ? { draftSha256: draft.sha256, draftTo: draft.to } : {}),
  }, deps);
}

/**
 * The user pressed one of the card's choices. `optionId` names it; the label forwarded is the
 * stored card's, never one the caller sent, so a press can only pick what the card offered.
 */
export async function chooseCardOption(id: string, body: unknown, actor: CardActor, deps: CardReplyDeps = realDeps): Promise<CardReplyResult> {
  const card = deps.cards.get(id);
  const refused = pressRefusal(card, deps, "a choice");
  if (refused) return refused;
  if (!card) return { ok: false, status: 404, error: "No such card" };
  const options = card.payload.options ?? [];
  if (!options.length) return { ok: false, status: 400, error: "This card offers no choices." };
  const optionId = body && typeof body === "object" ? (body as Record<string, unknown>).optionId : undefined;
  if (typeof optionId !== "string") return { ok: false, status: 400, error: "optionId is required" };
  const option = options.find((o) => o.id === optionId);
  if (!option) return { ok: false, status: 400, error: "That is not one of this card's choices." };
  const choice = { id: option.id, label: option.label };
  return answerByPress(card, { choice, note: `Chose "${option.label}" ${where(actor.channel)}` }, choiceText(option.label), {
    actor, choice, supersede: false,
  }, deps);
}

/** A card answered (or closed) before this answer: it is told who answered, and nothing is sent. */
function alreadyAnswered(card: AssistantCard, deps: CardReplyDeps): CardReplyResult {
  return { ok: false, status: 409, error: "already_answered", card, question: alreadyAnsweredText(card, deps.now(), deps.zone()) };
}

/**
 * The user's reply to a card: words, images, or both (`{ text, images?, force?, confirmAge? }`).
 * Images are checked whole here, before the card is touched; they are written to disk only by the
 * forward, right before the words leave, so a refused reply leaves nothing behind.
 *
 * Without either flag, a card that no longer waits or is older than {@link STALE_REPLY_MS} is asked
 * about first. `force` (Telegram's "Send anyway") sends regardless. `confirmAge` (an answer given
 * with the card's age in view) skips only the age question: a card answered or closed meanwhile,
 * or answered by someone else in the same moment, is `already_answered` and nothing is sent.
 */
export async function replyToCard(id: string, body: unknown, actor: CardActor, deps: CardReplyDeps = realDeps): Promise<CardReplyResult> {
  const b = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  if (typeof b.text !== "string") return { ok: false, status: 400, error: "text is required" };
  if (b.text.length > CARD_REPLY_MAX_CHARS) return { ok: false, status: 400, error: `A reply may be at most ${CARD_REPLY_MAX_CHARS} characters` };
  if (b.force !== undefined && typeof b.force !== "boolean") return { ok: false, status: 400, error: "force must be true or false" };
  if (b.confirmAge !== undefined && typeof b.confirmAge !== "boolean") return { ok: false, status: 400, error: "confirmAge must be true or false" };
  const card = deps.cards.get(id);
  if (!card) return { ok: false, status: 404, error: "No such card" };
  // Decoding the images is the costly check, so it comes after the cheap ones.
  const images = validateReplyImages(b.images);
  if (!images.ok) return { ok: false, status: 400, error: images.error };
  if (!b.text.trim() && !images.images.length) return { ok: false, status: 400, error: "text is required" };
  if (actor.channel === "ppm" && !repliesToManager(card)) return { ok: false, status: 400, error: "This card has no manager chat: write to the Assistant instead." };
  const now = deps.now();
  // `force` sends whatever the card's state ("Send anyway"). `confirmAge` only says the user saw
  // how old the card is: it answers an open card, and never one answered or closed meanwhile.
  const force = b.force === true;
  const confirmAge = !force && b.confirmAge === true;
  if (confirmAge && card.status !== "open") return alreadyAnswered(card, deps);
  const stale = card.status !== "open" || now - card.createdAt > STALE_REPLY_MS;
  if (stale && !force && !confirmAge) return { ok: false, status: 409, error: "confirm", card, question: staleQuestion(card, now, deps.zone()) };

  // An open card is answered by the reply; one closed already is left as it was.
  let answered = false;
  if (card.status === "open") {
    const moved = deps.cards.transition(id, "answered", {
      by: "user", channel: actor.channel, at: now, note: `You replied ${where(actor.channel)}`, delivery: "pending",
    });
    if (moved.ok) answered = true;
    else if (confirmAge) return alreadyAnswered(moved.card ?? card, deps);
    else if (!force) {
      const current = moved.card ?? card;
      return { ok: false, status: 409, error: "confirm", card: current, question: staleQuestion(current, now, deps.zone()) };
    }
  }
  const supersede = answered && (card.kind === "approval" || card.kind === "question");
  const followUp = followupOrigin(actor);
  const forwarded = await deps.forward(card, b.text, {
    actor, supersede, ...(followUp ? { followUp } : {}), ...(images.images.length ? { images: images.images } : {}),
  });
  if (!forwarded.ok) {
    if (answered) deps.cards.reopen(id);
    return { ok: false, status: 502, error: `Not sent: ${forwarded.error}` };
  }
  if (answered) recordDelivery(deps, id, forwarded);
  return {
    ok: true, card: deps.cards.get(id) ?? card, to: forwarded.to,
    ...(forwarded.to === "manager" ? { projectName: forwarded.projectName } : {}),
  };
}
