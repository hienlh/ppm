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
}

interface CardReplyState {
  target: CardReplyTarget | null;
  replyTo: (card: AssistantCard) => void;
  close: () => void;
}

export const useCardReplyStore = create<CardReplyState>((set) => ({
  target: null,
  replyTo: (card) => set({ target: { cardId: card.id, projectName: card.projectName, title: card.title } }),
  close: () => set({ target: null }),
}));
