/**
 * The PPM Assistant's set of decisions, as data: which cards it holds, what the user picked on
 * each, and what "Send all" would send. Pure, so it is tested without a browser or a store.
 *
 * A pick remembers the card as it was when picked (`cardVersion`): the draft's hash, the choices
 * offered, the card's last change. A card that changes afterwards loses its pick, so an OK never
 * goes out for a draft the user did not see — the server checks the hash too, this keeps the
 * screen from offering it in the first place.
 */
import { STALE_REPLY_MS } from "../../../shared/assistant-limits";
import { escapeHiddenCharacters } from "../../../shared/reveal-hidden-characters";
import type { AssistantCard } from "../../../shared/assistant-cards";
import type { HeldVoice } from "../card-voice-reply";

/** Most pictures one reply carries; the server refuses more. */
export const MAX_REPLY_IMAGES = 5;

/** A picture attached to a reply, ready to send (base64 without the `data:` prefix). */
export interface ReplyImage {
  id: string;
  name: string;
  data: string;
  mediaType: string;
}

export type DecisionAnswer =
  | { kind: "ok"; draftSha256: string | null }
  | { kind: "choose"; optionId: string }
  /** `voice`: the words are the transcript of a recording, sent as a voice message. */
  | { kind: "reply"; text: string; images: ReplyImage[]; voice?: HeldVoice };

export interface DecisionPick {
  answer: DecisionAnswer;
  /** `cardVersion` of the card when it was picked. */
  version: string;
}

/** One pressable answer on a card: its choices, or one OK. */
export interface DecisionTile {
  key: string;
  label: string;
  description: string;
  answer: Extract<DecisionAnswer, { kind: "ok" | "choose" }>;
  /** The OK names this draft hash. */
  draftSha256?: string;
}

export const isDecisionCard = (card: Pick<AssistantCard, "kind">): boolean =>
  card.kind === "needs_decision" || card.kind === "urgent";

/**
 * What a pick depends on, and only that: the words the user read, the draft and who it goes to,
 * the choices, and whether the server lets them be pressed. Not `updatedAt`: the server moves it
 * for things the user never sees (the Telegram copy's state, a wake flag), and a pick taken back
 * over those would wipe a typed reply for nothing.
 */
export function cardVersion(card: AssistantCard): string {
  const options = (card.payload.options ?? []).map((o) => [o.id, o.label, o.description ?? ""]);
  const draft = card.payload.draft;
  return JSON.stringify([card.title, card.body, draft ? [draft.sha256, draft.to] : null, options, card.okOffered === true]);
}

/**
 * The tiles a card offers. None when the server says the card is not shown whole here
 * (`okOffered` false): such a card is answered in words or in its chat.
 */
export function decisionTiles(card: AssistantCard): DecisionTile[] {
  if (card.okOffered !== true) return [];
  const options = card.payload.options ?? [];
  if (options.length) {
    return options.map((o) => ({
      key: `choose:${o.id}`, label: o.label, description: o.description ?? "", answer: { kind: "choose", optionId: o.id },
    }));
  }
  const draft = card.payload.draft;
  if (draft) {
    return [{
      key: "ok", label: "OK, send this draft",
      description: `Sends the draft above to ${escapeHiddenCharacters(draft.to)}, character for character.`,
      answer: { kind: "ok", draftSha256: draft.sha256 }, draftSha256: draft.sha256,
    }];
  }
  return [{ key: "ok", label: "OK, go ahead", description: "Tells the manager to go ahead as the card describes.", answer: { kind: "ok", draftSha256: null } }];
}

export function sameAnswer(a: DecisionAnswer | undefined, b: DecisionAnswer | undefined): boolean {
  if (!a || !b || a.kind !== b.kind) return false;
  if (a.kind === "ok" && b.kind === "ok") return a.draftSha256 === b.draftSha256;
  if (a.kind === "choose" && b.kind === "choose") return a.optionId === b.optionId;
  return false;
}

/** Whether `answer` can be sent for `card` as the card is now. */
export function answerIsReady(card: AssistantCard, answer: DecisionAnswer | undefined): answer is DecisionAnswer {
  if (!answer) return false;
  if (answer.kind === "reply") return (answer.text.trim().length > 0 || answer.images.length > 0) && !!card.sessionId;
  return decisionTiles(card).some((t) => sameAnswer(t.answer, answer));
}

/** The pick for `card`, if it was made on the card as it is now. */
export function currentPick(card: AssistantCard, picks: Readonly<Record<string, DecisionPick>>): DecisionPick | null {
  const pick = picks[card.id];
  return pick && pick.version === cardVersion(card) ? pick : null;
}

/**
 * The picks that no longer fit their card (it changed since), to be cleared with a word to the
 * user. Picks for cards that are not in `cards` are left alone: the card may just be filtered out.
 */
