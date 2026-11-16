/**
 * Sending the set's answers: one card ("Send this one"), or every ready card after the review step
 * ("Send all"), one request per card through the card's own route — OK, choose or reply. The
 * server checks each on its own (still open, the draft's hash, the choice offered) and the first
 * answer on any surface wins, so a card answered on Telegram meanwhile is skipped and named, and
 * never stops the cards after it.
 *
 * A reply to a card older than a day is asked about on the server ("send anyway?"). The review
 * step shows that before anything leaves, so "Send all" confirms it — but only while the card still
 * waits: a reply forced onto a card someone answered meanwhile would reach the manager as a second
 * answer. A single send asks in the card instead.
 */
import type { AssistantCard } from "../../../shared/assistant-cards";
import type { DecisionAnswer, ReplyImage } from "./decision-set-model";

export interface DecisionSendApi {
  ok(cardId: string, draftSha256: string | null): Promise<{ card: AssistantCard }>;
  choose(cardId: string, optionId: string): Promise<{ card: AssistantCard }>;
  reply(cardId: string, text: string, force: boolean, images: readonly ReplyImage[]): Promise<{ card: AssistantCard }>;
  /** What a refused request said: the error, the question to ask, the card as it is now. */
  refusal(e: unknown): { error: string; question?: string; card?: AssistantCard };
}

export type SendOutcome =
  | { status: "sent"; card: AssistantCard }
  /** Someone answered first (another device, Telegram), or the card stopped waiting. */
  | { status: "elsewhere"; message: string; card?: AssistantCard }
  /** The server asks before sending (a day-old card): "Send anyway" answers it. */
  | { status: "confirm"; question: string; card?: AssistantCard }
  /** The card is not as it was picked (a new draft): look again. */
  | { status: "changed"; message: string; card?: AssistantCard }
  | { status: "failed"; message: string; card?: AssistantCard };

const ELSEWHERE = "This card was already answered elsewhere.";
const CHANGED = /not the one this OK was given for|not one of this card's choices|not shown in full/i;

function call(card: AssistantCard, answer: DecisionAnswer, api: DecisionSendApi, force: boolean): Promise<{ card: AssistantCard }> {
  if (answer.kind === "ok") return api.ok(card.id, answer.draftSha256);
  if (answer.kind === "choose") return api.choose(card.id, answer.optionId);
  return api.reply(card.id, answer.text, force, answer.images);
}

/** Sends one card's answer and says how it went. Never throws. */
export async function sendDecision(
  card: AssistantCard, answer: DecisionAnswer, api: DecisionSendApi, opts: { force?: boolean; confirmStale?: boolean } = {},
): Promise<SendOutcome> {
  try {
    return { status: "sent", card: (await call(card, answer, api, opts.force === true)).card };
  } catch (e) {
    const refusal = api.refusal(e);
    const now = refusal.card;
    if (refusal.error === "already_answered") return { status: "elsewhere", message: refusal.question ?? ELSEWHERE, ...(now ? { card: now } : {}) };
    if (refusal.error === "confirm") {
      // The question is about the card's age only while it still waits; otherwise it was answered.
      if (now && now.status !== "open") return { status: "elsewhere", message: refusal.question ?? ELSEWHERE, card: now };
      // Forced only on the server's word that the card still waits: never on a guess.
      if (opts.confirmStale && !opts.force && answer.kind === "reply" && now?.status === "open") {
        return sendDecision(card, answer, api, { force: true });
      }
      return { status: "confirm", question: refusal.question ?? "Send anyway?", ...(now ? { card: now } : {}) };
    }
    if (CHANGED.test(refusal.error)) return { status: "changed", message: refusal.error, ...(now ? { card: now } : {}) };
    return { status: "failed", message: refusal.error, ...(now ? { card: now } : {}) };
  }
}

/**
 * Sends every planned answer, one after another (a manager chat takes them in order), reporting
 * each as it lands. One that fails does not stop the rest.
 */
export async function sendAllDecisions(
  plan: ReadonlyArray<{ card: AssistantCard; answer: DecisionAnswer }>,
  api: DecisionSendApi,
  onEach: (cardId: string, outcome: SendOutcome) => void,
): Promise<Map<string, SendOutcome>> {
  const results = new Map<string, SendOutcome>();
  for (const { card, answer } of plan) {
    const outcome = await sendDecision(card, answer, api, { confirmStale: true });
    results.set(card.id, outcome);
    onEach(card.id, outcome);
  }
  return results;
}
