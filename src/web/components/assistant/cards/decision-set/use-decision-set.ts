/**
 * The set of decisions behind one surface (the Assistant's stream, or a manager chat's bar): its
 * tabs in a stable order, the tab shown, and the two ways to send. The cards come from the waiting
 * list every red count is made of; what the user picked lives in `decision-set-store.ts`.
 *
 * Three things happen to cards while the set is open, and each keeps the user's place:
 * - a card arrives: it gets a tab at the end, the tab shown does not move;
 * - a card stops waiting without being sent from here (Telegram, another device, it expired):
 *   its tab stays, struck through and named, and it is out of "Send all";
 * - a card changes (a new draft): its pick is taken back, with a word on its tab.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { applyAssistantCard, useAssistantCardsStore } from "@/stores/assistant-cards-store";
import { applyOpenCardResult, orderWaitingCards, useOpenCards } from "@/stores/assistant-open-cards-store";
import { useWaitingJumpStore } from "@/stores/assistant-waiting-jump-store";
import {
  clearOutdatedPicks, markDone, resetDecisionSet, setConfirm, setNotice, setOrder, setSending, useDecisionSetStore,
  type DoneTab,
} from "@/stores/decision-set-store";
import {
  answerLabel, isDecisionCard, nextTabOrder, outdatedPicks, sendPlan, type DecisionAnswer,
} from "@/lib/decision-set/decision-set-model";
import { sendAllDecisions, sendDecision, type SendOutcome } from "@/lib/decision-set/decision-set-send";
import type { AssistantCard } from "../../../../../shared/assistant-cards";
import { answerSummary } from "../answered-card-fold";
import { decisionSendApi } from "./decision-send-api";

export type SetTab =
  | { kind: "waiting"; card: AssistantCard }
  | { kind: "done"; card: AssistantCard; done: DoneTab };

/** An answer took effect: the stream's list and the waiting list both take the card at once. */
function takeCard(card: AssistantCard): void {
  applyAssistantCard(card);
  applyOpenCardResult(card);
}

/**
 * Notices cards that left the waiting list without being sent from here. Watches the whole list,
 * not one surface's share of it: a project filter hiding a card is not the card being answered.
 */
function useDepartures(waiting: readonly AssistantCard[] | null): void {
  const seen = useRef<Map<string, AssistantCard> | null>(null);
  const history = useAssistantCardsStore((s) => s.cards);
  useEffect(() => {
    if (!waiting) return;
    const now = new Map(waiting.map((c) => [c.id, c]));
    const before = seen.current;
    seen.current = now;
    if (!before) return;
    const { done } = useDecisionSetStore.getState();
    for (const [id, card] of before) {
      if (now.has(id) || done[id]) continue;
      const latest = history?.find((c) => c.id === id) ?? card;
      markDone({ card: latest, how: "elsewhere", note: latest.status === "open" ? "No longer waiting" : answerSummary(latest), at: Date.now() });
    }
    if (now.size === 0) resetDecisionSet();
  }, [waiting, history]);
}

