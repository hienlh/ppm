/**
 * The newest page of PPM Assistant's cards, kept current by `assistant:card` (re-dispatched as a
 * window event by `useGlobalEvents`): a new card is added, a changed one replaced in place. The
 * waiting count comes from the same events, so nothing polls.
 */
import { useCallback, useEffect, useState } from "react";
import {
  ASSISTANT_CARD_EVENT, ASSISTANT_WAITING_EVENT, cardFromEvent, fetchAssistantCards, fetchAssistantWaiting,
} from "@/lib/assistant-cards-api";
import type { AssistantCard } from "../../shared/assistant-cards";

const PAGE = 30;

/** `cards` with `card` added or replaced, newest first. */
export function upsertCard(cards: readonly AssistantCard[], card: AssistantCard): AssistantCard[] {
  const rest = cards.filter((c) => c.id !== card.id);
  return [...rest, card].sort((a, b) => b.createdAt - a.createdAt);
}

export function useAssistantCards() {
  const [cards, setCards] = useState<AssistantCard[] | null>(null);
  const [waiting, setWaiting] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      const [page, counts] = await Promise.all([fetchAssistantCards({ limit: PAGE }), fetchAssistantWaiting()]);
      setCards(page.cards);
      setWaiting(counts.total);
      setError(null);
    } catch (e) {
      setError((e as Error).message || "Could not load the cards");
      setCards((prev) => prev ?? []);
    }
  }, []);

  useEffect(() => {
    void reload();
    const onCard = (event: Event) => {
      const card = cardFromEvent((event as CustomEvent).detail);
      if (card) setCards((prev) => upsertCard(prev ?? [], card));
    };
    const onWaiting = (event: Event) => {
      const total = ((event as CustomEvent).detail as { total?: unknown } | null)?.total;
      if (typeof total === "number") setWaiting(total);
    };
    window.addEventListener(ASSISTANT_CARD_EVENT, onCard);
    window.addEventListener(ASSISTANT_WAITING_EVENT, onWaiting);
    return () => {
      window.removeEventListener(ASSISTANT_CARD_EVENT, onCard);
      window.removeEventListener(ASSISTANT_WAITING_EVENT, onWaiting);
    };
  }, [reload]);

  /** A card the server answered with (after an action), shown at once. */
  const apply = useCallback((card: AssistantCard) => setCards((prev) => upsertCard(prev ?? [], card)), []);

  return { cards, waiting, error, reload, apply };
}
