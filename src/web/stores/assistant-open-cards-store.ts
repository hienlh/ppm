/**
 * The PPM Assistant's cards that still wait on the user: the very cards the red counts are made
 * of (`GET /cards/open` is built from the same server function as `GET /waiting`), so a count on
 * screen always has cards behind it the user can find. The Assistant pins them above its stream
 * ("Waiting on you") and a manager chat shows its own above the composer.
 *
 * Fetched once by the first reader, kept current by `assistant:card` (a card that stops waiting
 * leaves, a new one joins), checked against every `assistant:waiting_changed` (counts that do not
 * describe the list refetch it) and refetched after a `/ws/global` reconnect. Nothing polls.
 */
import { useEffect } from "react";
import { create } from "zustand";
import {
  ASSISTANT_CARD_EVENT, ASSISTANT_WAITING_EVENT, cardFromEvent, fetchOpenAssistantCards,
} from "@/lib/assistant-cards-api";
import { WAITING_CARD_KINDS, type AssistantCard } from "../../shared/assistant-cards";

/** A press on a red count: show that project's (or every) waiting card. `nonce` makes each press new. */
export interface WaitingFocus {
  projectName: string | null;
  nonce: number;
}

interface OpenCardsState {
  /** Null until the first answer. */
  cards: AssistantCard[] | null;
  focus: WaitingFocus | null;
}

export const useOpenCardsStore = create<OpenCardsState>(() => ({ cards: null, focus: null }));

/** Whether a card is one the waiting counts include. */
export function isWaitingCard(card: AssistantCard): boolean {
  return card.status === "open" && WAITING_CARD_KINDS.includes(card.kind);
}

const byAge = (a: AssistantCard, b: AssistantCard) => a.createdAt - b.createdAt;

/** `cards` after `card` changed: kept (oldest first) while it waits, dropped once it does not. */
export function applyOpenCard(cards: readonly AssistantCard[], card: AssistantCard): AssistantCard[] {
  const rest = cards.filter((c) => c.id !== card.id);
  return isWaitingCard(card) ? [...rest, card].sort(byAge) : rest;
}

/** The order the user steps through them: urgent first, then the one that has waited longest. */
export function orderWaitingCards(cards: readonly AssistantCard[]): AssistantCard[] {
  const urgent = (c: AssistantCard) => (c.kind === "urgent" ? 0 : 1);
  return [...cards].sort((a, b) => urgent(a) - urgent(b) || byAge(a, b));
}

/** Whether counts announced by the server describe the list held here. */
export function countsMatch(cards: readonly AssistantCard[], counts: { total: number; byProject: Record<string, number> }): boolean {
  if (cards.length !== counts.total) return false;
  const mine: Record<string, number> = {};
  for (const c of cards) if (c.projectName) mine[c.projectName] = (mine[c.projectName] ?? 0) + 1;
  const keys = new Set([...Object.keys(mine), ...Object.keys(counts.byProject)]);
  for (const k of keys) if ((mine[k] ?? 0) !== (counts.byProject[k] ?? 0)) return false;
  return true;
}

let started = false;
/** Counts every card event, so a fetch that started before one cannot overwrite it. */
let changes = 0;
let nonce = 0;

async function refresh(): Promise<void> {
  const asked = changes;
  try {
    const { cards } = await fetchOpenAssistantCards();
    if (asked !== changes || !Array.isArray(cards)) return;
    useOpenCardsStore.setState({ cards: cards.filter(isWaitingCard).sort(byAge) });
  } catch {
    // A server without the Assistant, or a transient failure: the list stays as it was.
    if (useOpenCardsStore.getState().cards === null) useOpenCardsStore.setState({ cards: [] });
  }
}

/** Starts following the waiting cards; a no-op after the first call. */
export function ensureOpenCards(): void {
  if (started || typeof window === "undefined") return;
  started = true;
  window.addEventListener(ASSISTANT_CARD_EVENT, (event) => {
    const card = cardFromEvent((event as CustomEvent).detail);
    if (!card) return;
    changes += 1;
    applyOpenCardResult(card);
  });
  window.addEventListener(ASSISTANT_WAITING_EVENT, (event) => {
    const detail = (event as CustomEvent).detail as { total?: unknown; byProject?: unknown } | null;
    const { cards } = useOpenCardsStore.getState();
    if (!cards || !detail || typeof detail.total !== "number") return;
    const byProject = detail.byProject && typeof detail.byProject === "object" ? detail.byProject as Record<string, number> : {};
    if (!countsMatch(cards, { total: detail.total, byProject })) void refresh();
  });
  void refresh();
}

/** After a `/ws/global` reconnect: a card announced while the socket was down never arrived. */
export function resyncOpenCards(): void {
  if (started) void refresh();
}

/** Shows one project's waiting cards (every project's with null), from a press on a red count. */
export function focusWaitingCards(projectName: string | null): void {
  nonce += 1;
  useOpenCardsStore.setState({ focus: { projectName, nonce } });
}

/** A card an action or an event brought: taken in at once, or dropped once it stopped waiting. */
export function applyOpenCardResult(card: AssistantCard): void {
  useOpenCardsStore.setState((s) => (s.cards ? { cards: applyOpenCard(s.cards, card) } : s));
}

/** The waiting cards, following them from the first mount where `enabled`. */
export function useOpenCards(enabled = true): AssistantCard[] | null {
  useEffect(() => { if (enabled) ensureOpenCards(); }, [enabled]);
  return useOpenCardsStore((s) => s.cards);
}
