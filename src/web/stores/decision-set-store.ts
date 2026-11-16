/**
 * What the user has picked in the set of decisions, kept outside the components: the Assistant's
 * stream re-places its items as messages arrive and a manager chat's bar mounts its own copy of
 * the set, and a pick made in one must still be there in the other. Never stored on disk: a
 * reload starts with nothing picked, as a reload of the chat's own question card does.
 *
 * `done` keeps a tab for a card that stopped waiting while the set was open — sent from here, or
 * answered elsewhere — so the user sees what happened to it instead of a tab vanishing under
 * their finger. It is cleared once no decision waits any more.
 */
import { create } from "zustand";
import type { AssistantCard } from "../../shared/assistant-cards";
import type { DecisionAnswer, DecisionPick } from "@/lib/decision-set/decision-set-model";
import { cardVersion } from "@/lib/decision-set/decision-set-model";

/** How many finished tabs the set keeps showing; older ones leave first. */
const MAX_DONE = 6;

export interface DoneTab {
  card: AssistantCard;
  how: "sent" | "elsewhere";
  /** What happened, in a few words ("Chose “Ship tonight”", "Answered on Telegram at 21:16"). */
  note: string;
  at: number;
}

interface DecisionSetState {
  picks: Record<string, DecisionPick>;
  /** A word on one card's tab: why its pick was cleared, why a send failed. */
  notices: Record<string, string>;
  /** The server's "send anyway?" for one card, until answered. */
  confirms: Record<string, string>;
  done: Record<string, DoneTab>;
  /** The tabs' order, waiting and done ids together. */
  order: string[];
  /** Ids being sent right now. */
  sending: Record<string, true>;
}

const initial = (): DecisionSetState => ({ picks: {}, notices: {}, confirms: {}, done: {}, order: [], sending: {} });

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

export function setSending(id: string, on: boolean): void {
  useDecisionSetStore.setState((s) => ({ sending: on ? { ...s.sending, [id]: true } : without(s.sending, id) }));
}

/** A card stopped waiting: its tab stays, marked, and its pick is gone. */
export function markDone(tab: DoneTab): void {
  useDecisionSetStore.setState((s) => {
    if (s.done[tab.card.id]?.how === "sent") return s;
    const done = { ...s.done, [tab.card.id]: tab };
    const ids = Object.values(done).sort((a, b) => a.at - b.at).map((d) => d.card.id);
    for (const old of ids.slice(0, Math.max(0, ids.length - MAX_DONE))) delete done[old];
    return {
      done,
      picks: without(s.picks, tab.card.id),
      confirms: without(s.confirms, tab.card.id),
      notices: without(s.notices, tab.card.id),
    };
  });
}

export function setOrder(order: string[]): void {
  useDecisionSetStore.setState((s) => (s.order.length === order.length && s.order.every((id, i) => id === order[i]) ? s : { order }));
}

/** Nothing waits any more: the set starts clean next time. */
export function resetDecisionSet(): void {
  useDecisionSetStore.setState(initial());
}
