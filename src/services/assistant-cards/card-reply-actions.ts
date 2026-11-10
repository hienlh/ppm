/**
 * The user's OK on a needs-decision card, and the user's own reply to a card — from PPM or from
 * Telegram, through the same checks.
 *
 * - **OK** is an approval. It is offered only where the whole decision is shown and nothing hidden
 *   (`card-ok-rule.ts`), names the exact draft by its hash, and is compare-and-set on the card:
 *   the first OK on any surface wins and forwards once; a later one is told who answered, when.
 * - **A reply** goes word for word to the card's manager chat. A card that no longer waits, or is
 *   older than {@link STALE_REPLY_MS}, asks first ("send anyway?"). A reply to an approval or
 *   question card refuses that request, as typing in the manager chat would.
 *
 * The card is marked answered before the words leave, so a second surface cannot forward too; if
 * the forward fails, the card is opened again and the error said.
 */
import { assistantCards, type AssistantCards } from "./assistant-cards.service.ts";
import { assistantClock } from "../assistant-wake/assistant-clock.ts";
import { getAssistantSettings } from "../assistant/assistant-settings.service.ts";
import { CARD_REPLY_MAX_CHARS, STALE_REPLY_MS } from "../../shared/assistant-limits.ts";
import { OK_CARD_KINDS, type AssistantCard } from "../../shared/assistant-cards.ts";
import { cardOkOffered } from "./card-ok-rule.ts";
import { forwardUserWords, repliesToManager, type CardActor, type ForwardHow, type ForwardResult } from "./forward-verbatim.ts";
import { realForwardEnv } from "./forward-verbatim-env.ts";

export type CardReplyResult =
  | { ok: true; card: AssistantCard; to: "manager" | "assistant"; projectName?: string }
  | { ok: false; status: 400 | 404 | 409 | 502; error: string; card?: AssistantCard; question?: string };

export interface CardReplyDeps {
  cards: AssistantCards;
  now(): number;
  /** The user's time zone (Settings), for the times the user is told. */
  zone(): string | undefined;
  forward(card: AssistantCard, text: string, how: ForwardHow): Promise<ForwardResult>;
}

const realDeps: CardReplyDeps = {
  cards: assistantCards,
  now: () => assistantClock.now(),
  zone: () => getAssistantSettings().timezone,
  forward: (card, text, how) => forwardUserWords(card, text, how, realForwardEnv),
};

const SHA256_RE = /^[0-9a-f]{64}$/;
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

export async function okCard(id: string, body: unknown, actor: CardActor, deps: CardReplyDeps = realDeps): Promise<CardReplyResult> {
  const card = deps.cards.get(id);
  if (!card) return { ok: false, status: 404, error: "No such card" };
  if (!OK_CARD_KINDS.includes(card.kind)) return { ok: false, status: 400, error: "This card does not take an OK" };
  if (card.status !== "open") return { ok: false, status: 409, error: "already_answered", card, question: alreadyAnsweredText(card, deps.now(), deps.zone()) };
  if (!cardOkOffered(card)) return { ok: false, status: 400, error: "This card is not shown in full here; open the manager chat to decide." };
  const draft = card.payload.draft;
  const sent = body && typeof body === "object" ? (body as Record<string, unknown>).draftSha256 : undefined;
  if (draft ? sent !== draft.sha256 : sent !== undefined && sent !== null) {
    return { ok: false, status: 409, error: "The draft is not the one this OK was given for; look at the card again." };
  }
  if (draft && !SHA256_RE.test(draft.sha256)) return { ok: false, status: 400, error: "This card's draft has no valid hash" };
  if (!repliesToManager(card)) return { ok: false, status: 400, error: "This card has no manager chat" };
  const moved = deps.cards.transition(id, "answered", { by: "user", channel: actor.channel, at: deps.now(), ok: true, note: `OK given ${where(actor.channel)}` });
  if (!moved.ok) {
    const now = moved.card ?? card;
    return { ok: false, status: 409, error: "already_answered", card: now, question: alreadyAnsweredText(now, deps.now(), deps.zone()) };
  }
  const forwarded = await deps.forward(card, "OK", {
    actor, ok: true, supersede: false, ...(draft ? { draftSha256: draft.sha256, draftTo: draft.to } : {}),
  });
  if (!forwarded.ok) {
    deps.cards.reopen(id);
    return { ok: false, status: 502, error: `Not sent: ${forwarded.error}`, ...(deps.cards.get(id) ? { card: deps.cards.get(id)! } : {}) };
  }
  return { ok: true, card: moved.card, to: forwarded.to, ...(forwarded.to === "manager" ? { projectName: forwarded.projectName } : {}) };
}

export async function replyToCard(id: string, body: unknown, actor: CardActor, deps: CardReplyDeps = realDeps): Promise<CardReplyResult> {
  const b = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  if (typeof b.text !== "string" || !b.text.trim()) return { ok: false, status: 400, error: "text is required" };
  if (b.text.length > CARD_REPLY_MAX_CHARS) return { ok: false, status: 400, error: `A reply may be at most ${CARD_REPLY_MAX_CHARS} characters` };
  if (b.force !== undefined && typeof b.force !== "boolean") return { ok: false, status: 400, error: "force must be true or false" };
  const card = deps.cards.get(id);
  if (!card) return { ok: false, status: 404, error: "No such card" };
  if (actor.channel === "ppm" && !repliesToManager(card)) return { ok: false, status: 400, error: "This card has no manager chat: write to the Assistant instead." };
  const now = deps.now();
  const stale = card.status !== "open" || now - card.createdAt > STALE_REPLY_MS;
  if (stale && b.force !== true) return { ok: false, status: 409, error: "confirm", card, question: staleQuestion(card, now, deps.zone()) };

  // An open card is answered by the reply; one closed already is left as it was.
  let answered = false;
  if (card.status === "open") {
    const moved = deps.cards.transition(id, "answered", { by: "user", channel: actor.channel, at: now, note: `You replied ${where(actor.channel)}` });
    if (moved.ok) answered = true;
    else if (b.force !== true) {
      const current = moved.card ?? card;
      return { ok: false, status: 409, error: "confirm", card: current, question: staleQuestion(current, now, deps.zone()) };
    }
  }
  const supersede = answered && (card.kind === "approval" || card.kind === "question");
  const forwarded = await deps.forward(card, b.text, { actor, supersede });
  if (!forwarded.ok) {
    if (answered) deps.cards.reopen(id);
    return { ok: false, status: 502, error: `Not sent: ${forwarded.error}` };
  }
  return {
    ok: true, card: deps.cards.get(id) ?? card, to: forwarded.to,
    ...(forwarded.to === "manager" ? { projectName: forwarded.projectName } : {}),
  };
}
