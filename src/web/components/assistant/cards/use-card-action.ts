/**
 * Runs one of a card's actions: one at a time, the error shown on the card, the card the server
 * answered with handed back so the screen shows it at once (the `assistant:card` event follows).
 * "already_answered" is said in words: someone answered on another surface first.
 */
import { useCallback, useState } from "react";
import { openManagerChat } from "../open-manager-chat";
import { cardRefusal } from "@/lib/assistant-cards-api";
import { applyAssistantCard } from "@/stores/assistant-cards-store";
import type { AssistantCard } from "../../../../shared/assistant-cards";

const MESSAGES: Record<string, string> = {
  already_answered: "This card was already answered elsewhere.",
};

/** `onCard` defaults to the stream's card list, which every card on screen belongs to. */
export function useCardAction(onCard: (card: AssistantCard) => void = applyAssistantCard) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(async (action: () => Promise<{ card?: AssistantCard } | unknown>) => {
    setBusy(true);
    setError(null);
    try {
      const result = await action();
      const card = result && typeof result === "object" ? (result as { card?: AssistantCard }).card : undefined;
      if (card) onCard(card);
    } catch (e) {
      // The server says who answered first, and when ("Already answered on Telegram at 22:41").
      const refusal = cardRefusal(e);
      setError(refusal.question ?? MESSAGES[refusal.error] ?? refusal.error);
      if (refusal.card) onCard(refusal.card);
    } finally {
      setBusy(false);
    }
  }, [onCard]);

  return { busy, error, run };
}

/**
 * Opens the manager chat a card came from: a window of its own beside the current project on a
 * desktop, the project and a tab on a phone (`openManagerChat`).
 */
export function openCardManagerChat(card: AssistantCard): void {
  if (!card.projectName || !card.sessionId) return;
  void openManagerChat({ projectName: card.projectName, sessionId: card.sessionId });
}