export function useDecisionSet(scope: (card: AssistantCard) => boolean) {
  const open = useOpenCards();
  const allWaiting = useMemo(() => (open ? orderWaitingCards(open).filter(isDecisionCard) : null), [open]);
  useDepartures(allWaiting);

  const picks = useDecisionSetStore((s) => s.picks);
  const done = useDecisionSetStore((s) => s.done);
  const order = useDecisionSetStore((s) => s.order);
  const waiting = useMemo(() => (allWaiting ?? []).filter(scope), [allWaiting, scope]);

  // The order every surface shares: new cards at the end, finished ones kept where they were.
  // `done` is read from the store, not from this render: a card that left in this very commit was
  // marked done by `useDepartures` just above, and must keep its place.
  useEffect(() => {
    if (!allWaiting) return;
    const { order: before, done: finished } = useDecisionSetStore.getState();
    setOrder(nextTabOrder(before, allWaiting.map((c) => c.id), new Set(Object.keys(finished))));
  }, [allWaiting, done]);

  // A card that changed since it was picked loses its pick.
  useEffect(() => { clearOutdatedPicks(outdatedPicks(waiting, useDecisionSetStore.getState().picks)); }, [waiting]);

  const tabs = useMemo<SetTab[]>(() => {
    const byId = new Map(waiting.map((c) => [c.id, c]));
    const list: SetTab[] = [];
    const placed = new Set<string>();
    for (const id of order) {
      const card = byId.get(id);
      if (card) list.push({ kind: "waiting", card });
      else if (done[id] && scope(done[id]!.card)) list.push({ kind: "done", card: done[id]!.card, done: done[id]! });
      placed.add(id);
    }
    // The order catches up an effect later; a card shown before that still gets its tab.
    for (const card of waiting) if (!placed.has(card.id)) list.push({ kind: "waiting", card });
    return list;
  }, [waiting, order, done, scope]);

  const [activeId, setActiveId] = useState<string | null>(null);
  let index = tabs.findIndex((t) => t.card.id === activeId);
  if (index < 0) index = Math.max(0, tabs.findIndex((t) => t.kind === "waiting"));
  const active = tabs[index] ?? null;

  // The Waiting chip, a red count or a stub in the stream asks for one card: show its tab.
  const request = useWaitingJumpStore((s) => s.request);
  useEffect(() => {
    if (request && tabs.some((t) => t.card.id === request.cardId)) setActiveId(request.cardId);
    // Only a new request moves the tab.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request]);

  const go = useCallback((by: number) => {
    if (!tabs.length) return;
    setActiveId(tabs[Math.min(tabs.length - 1, Math.max(0, index + by))]!.card.id);
  }, [tabs, index]);

  /** The next card that still waits after `fromId`, wrapping round; null when none. */
  const nextWaiting = useCallback((fromId: string): string | null => {
    const at = tabs.findIndex((t) => t.card.id === fromId);
    for (let i = 1; i <= tabs.length; i++) {
      const tab = tabs[(at + i) % tabs.length]!;
      if (tab.kind === "waiting" && tab.card.id !== fromId) return tab.card.id;
    }
    return null;
  }, [tabs]);

  const land = useCallback((card: AssistantCard, answer: DecisionAnswer, outcome: SendOutcome) => {
    setSending(card.id, false);
    switch (outcome.status) {
      case "sent":
        // Marked first, so the card leaving the waiting list is not taken for an answer from elsewhere.
        markDone({ card: outcome.card, how: "sent", note: answerLabel(card, answer), at: Date.now() });
        takeCard(outcome.card);
        return;
      case "elsewhere":
        markDone({ card: outcome.card ?? card, how: "elsewhere", note: outcome.message, at: Date.now() });
        if (outcome.card) takeCard(outcome.card);
        return;
      case "confirm":
        setConfirm(card.id, outcome.question);
        return;
      case "changed":
      case "failed":
        setNotice(card.id, outcome.message);
        if (outcome.card) takeCard(outcome.card);
    }
  }, []);

  const sendOne = useCallback(async (card: AssistantCard, answer: DecisionAnswer, force = false) => {
    // Held on this card's tab, so what the server says about it (answered elsewhere, a question)
    // is read where it was sent from.
    setActiveId(card.id);
    setSending(card.id, true);
    setConfirm(card.id, null);
    const outcome = await sendDecision(card, answer, decisionSendApi, { force });
    land(card, answer, outcome);
    if (outcome.status === "sent") {
      const next = nextWaiting(card.id);
      if (next) setActiveId(next);
    }
  }, [land, nextWaiting]);

  const plan = useMemo(() => sendPlan(waiting, picks), [waiting, picks]);

  const sendAll = useCallback(async () => {
    const answers = new Map(plan.map((p) => [p.card.id, p.answer]));
    for (const { card } of plan) setSending(card.id, true);
    await sendAllDecisions(plan, decisionSendApi, (id, outcome) => {
      const card = plan.find((p) => p.card.id === id)!.card;
      land(card, answers.get(id)!, outcome);
    });
  }, [plan, land]);

  return { tabs, index, active, setActiveId, go, waiting, plan, sendOne, sendAll };
}
