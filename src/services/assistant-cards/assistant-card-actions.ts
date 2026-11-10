import { createLogger } from "../logger.ts";
import { chatControl, type ChatControl } from "../chat-control/chat-control.ts";
import { answersByIdError, type NormalizedQuestion } from "../../shared/approval-questions.ts";
import {
  ANSWERABLE_CARD_KINDS, DISMISSABLE_CARD_KINDS, type AssistantCard,
} from "../../shared/assistant-cards.ts";
import { assistantClock } from "../assistant-wake/assistant-clock.ts";
import { assistantCards, type AssistantCards } from "./assistant-cards.service.ts";
import { listOpenCardRows } from "./assistant-cards-db.ts";

/**
 * What the user can do to a card from PPM: answer a manager chat's approval or question it mirrors,
 * or dismiss a report. Each checks the card's kind and status on the server, and acts only on the
 * exact request the card mirrors. Allow is refused when the card does not show everything that
 * would run. The first answer on any surface wins; a later one learns the card is already answered.
 */

export type CardActionResult =
  | { ok: true; card: AssistantCard; stale?: true }
  | { ok: false; status: 400 | 404 | 409 | 503; error: string; card?: AssistantCard };

export interface CardActionDeps {
  cards: AssistantCards;
  control: () => ChatControl | null;
  now: () => number;
}

const realDeps: CardActionDeps = { cards: assistantCards, control: chatControl, now: () => assistantClock.now() };
const log = createLogger("assistant-cards");

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

function openCard(deps: CardActionDeps, id: string): CardActionResult {
  const card = deps.cards.get(id);
  if (!card) return { ok: false, status: 404, error: "No such card" };
  if (card.status !== "open") return { ok: false, status: 409, error: "already_answered", card };
  return { ok: true, card };
}

export function answerCard(id: string, body: unknown, deps: CardActionDeps = realDeps): CardActionResult {
  const found = openCard(deps, id);
  if (!found.ok) return found;
  const { card } = found;
  if (!ANSWERABLE_CARD_KINDS.includes(card.kind)) return { ok: false, status: 400, error: "This card is not answered here" };
  const b = isObj(body) ? body : {};
  const decision = b.decision;
  if (decision !== undefined && decision !== "allow" && decision !== "deny") return { ok: false, status: 400, error: "decision must be allow or deny" };
  const requestId = card.payload.requestId;
  if (!requestId || !card.sessionId) return { ok: false, status: 400, error: "This card mirrors no request" };

  let answer: { approved: boolean; answersById?: Record<string, string[]> };
  if (card.kind === "approval") {
    if (decision === undefined) return { ok: false, status: 400, error: "decision is required" };
    // The same bar as Telegram: Allow only where the whole request is on the card.
    if (decision === "allow" && card.payload.deciding?.complete !== true) {
      return { ok: false, status: 400, error: "This request is not shown in full here; open the manager chat to answer it." };
    }
    answer = { approved: decision === "allow" };
  } else if (decision === "deny") {
    answer = { approved: false };
  } else {
    const questions = (card.payload.questions ?? []) as NormalizedQuestion[];
    const invalid = answersByIdError(questions, b.answersById, { requireAll: true });
    if (invalid) return { ok: false, status: 400, error: invalid };
    answer = { approved: true, answersById: b.answersById as Record<string, string[]> };
  }

  const control = deps.control();
  if (!control) return { ok: false, status: 503, error: "Chats are not available in this PPM process" };
  const outcome = control.answerApproval(card.sessionId, requestId, answer, "assistant_card");
  const at = deps.now();
  if (outcome === "answered") {
    const moved = deps.cards.transition(card.id, "answered", { by: "user", channel: "ppm", at, approved: answer.approved });
    if (moved.ok) return { ok: true, card: moved.card };
    return { ok: false, status: 409, error: "already_answered", ...(moved.card ? { card: moved.card } : {}) };
  }
  // Nothing waits on that request any more: the card says so, and nothing ran.
  const moved = deps.cards.transition(card.id, "resolved", { by: "ppm", channel: "ppm", at, note: "No longer waiting" });
  if (!moved.ok) return { ok: false, status: 409, error: "already_answered", ...(moved.card ? { card: moved.card } : {}) };
  return { ok: true, card: moved.card, stale: true };
}

export function dismissCard(id: string, deps: CardActionDeps = realDeps): CardActionResult {
  const found = openCard(deps, id);
  if (!found.ok) return found;
  if (!DISMISSABLE_CARD_KINDS.includes(found.card.kind)) return { ok: false, status: 400, error: "This card cannot be dismissed" };
  const moved = deps.cards.transition(id, "dismissed", { by: "user", channel: "ppm", at: deps.now() });
  if (!moved.ok) return { ok: false, status: 409, error: "already_answered", ...(moved.card ? { card: moved.card } : {}) };
  return { ok: true, card: moved.card };
}

/**
 * After a restart: an approval or question card whose request no live chat shows is gone. A chat
 * with cards queued behind its shown one keeps its cards, since the queue's ids are not visible.
 */
export function sweepGoneRequestCards(deps: CardActionDeps = realDeps): number {
  const control = deps.control();
  let gone = 0;
  for (const row of listOpenCardRows(ANSWERABLE_CARD_KINDS)) {
    const live = row.sessionId ? control?.liveState(row.sessionId) ?? null : null;
    if (live && (live.card?.requestId === row.payload.requestId || live.queuedCards > 0)) continue;
    if (deps.cards.transition(row.id, "gone", { by: "ppm", channel: "ppm", at: deps.now(), note: "No longer waiting" }).ok) gone++;
  }
  if (gone) log.info(`${gone} approval or question card(s) no longer waiting after a restart`);
  return gone;
}
