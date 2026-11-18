/**
 * The set of decisions behind one surface (the Assistant's stream, or a manager chat's bar): its
 * tabs in a stable order, the tab shown, and the two ways to send. The cards come from the waiting
 * list every red count is made of; what the user picked lives in `decision-set-store.ts`.
 *
 * The set holds only what still waits, so its tabs, its heading and the Waiting chip count the
 * same cards. While the set is open:
 * - a card arrives: it gets a tab at the end, the tab shown does not move;
 * - a card stops waiting (answered here, on Telegram, in another window, dismissed, closed by its
 *   manager): its tab leaves at once, and when it was the one shown the next waiting card opens;
 * - a card changes (a new draft): its pick is taken back, with a word on its tab.
 * A send from here says how it went in one line above the card shown (`flash`).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { applyAssistantCard } from "@/stores/assistant-cards-store";
import { applyOpenCardResult, orderWaitingCards, useOpenCards } from "@/stores/assistant-open-cards-store";
import { useWaitingJumpStore } from "@/stores/assistant-waiting-jump-store";
import {
  clearOutdatedPicks, forgetCard, resetDecisionSet, setConfirm, setNotice, setOrder, setSending, useDecisionSetStore,
} from "@/stores/decision-set-store";
import {
  activeTabIndex, answerLabel, decisionTabs, isDecisionCard, nextTabOrder, outdatedPicks, sendPlan, type DecisionAnswer,
} from "@/lib/decision-set/decision-set-model";
import { sendAllDecisions, sendDecision, type SendOutcome } from "@/lib/decision-set/decision-set-send";
import type { AssistantCard } from "../../../../../shared/assistant-cards";
import { decisionSendApi } from "./decision-send-api";

/** One line about the last send from here: sent, or refused because someone answered first. */
export interface SetFlash {
  tone: "sent" | "elsewhere";
  text: string;
}

/** An answer took effect: the stream's list and the waiting list both take the card at once. */
function takeCard(card: AssistantCard): void {
  applyAssistantCard(card);
  applyOpenCardResult(card);
}

/**
 * Forgets what was picked for cards that left the waiting list, and starts the set clean once
 * nothing waits. Watches the whole list, not one surface's share of it: a project filter hiding a
 * card is not the card being answered.
 */
function useDepartures(waiting: readonly AssistantCard[] | null): void {
  const seen = useRef<Set<string> | null>(null);
  const sending = useDecisionSetStore((s) => s.sending);
  useEffect(() => {
    if (!waiting) return;
    const now = new Set(waiting.map((c) => c.id));
    const before = seen.current;
    seen.current = now;
    const inFlight = useDecisionSetStore.getState().sending;
    // A card being sent from here leaves the list before the answer comes back (the server marks
    // it answered, then forwards): its own send keeps the pick if the forward fails.
    if (before) for (const id of before) if (!now.has(id) && !inFlight[id]) forgetCard(id);
    if (now.size === 0 && Object.keys(inFlight).length === 0) resetDecisionSet();
  }, [waiting, sending]);
}

