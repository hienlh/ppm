/**
 * The Assistant's "Waiting on you" bar: every card the red counts are made of, pinned above the
 * stream. It follows the project filter like the stream does; cards the filter hides are named in
 * one line that clears it, so a count on the rail or the dock always has its cards in reach.
 *
 * A press on a chip's red count asks for that project's first card (`focusWaitingCards`): the bar
 * opens on it, outlined; a filter that would hide it moves to that project.
 */
import { useEffect, useState } from "react";
import { applyAssistantCard, setAssistantCardFilter, useAssistantCardsStore } from "@/stores/assistant-cards-store";
import {
  applyOpenCardResult, orderWaitingCards, useOpenCards, useOpenCardsStore,
} from "@/stores/assistant-open-cards-store";
import type { AssistantCard } from "../../../shared/assistant-cards";
import { WaitingCardsBar, type WaitingBarFocus } from "./waiting-cards-bar";

export const WAITING_LABEL = "Waiting on you";

/** The card a press on a project's red count lands on: its first waiting card, else the first of all. */
export function focusTarget(ordered: readonly AssistantCard[], projectName: string | null): AssistantCard | null {
  return (projectName ? ordered.find((c) => c.projectName === projectName) : undefined) ?? ordered[0] ?? null;
}

function takeCard(card: AssistantCard): void {
  applyAssistantCard(card);
  applyOpenCardResult(card);
}

export function AssistantWaitingCards() {
  const all = useOpenCards();
  const filter = useAssistantCardsStore((s) => s.filter);
  const focus = useOpenCardsStore((s) => s.focus);
  const [barFocus, setBarFocus] = useState<WaitingBarFocus | null>(null);
  const ordered = orderWaitingCards(all ?? []);

  useEffect(() => {
    if (!focus || !all) return;
    const target = focusTarget(ordered, focus.projectName);
    // A filter that would hide the card moves to the card's project (or to every project).
    if (target && filter && target.projectName !== filter) setAssistantCardFilter(target.projectName);
    setBarFocus({ cardId: target?.id ?? null, nonce: focus.nonce });
    // Taken once: a later visit to the Assistant must not land on it again.
    useOpenCardsStore.setState({ focus: null });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus, all]);
  // The bar (a child, so its effects ran first) has landed: a later filter change, which mounts
  // the bar afresh, must not land on that card again.
  useEffect(() => { if (barFocus) setBarFocus(null); }, [barFocus]);

  if (!all) return null;
  const shown = filter ? ordered.filter((c) => c.projectName === filter) : ordered;
  const elsewhere = ordered.length - shown.length;
  const others = elsewhere > 0 && (
    <p className="flex flex-wrap items-center gap-x-1.5 px-3 pb-1.5 text-xs text-text-secondary" data-waiting-elsewhere="">
      {elsewhere} more waiting in other projects ·
      <button
        type="button"
        onClick={() => setAssistantCardFilter(null)}
        className="inline-flex min-h-11 items-center font-medium text-primary md:min-h-6"
      >
        Show all
      </button>
    </p>
  );
  if (shown.length === 0) {
    return others ? <div className="shrink-0 border-b border-border bg-panel-2/60" data-waiting-cards="" data-waiting-count={0}>{others}</div> : null;
  }
  return (
    <WaitingCardsBar
      // A filter change is a different list, not new cards arriving.
      key={filter ?? "*"}
      cards={shown}
      label={WAITING_LABEL}
      focus={barFocus}
      onCard={takeCard}
      note={others}
    />
  );
}
