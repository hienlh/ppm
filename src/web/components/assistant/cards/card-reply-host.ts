/**
 * Where a card's Edit / Reply opens the reply bar. In the Assistant it is the Assistant's composer
 * (the shared `useCardReplyStore`); a manager chat showing its own waiting cards answers them in
 * place, under the card, and has no use for "Open manager chat" since the user is already in it.
 */
import { createContext, useContext } from "react";
import { useCardReplyStore } from "@/stores/assistant-card-reply-store";
import type { AssistantCard } from "../../../../shared/assistant-cards";

export interface CardReplyHost {
  replyTo: (card: AssistantCard) => void;
  /** The card is shown inside the manager chat it came from. */
  inManagerChat?: boolean;
}

export const CardReplyHostContext = createContext<CardReplyHost | null>(null);

/** The host the nearest provider gives, else the Assistant's composer. */
export function useCardReplyHost(): CardReplyHost {
  const host = useContext(CardReplyHostContext);
  const replyTo = useCardReplyStore((s) => s.replyTo);
  return host ?? { replyTo };
}
