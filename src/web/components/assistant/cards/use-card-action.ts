/**
 * Runs one of a card's actions: one at a time, the error shown on the card, the card the server
 * answered with handed back so the screen shows it at once (the `assistant:card` event follows).
 * "already_answered" is said in words: someone answered on another surface first.
 */
import { useCallback, useState } from "react";
import { openSessionAnywhere } from "@/lib/open-session-anywhere";
import { cardRefusal } from "@/lib/assistant-cards-api";
import type { AssistantCard } from "../../../../shared/assistant-cards";

const MESSAGES: Record<string, string> = {
  already_answered: "This card was already answered elsewhere.",
};

export function useCardAction(onCard?: (card: AssistantCard) => void) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(async (action: () => Promise<{ card?: AssistantCard } | unknown>) => {
    setBusy(true);
    setError(null);
    try {
      const result = await action();
      const card = result && typeof result === "object" ? (result as { card?: AssistantCard }).card : undefined;
      if (card && onCard) onCard(card);
    } catch (e) {
      // The server says who answered first, and when ("Already answered on Telegram at 22:41").
      const refusal = cardRefusal(e);
      setError(refusal.question ?? MESSAGES[refusal.error] ?? refusal.error);
      if (refusal.card && onCard) onCard(refusal.card);
    } finally {
      setBusy(false);
    }
  }, [onCard]);

  return { busy, error, run };
}

/** Opens the manager chat a card came from, in its project. */
export function openManagerChat(card: AssistantCard): void {
  if (!card.projectName || !card.sessionId) return;
  void openSessionAnywhere(card.projectName, card.sessionId, "claude");
}
