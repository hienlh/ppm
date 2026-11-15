/**
 * The Assistant's "Waiting on you" dock, right above its composer. Every waiting card is drawn once,
 * whole, at its own place in the stream (`use-assistant-stream-timeline.tsx`); the dock only says how
 * many wait and gets the user to them: a press on it, or on ‹ ›, scrolls the stream to that card and
 * outlines it. It follows the project filter like the stream does; cards the filter hides are named
 * in one line that clears it, so a count on the rail or the dock always has its cards in reach.
 * Nothing waiting, no dock.
 */
import { useEffect, useRef, useState } from "react";
import { BellRing, ChevronLeft, ChevronRight } from "@/lib/icons";
import { applyAssistantCard, setAssistantCardFilter, useAssistantCardsStore } from "@/stores/assistant-cards-store";
import { applyOpenCardResult, orderWaitingCards, useOpenCards } from "@/stores/assistant-open-cards-store";
import { jumpToWaitingCard, useWaitingJumpStore } from "@/stores/assistant-waiting-jump-store";
import type { AssistantCard } from "../../../shared/assistant-cards";
import { WaitingStreamCard } from "./cards/waiting-stream-card";
import { WaitingBadge } from "./manager-chip";

export const WAITING_LABEL = "Waiting on you";

const NAV = "grid size-11 shrink-0 place-items-center rounded-full text-text-secondary can-hover:hover:bg-error/10 can-hover:hover:text-text-primary md:size-8";

/** "ppm · Ship 0.26.2?": what the dock says about the card it is on. */
export function dockSummary(card: AssistantCard): string {
  return card.projectName ? `${card.projectName} · ${card.title}` : card.title;
}

/**
 * Which card the dock is on, by id. A card that arrives moves the dock to itself (without scrolling
 * the stream: the user may be reading); an answered card leaves the dock at its place in the list,
 * which now holds the next one; a jump from elsewhere (a red count, a follow-up's "Show") moves it
 * to the card the stream landed on.
 */
function useDockPosition(cards: readonly AssistantCard[]) {
  const [currentId, setCurrentId] = useState<string | null>(cards[0]?.id ?? null);
  const lastIndex = useRef(0);
  const known = useRef<Set<string> | null>(null);

  useEffect(() => {
    const ids = new Set(cards.map((c) => c.id));
    const before = known.current;
    known.current = ids;
    if (!before) return;
    const fresh = [...cards].reverse().find((c) => !before.has(c.id));
    if (fresh) setCurrentId(fresh.id);
  }, [cards]);

  const jumped = useWaitingJumpStore((s) => s.request);
  useEffect(() => {
    if (jumped && cards.some((c) => c.id === jumped.cardId)) setCurrentId(jumped.cardId);
    // Only a new jump moves the dock; the list changing under it does not.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jumped]);

  let index = cards.findIndex((c) => c.id === currentId);
  if (index < 0) index = Math.min(lastIndex.current, cards.length - 1);
  lastIndex.current = Math.max(index, 0);
  return { index, setCurrentId };
}

function WaitingDock({ cards, elsewhere }: { cards: readonly AssistantCard[]; elsewhere: number }) {
  const { index, setCurrentId } = useDockPosition(cards);
  const current = index >= 0 ? cards[index]! : null;
  const go = (card: AssistantCard) => { setCurrentId(card.id); jumpToWaitingCard(card.id); };
  const step = (by: number) => go(cards[(index + by + cards.length) % cards.length]!);

  const others = elsewhere > 0 && (
    <p className="flex flex-wrap items-center gap-x-1.5 px-3 text-xs text-text-secondary" data-waiting-elsewhere="">
      {current ? `${elsewhere} more in other projects` : `${elsewhere} waiting in other projects`} ·
      <button
        type="button"
        onClick={() => setAssistantCardFilter(null)}
        className="inline-flex min-h-11 items-center font-medium text-primary md:min-h-7"
      >
        Show all
      </button>
    </p>
  );

  return (
    // Opaque: on a phone the stream runs on under the footer, and a see-through dock showed the
    // card behind it through its text. The tint sits on an inner layer over the surface colour.
    <section
      aria-label={WAITING_LABEL}
      className="mb-1 overflow-hidden rounded-xl border border-error/35 bg-surface"
      data-waiting-dock=""
      data-waiting-count={cards.length}
    >
      <div className="bg-error/5">
        {current && (
          <div className="flex min-h-12 min-w-0 items-center gap-1 pr-1 md:min-h-10">
            <button
              type="button"
              onClick={() => go(current)}
              aria-label={`Go to "${current.title}", waiting on you`}
              className="flex min-h-12 min-w-0 flex-1 items-center gap-2 pl-2.5 text-left md:min-h-10"
              data-waiting-go=""
            >
              <span aria-hidden className="grid size-6 shrink-0 place-items-center rounded-full bg-error/10 text-error">
                <BellRing className="size-3.5" />
              </span>
              <span className="shrink-0 text-[13px] font-semibold text-text-primary">{WAITING_LABEL}</span>
              <WaitingBadge count={cards.length} />
              <span className="min-w-0 flex-1 truncate text-xs text-text-secondary" data-waiting-summary="">
                {dockSummary(current)}
              </span>
            </button>
            {cards.length > 1 && (
              <div className="flex shrink-0 items-center" data-waiting-pager="">
                <button type="button" className={NAV} onClick={() => step(-1)} aria-label="Previous waiting card">
                  <ChevronLeft className="size-4" />
                </button>
                <span className="min-w-8 text-center text-xs font-medium tabular-nums text-text-secondary" data-waiting-position="">
                  {index + 1}/{cards.length}
                </span>
                <button type="button" className={NAV} onClick={() => step(1)} aria-label="Next waiting card">
                  <ChevronRight className="size-4" />
                </button>
              </div>
            )}
          </div>
        )}
        {others}
      </div>
    </section>
  );
}

export function AssistantWaitingDock() {
  const all = useOpenCards();
  const filter = useAssistantCardsStore((s) => s.filter);
  if (!all || all.length === 0) return null;
  const ordered = orderWaitingCards(all);
  const shown = filter ? ordered.filter((c) => c.projectName === filter) : ordered;
  // A filter change is a different list, not new cards arriving.
  return <WaitingDock key={filter ?? "*"} cards={shown} elsewhere={ordered.length - shown.length} />;
}

/** An answer on a waiting card: the stream's list and the waiting list both take it at once. */
function takeCard(card: AssistantCard): void {
  applyAssistantCard(card);
  applyOpenCardResult(card);
}

/**
 * The waiting cards on their own, whole, for when the Assistant has no chat to place them in (no AI
 * provider, or the list of providers failed to load): a red count on the chip row still has its
 * cards in reach, and still lands on them.
 */
export function AssistantWaitingList() {
  const all = useOpenCards();
  const filter = useAssistantCardsStore((s) => s.filter);
  if (!all?.length) return null;
  const ordered = orderWaitingCards(all);
  const shown = filter ? ordered.filter((c) => c.projectName === filter) : ordered;
  if (!shown.length) return null;
  return (
    <section aria-label={WAITING_LABEL} className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 pb-4" data-waiting-list="">
      <h3 className="text-[13px] font-semibold text-text-primary">{WAITING_LABEL} · {shown.length}</h3>
      {shown.map((card) => <WaitingStreamCard key={card.id} card={card} onCard={takeCard} />)}
    </section>
  );
}
