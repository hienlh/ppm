/**
 * A request to show a place in a chat — a call's tool card, or else the prompt that asked for
 * it — made from outside the chat (the Review tab's turn chip). The chat showing that session
 * takes it up once the place is on screen, which may be only after the tab opens and loads.
 */
import { create } from "zustand";

export interface ChatJumpRequest {
  sessionId: string;
  /** The call to show; its card is drawn only once the message holding it is. */
  toolUseId?: string;
  /** The user message to show when the call's card is not drawn (a sub-agent's call, a collapsed card). */
  messageId?: string;
  /** When it was asked: a request nothing can take up is dropped after a while. */
  at: number;
}

interface ChatJumpState {
  request: ChatJumpRequest | null;
  jump: (request: Omit<ChatJumpRequest, "at">) => void;
  /** Taken up or given up: cleared only if it is still the same request. */
  done: (request: ChatJumpRequest) => void;
}

export const useChatJumpStore = create<ChatJumpState>((set, get) => ({
  request: null,
  jump: (request) => set({ request: { ...request, at: Date.now() } }),
  done: (request) => {
    if (get().request === request) set({ request: null });
  },
}));