export function outdatedPicks(cards: readonly AssistantCard[], picks: Readonly<Record<string, DecisionPick>>): string[] {
  return cards.filter((c) => picks[c.id] && picks[c.id]!.version !== cardVersion(c)).map((c) => c.id);
}

/** What "Send all" sends: every waiting card with a ready pick, in the set's order. */
export function sendPlan(cards: readonly AssistantCard[], picks: Readonly<Record<string, DecisionPick>>): Array<{ card: AssistantCard; answer: DecisionAnswer }> {
  const plan: Array<{ card: AssistantCard; answer: DecisionAnswer }> = [];
  for (const card of cards) {
    if (card.status !== "open") continue;
    const pick = currentPick(card, picks);
    if (pick && answerIsReady(card, pick.answer)) plan.push({ card, answer: pick.answer });
  }
  return plan;
}

/** A reply to a card this old asks "send anyway?" on the server; the review step says so first. */
export const isStaleForReply = (card: Pick<AssistantCard, "createdAt">, now: number): boolean => now - card.createdAt > STALE_REPLY_MS;

/** The answer in a few words, as the review step and a sent tab name it. */
export function answerLabel(card: AssistantCard, answer: DecisionAnswer): string {
  if (answer.kind === "choose") {
    const label = card.payload.options?.find((o) => o.id === answer.optionId)?.label ?? answer.optionId;
    return `Chose “${label}”`;
  }
  if (answer.kind === "ok") return card.payload.draft ? `OK — send the draft to ${escapeHiddenCharacters(card.payload.draft.to)}` : "OK — go ahead";
  const pictures = answer.images.length ? ` + ${answer.images.length} picture${answer.images.length === 1 ? "" : "s"}` : "";
  const text = answer.text.trim();
  if (answer.voice) return `Voice reply: “${text}”`;
  return text ? `Reply: “${text}”${pictures}` : `Reply with ${answer.images.length} picture${answer.images.length === 1 ? "" : "s"}`;
}

/** "alpha 2 · beta 1": where the waiting cards come from, for the folded bar. */
export function projectCounts(cards: readonly AssistantCard[]): string {
  const counts = new Map<string, number>();
  for (const c of cards) {
    const name = c.projectName ?? "Assistant";
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return [...counts].map(([name, n]) => `${name} ${n}`).join(" · ");
}

/**
 * The order the set's tabs keep: the order it had, with cards that arrived since added at the end
 * (a new card never moves the tab the user is on), and ids that are neither waiting nor kept (a
 * card being sent from here) dropped.
 */
export function nextTabOrder(previous: readonly string[], waitingInOrder: readonly string[], keep: ReadonlySet<string>): string[] {
  const waiting = new Set(waitingInOrder);
  const kept = previous.filter((id) => waiting.has(id) || keep.has(id));
  const known = new Set(kept);
  for (const id of waitingInOrder) if (!known.has(id)) kept.push(id);
  return kept;
}

/**
 * The set's tabs: every card that still waits, plus a card whose answer is on its way from here.
 * That one leaves the waiting list the moment the server marks it answered, before the answer
 * comes back, and keeps its tab until the send says how it went (a failed forward puts it back).
 * A card answered anywhere else — Telegram, another window, dismissed, closed by its manager — is
 * simply gone: what happened to it is told where the conversation is, never in the set.
 */
export function decisionTabs(
  order: readonly string[],
  waiting: readonly AssistantCard[],
  inFlight: Readonly<Record<string, AssistantCard>>,
  scope: (card: AssistantCard) => boolean,
): AssistantCard[] {
  const byId = new Map(waiting.map((c) => [c.id, c]));
  const tabs: AssistantCard[] = [];
  const placed = new Set<string>();
  for (const id of order) {
    const card = byId.get(id) ?? inFlight[id];
    if (card && !placed.has(id) && scope(card)) tabs.push(card);
    placed.add(id);
  }
  // The order catches up an effect later; a card shown before that still gets its tab.
  for (const card of waiting) if (!placed.has(card.id) && scope(card)) { tabs.push(card); placed.add(card.id); }
  return tabs;
}

/**
 * Which tab is open. The card the user chose while it is still there; else the tab now standing
 * where the open one stood — the next waiting card, or the last one when it was at the end —
 * so a card answered elsewhere under the user's eyes moves them on rather than back to the start;
 * else (a set just shown) the first.
 */
export function activeTabIndex(tabIds: readonly string[], activeId: string | null, lastIndex: number): number {
  if (tabIds.length === 0) return -1;
  const at = activeId ? tabIds.indexOf(activeId) : -1;
  if (at >= 0) return at;
  if (activeId === null) return 0;
  return Math.min(Math.max(0, lastIndex), tabIds.length - 1);
}
