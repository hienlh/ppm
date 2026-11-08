/**
 * Which turn each live user message opened, as the server said on `turn_started` (or replayed in
 * `session_state.turnBindings` to a socket that joined late). Keyed by the browser's own id for
 * the message (`clientMessageId`, random per send), so a queued message never borrows the turn
 * that was running when it was sent, a steered one gets the running turn it joined, and a Codex
 * session renamed mid-turn still finds its binding.
 *
 * A message from history carries its `turnId` already; this only covers the stretch between a
 * send and the history reload that stamps it.
 */
import { create } from "zustand";

/** Bindings kept per page lifetime; old ones are only ever asked about by a Copy turn link. */
const MAX_BINDINGS = 500;

interface TurnBindingState {
  bindings: Record<string, string>;
  /** Record that the message the browser sent as `clientId` belongs to `turnId`. */
  bind: (clientId: string, turnId: string) => void;
}

export const useTurnBindingStore = create<TurnBindingState>((set) => ({
  bindings: {},
  bind: (clientId, turnId) => set((state) => {
    if (state.bindings[clientId] === turnId) return state;
    const keys = Object.keys(state.bindings);
    const kept = keys.length >= MAX_BINDINGS
      ? Object.fromEntries(keys.slice(keys.length - MAX_BINDINGS + 1).map((k) => [k, state.bindings[k]!]))
      : state.bindings;
    return { bindings: { ...kept, [clientId]: turnId } };
  }),
}));

/** The turn a live message was bound to, if the server has said. */
export function boundTurnId(clientId: string | undefined): string | undefined {
  return clientId ? useTurnBindingStore.getState().bindings[clientId] : undefined;
}

/** Hook form of {@link boundTurnId}: re-renders only when this message's binding arrives. */
export function useBoundTurnId(clientId: string | undefined): string | undefined {
  return useTurnBindingStore((state) => (clientId ? state.bindings[clientId] : undefined));
}

/** Record every binding of a `session_state.turnBindings` list; anything malformed is skipped. */
export function bindAll(list: unknown): void {
  if (!Array.isArray(list)) return;
  const { bind } = useTurnBindingStore.getState();
  for (const item of list) {
    const b = item as { turnId?: unknown; clientMessageId?: unknown } | null;
    if (b && typeof b.turnId === "string" && typeof b.clientMessageId === "string") bind(b.clientMessageId, b.turnId);
  }
}
