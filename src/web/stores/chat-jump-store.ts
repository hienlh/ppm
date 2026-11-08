/**
 * A request to show a place in a chat — a call's tool card, or else the prompt that asked for
 * it, or the start of a turn — made from outside the chat (the Review tab's turn chip, a turn
 * reference, a `?turn=` link). The chat showing that session takes it up once the place is on
 * screen, which may be only after the tab opens and loads.
 *
 * A session can be renamed under an open tab (a Codex session adopts its thread id), so a request
 * naming the old id still belongs to the tab now holding the new one: tabs record each rename
 * here, and requests are matched through it.
 */
import { create } from "zustand";

export interface ChatJumpRequest {
  sessionId: string;
  /** The call to show; its card is drawn only once the message holding it is. */
  toolUseId?: string;
  /** The user message to show when the call's card is not drawn (a sub-agent's call, a collapsed card). */
  messageId?: string;
  /** The turn whose first message to show: a turn reference or a `?turn=` link. */
  turnId?: string;
  /** When it was asked: a request nothing can take up is dropped after a while. */
  at: number;
}

/** Renames remembered per page; each is one tab's session adopting its provider's id. */
const MAX_ALIASES = 200;

interface ChatJumpState {
  request: ChatJumpRequest | null;
  /** Old session id → the id it was renamed to. */
  aliases: Record<string, string>;
  jump: (request: Omit<ChatJumpRequest, "at">) => void;
  /** Taken up or given up: cleared only if it is still the same request. */
  done: (request: ChatJumpRequest) => void;
  /** A tab's session was renamed from `oldId` to `newId`. */
  noteRename: (oldId: string, newId: string) => void;
}

export const useChatJumpStore = create<ChatJumpState>((set, get) => ({
  request: null,
  aliases: {},
  jump: (request) => set({ request: { ...request, at: Date.now() } }),
  done: (request) => {
    if (get().request === request) set({ request: null });
  },
  noteRename: (oldId, newId) => {
    if (!oldId || !newId || oldId === newId) return;
    set((state) => {
      const keys = Object.keys(state.aliases);
      const kept = keys.length >= MAX_ALIASES
        ? Object.fromEntries(keys.slice(keys.length - MAX_ALIASES + 1).map((k) => [k, state.aliases[k]!]))
        : state.aliases;
      return { aliases: { ...kept, [oldId]: newId } };
    });
  },
}));

/** The id `sessionId` is known by now, following renames (bounded, so a cycle cannot hang). */
export function canonicalSessionId(sessionId: string, aliases: Record<string, string> = useChatJumpStore.getState().aliases): string {
  let id = sessionId;
  for (let i = 0; i < 8 && aliases[id]; i++) id = aliases[id]!;
  return id;
}

/** Whether a request is for the chat showing `sessionId`. */
export function requestIsFor(request: ChatJumpRequest | null, sessionId: string | null | undefined, aliases: Record<string, string>): boolean {
  if (!request || !sessionId) return false;
  return request.sessionId === sessionId || canonicalSessionId(request.sessionId, aliases) === canonicalSessionId(sessionId, aliases);
}
