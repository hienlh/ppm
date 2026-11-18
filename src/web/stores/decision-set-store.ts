/**
 * What the user has picked in the set of decisions, kept outside the components: the Assistant's
 * stream re-places its items as messages arrive and a manager chat's bar mounts its own copy of
 * the set, and a pick made in one must still be there in the other. Never stored on disk: a
 * reload starts with nothing picked, as a reload of the chat's own question card does.
 *
 * The set holds only cards that still wait. A card answered anywhere — here, on Telegram, in
 * another window, dismissed, closed by its manager — leaves it at once; the one exception is a
 * card whose answer is on its way from here, held in `sending` until the send says how it went.
 */
import { create } from "zustand";
import type { AssistantCard } from "../../shared/assistant-cards";
import type { DecisionAnswer, DecisionPick } from "@/lib/decision-set/decision-set-model";
import { cardVersion } from "@/lib/decision-set/decision-set-model";

interface DecisionSetState {
  picks: Record<string, DecisionPick>;
  /** A word on one card's tab: why its pick was cleared, why a send failed. */
  notices: Record<string, string>;
  /** The server's "send anyway?" for one card, until answered. */
  confirms: Record<string, string>;
  /** The tabs' order: waiting ids, and those being sent from here. */
  order: string[];
  /** Cards being sent from here right now, as they were when sent. */
  sending: Record<string, AssistantCard>;
}

const initial = (): DecisionSetState => ({ picks: {}, notices: {}, confirms: {}, order: [], sending: {} });

export const useDecisionSetStore = create<DecisionSetState>(() => initial());

const without = <T,>(record: Record<string, T>, id: string): Record<string, T> => {
  if (!(id in record)) return record;
  const next = { ...record };
  delete next[id];
  return next;
};

export function pickAnswer(card: AssistantCard, answer: DecisionAnswer | null): void {
  useDecisionSetStore.setState((s) => ({
    picks: answer ? { ...s.picks, [card.id]: { answer, version: cardVersion(card) } } : without(s.picks, card.id),
    notices: without(s.notices, card.id),
    confirms: without(s.confirms, card.id),
  }));
}

/** Picks made on an older version of their card are taken back, with a word on the tab. */
export function clearOutdatedPicks(ids: readonly string[]): void {
  if (!ids.length) return;
  useDecisionSetStore.setState((s) => {
    const picks = { ...s.picks };
    const notices = { ...s.notices };
    for (const id of ids) {
      delete picks[id];
      notices[id] = "This card changed after you picked an answer. Look at it again.";
    }
    return { picks, notices };
  });
}

export function setNotice(id: string, notice: string | null): void {
  useDecisionSetStore.setState((s) => ({ notices: notice ? { ...s.notices, [id]: notice } : without(s.notices, id) }));
}

export function setConfirm(id: string, question: string | null): void {
  useDecisionSetStore.setState((s) => ({ confirms: question ? { ...s.confirms, [id]: question } : without(s.confirms, id) }));
}

export function setSending(card: AssistantCard, on: boolean): void {
  useDecisionSetStore.setState((s) => ({ sending: on ? { ...s.sending, [card.id]: card } : without(s.sending, card.id) }));
}

/** A card stopped waiting: what was picked or said about it goes with it. */
export function forgetCard(id: string): void {
  useDecisionSetStore.setState((s) => {
    if (!(id in s.picks) && !(id in s.confirms) && !(id in s.notices)) return s;
    return { picks: without(s.picks, id), confirms: without(s.confirms, id), notices: without(s.notices, id) };
  });
}

export function setOrder(order: string[]): void {
  useDecisionSetStore.setState((s) => (s.order.length === order.length && s.order.every((id, i) => id === order[i]) ? s : { order }));
}

/** Nothing waits any more: the set starts clean next time. */
export function resetDecisionSet(): void {
  // Already clean: no new state, so nothing subscribed runs again for it.
  const s = useDecisionSetStore.getState();
  const empty = (r: Record<string, unknown>) => Object.keys(r).length === 0;
  if (empty(s.picks) && empty(s.notices) && empty(s.confirms) && empty(s.sending) && s.order.length === 0) return;
  useDecisionSetStore.setState(initial());
}
