/**
 * Which card the Assistant's composer is answering, if any: set by a card's Edit button, cleared
 * by the bar's close button, by a sent reply, and when the Assistant view goes away. Reply-to mode
 * never sticks: the next message after a reply goes to the Assistant again.
 */
import { create } from "zustand";
import type { AssistantCard } from "../../shared/assistant-cards";

export interface CardReplyTarget {
  cardId: string;
  projectName: string | null;
  title: string;
  /** The chat the card came from: a spoken reply's tidy-up reads it (`useCardVoiceReply`). */
  sessionId?: string | null;
  providerId?: string;
}

/** The reply target for a card. */
export const cardReplyTarget = (card: AssistantCard): CardReplyTarget => ({
  cardId: card.id, projectName: card.projectName, title: card.title, sessionId: card.sessionId,
  ...(card.payload.chat ? { providerId: card.payload.chat.providerId } : {}),
});

interface CardReplyState {
  target: CardReplyTarget | null;
  replyTo: (card: AssistantCard) => void;
  close: () => void;
}

export const useCardReplyStore = create<CardReplyState>((set) => ({
  target: null,
  replyTo: (card) => set({ target: cardReplyTarget(card) }),
  close: () => set({ target: null }),
}));
