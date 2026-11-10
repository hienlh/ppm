/**
 * The PPM Assistant's cards as the stream shows them: newest pages first, filtered on the server
 * by the project the user picked (`GET /cards?project=`), kept current by `assistant:card`
 * (re-dispatched as a window event by `useGlobalEvents`) and refetched after a `/ws/global`
 * reconnect. Older pages load only when asked ("Load earlier", or the chat's own history reaching
 * further back), never in a chain by themselves.
 *
 * The filter is this device's own choice, kept in localStorage; it is read lazily because the
 * store module also loads under `bun:test`, where touching storage at import time throws.
 */
import { create } from "zustand";
import { ASSISTANT_CARD_EVENT, cardFromEvent, fetchAssistantCards } from "@/lib/assistant-cards-api";
import type { AssistantCard } from "../../shared/assistant-cards";

const PAGE = 30;
const FILTER_KEY = "ppm-assistant-filter";

interface CardsState {
  /** Null until the first page answered. */
  cards: AssistantCard[] | null;
  /** Project name, or null for every project. */
  filter: string | null;
  nextBefore: number | null;
  loadingEarlier: boolean;
  error: string | null;
}

export const useAssistantCardsStore = create<CardsState>(() => ({
  cards: null, filter: readFilter(), nextBefore: null, loadingEarlier: false, error: null,
}));

function readFilter(): string | null {
  try { return typeof localStorage === "undefined" ? null : localStorage.getItem(FILTER_KEY) || null; } catch { return null; }
}

/** `cards` with `card` added or replaced, newest first. */
export function upsertCard(cards: readonly AssistantCard[], card: AssistantCard): AssistantCard[] {
  const rest = cards.filter((c) => c.id !== card.id);
  return [...rest, card].sort((a, b) => b.createdAt - a.createdAt);
}

/** Whether a card belongs in the list the filter shows. */
const matches = (card: AssistantCard, filter: string | null) => !filter || card.projectName === filter;

let started = false;
/** Bumped by every reload, so an answer for an older filter is dropped. */
let generation = 0;

async function reload(): Promise<void> {
  const mine = ++generation;
  const { filter } = useAssistantCardsStore.getState();
  try {
    const page = await fetchAssistantCards({ limit: PAGE, ...(filter ? { project: filter } : {}) });
    if (mine !== generation) return;
    useAssistantCardsStore.setState({ cards: page.cards, nextBefore: page.nextBefore, error: null });
  } catch (e) {
    if (mine !== generation) return;
    useAssistantCardsStore.setState((s) => ({ cards: s.cards ?? [], error: (e as Error).message || "Could not load the cards" }));
  }
}

/** Starts following the cards; a no-op after the first call. */
export function ensureAssistantCards(): void {
  if (started || typeof window === "undefined") return;
  started = true;
  window.addEventListener(ASSISTANT_CARD_EVENT, (event) => {
    const card = cardFromEvent((event as CustomEvent).detail);
    if (card) applyAssistantCard(card);
  });
  void reload();
}

/** A card an action or an event brought, shown at once when the filter lets it in. */
export function applyAssistantCard(card: AssistantCard): void {
  useAssistantCardsStore.setState((s) => {
    if (!matches(card, s.filter)) return s;
    return { cards: upsertCard(s.cards ?? [], card) };
  });
}

/** Shows one project's cards, or every project's with null; remembered on this device. */
export function setAssistantCardFilter(filter: string | null): void {
  if (useAssistantCardsStore.getState().filter === filter) return;
  try { if (filter) localStorage.setItem(FILTER_KEY, filter); else localStorage.removeItem(FILTER_KEY); } catch { /* private mode */ }
  useAssistantCardsStore.setState({ filter, cards: null, nextBefore: null });
  if (started) void reload();
}

/** Fetches the next older page of the current filter, once per call. */
export async function loadEarlierAssistantCards(): Promise<void> {
  const { nextBefore, loadingEarlier, filter } = useAssistantCardsStore.getState();
  if (nextBefore === null || loadingEarlier) return;
  const mine = generation;
  useAssistantCardsStore.setState({ loadingEarlier: true });
  try {
    const page = await fetchAssistantCards({ before: nextBefore, limit: PAGE, ...(filter ? { project: filter } : {}) });
    if (mine !== generation) return;
    useAssistantCardsStore.setState((s) => {
      let cards = s.cards ?? [];
      for (const card of page.cards) cards = upsertCard(cards, card);
      return { cards, nextBefore: page.nextBefore, error: null };
    });
  } catch (e) {
    if (mine === generation) useAssistantCardsStore.setState({ error: (e as Error).message || "Could not load the cards" });
  } finally {
    useAssistantCardsStore.setState({ loadingEarlier: false });
  }
}

/** After a `/ws/global` reconnect: a card announced while the socket was down never arrived. */
export function resyncAssistantCards(): void {
  if (started) void reload();
}
