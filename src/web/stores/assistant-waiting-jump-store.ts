/**
 * Moving the Assistant's stream to a card that waits on the user. Every waiting card is drawn once,
 * whole, at its own place in the stream; the dock above the composer, a red count and a "Show" on
 * a follow-up only ask for a jump here. The Assistant's body answers it (`use-waiting-card-jump.ts`):
 * it scrolls the stream to the card and outlines it for a moment (`lit`).
 */
import { create } from "zustand";

/** How long the card a jump lands on stays outlined. */
export const WAITING_HIGHLIGHT_MS = 1800;

interface WaitingJumpState {
  /** The last jump asked for; `nonce` makes each press new, the same card included. */
  request: { cardId: string; nonce: number } | null;
  /** The card outlined right now, if any. */
  lit: string | null;
}

export const useWaitingJumpStore = create<WaitingJumpState>(() => ({ request: null, lit: null }));

let nonce = 0;

/** Asks the Assistant's stream to scroll to one waiting card and outline it. */
export function jumpToWaitingCard(cardId: string): void {
  nonce += 1;
  useWaitingJumpStore.setState({ request: { cardId, nonce } });
}

let unlight: ReturnType<typeof setTimeout> | null = null;

/** Outlines one card for `WAITING_HIGHLIGHT_MS`; a second landing restarts the time. */
export function lightWaitingCard(cardId: string): void {
  if (unlight) clearTimeout(unlight);
  useWaitingJumpStore.setState({ lit: cardId });
  unlight = setTimeout(() => {
    unlight = null;
    useWaitingJumpStore.setState((s) => (s.lit === cardId ? { lit: null } : s));
  }, WAITING_HIGHLIGHT_MS);
}