export function useDecisionSet(scope: (card: AssistantCard) => boolean) {
  const open = useOpenCards();
  const allWaiting = useMemo(() => (open ? orderWaitingCards(open).filter(isDecisionCard) : null), [open]);
  useDepartures(allWaiting);

  const picks = useDecisionSetStore((s) => s.picks);
  const order = useDecisionSetStore((s) => s.order);
  const sending = useDecisionSetStore((s) => s.sending);
  const waiting = useMemo(() => (allWaiting ?? []).filter(scope), [allWaiting, scope]);

  // The order every surface shares: new cards at the end, a card being sent kept where it was.
  useEffect(() => {
    if (!allWaiting) return;
    const { order: before, sending: inFlight } = useDecisionSetStore.getState();
    setOrder(nextTabOrder(before, allWaiting.map((c) => c.id), new Set(Object.keys(inFlight))));
  }, [allWaiting, sending]);

  // A card that changed since it was picked loses its pick.
  useEffect(() => { clearOutdatedPicks(outdatedPicks(waiting, useDecisionSetStore.getState().picks)); }, [waiting]);

  const tabs = useMemo(() => decisionTabs(order, waiting, sending, scope), [order, waiting, sending, scope]);

  const [activeId, setActiveId] = useState<string | null>(null);
  const [flash, setFlash] = useState<SetFlash | null>(null);
  const lastIndex = useRef(0);
  const index = activeTabIndex(tabs.map((c) => c.id), activeId, lastIndex.current);
  const active = index >= 0 ? tabs[index]! : null;
  useEffect(() => { if (index >= 0) lastIndex.current = index; }, [index]);
  // The tab shown left (answered elsewhere): the card now in its place is the one shown, and stays
  // shown when other cards come and go.
  useEffect(() => {
    if (active && activeId !== null && active.id !== activeId) setActiveId(active.id);
  }, [active, activeId]);

  /** The user moved: the line about the last send is about a card no longer in view. */
  const show = useCallback((id: string) => { setFlash(null); setActiveId(id); }, []);

  // The Waiting chip, a red count or a stub in the stream asks for one card: show its tab.
  const request = useWaitingJumpStore((s) => s.request);
  useEffect(() => {
    if (request && tabs.some((c) => c.id === request.cardId)) show(request.cardId);
    // Only a new request moves the tab.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request]);

  const go = useCallback((by: number) => {
    if (!tabs.length) return;
    show(tabs[Math.min(tabs.length - 1, Math.max(0, index + by))]!.id);
  }, [tabs, index, show]);

  /** The next card that still waits after `fromId`, wrapping round; null when none. */
  const nextWaiting = useCallback((fromId: string): string | null => {
    const at = tabs.findIndex((c) => c.id === fromId);
    for (let i = 1; i <= tabs.length; i++) {
      const next = tabs[(at + i) % tabs.length]!;
      if (next.id !== fromId && !useDecisionSetStore.getState().sending[next.id]) return next.id;
    }
    return null;
  }, [tabs]);

  /** What the server said about one card; returns the line to show when the card left the set. */
  const land = useCallback((card: AssistantCard, answer: DecisionAnswer, outcome: SendOutcome): SetFlash | null => {
    setSending(card, false);
    switch (outcome.status) {
      case "sent":
        forgetCard(card.id);
        takeCard(outcome.card);
        return { tone: "sent", text: `Sent “${card.title}”: ${answerLabel(card, answer)}` };
      case "elsewhere":
        forgetCard(card.id);
        if (outcome.card) takeCard(outcome.card);
        return { tone: "elsewhere", text: `“${card.title}”: ${outcome.message}` };
      case "confirm":
        setConfirm(card.id, outcome.question);
        return null;
      case "changed":
      case "failed":
        setNotice(card.id, outcome.message);
        if (outcome.card) takeCard(outcome.card);
        return null;
    }
  }, []);

  const sendOne = useCallback(async (card: AssistantCard, answer: DecisionAnswer, confirmAge = false) => {
    // One send per card at a time: a second press while the first is out does nothing.
    if (useDecisionSetStore.getState().sending[card.id]) return;
    // Held on this card's tab, so what the server says about it (a question, a failure) is read
    // where it was sent from.
    show(card.id);
    const next = nextWaiting(card.id);
    setSending(card, true);
    setConfirm(card.id, null);
    const outcome = await sendDecision(card, answer, decisionSendApi, { confirmAge });
    const said = land(card, answer, outcome);
    if (said) {
      // The card left: the next one that waits opens, with a word about the one just sent.
      if (next) setActiveId(next);
      setFlash(said);
    }
  }, [land, nextWaiting, show]);

  const plan = useMemo(() => sendPlan(waiting, picks), [waiting, picks]);

  const sendAll = useCallback(async () => {
    // A second press (or a card's own send) must not send any of these twice.
    const inFlight = useDecisionSetStore.getState().sending;
    const todo = plan.filter((p) => !inFlight[p.card.id]);
    if (!todo.length) return;
    setFlash(null);
    const answers = new Map(todo.map((p) => [p.card.id, p.answer]));
    for (const { card } of todo) setSending(card, true);
    let sent = 0;
    const elsewhere: string[] = [];
    await sendAllDecisions(todo, decisionSendApi, (id, outcome) => {
      const card = todo.find((p) => p.card.id === id)!.card;
      const said = land(card, answers.get(id)!, outcome);
      if (said?.tone === "sent") sent += 1;
      else if (said) elsewhere.push(said.text);
    });
    const parts = [sent ? `Sent ${sent} answer${sent === 1 ? "" : "s"}.` : "", ...elsewhere].filter(Boolean);
    if (parts.length) setFlash({ tone: elsewhere.length ? "elsewhere" : "sent", text: parts.join(" ") });
  }, [plan, land]);

  return { tabs, index, active, setActiveId: show, go, waiting, plan, sendOne, sendAll, flash };
}
