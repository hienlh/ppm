/**
 * The Assistant's "Waiting on you" chip, on the left of the chat footer's context row (where an
 * ordinary chat shows its activity, changes and connection chips, and the Assistant had nothing).
 * Every waiting card is drawn once, whole, at its own place in the stream
 * (`use-assistant-stream-timeline.tsx`); the chip only says how many wait and gets the user to
 * them: a press on it, or on ‹ ›, scrolls the stream to that card and outlines it. It names no card
 * and no project — the stream shows those. It follows the project filter like the stream does;
 * cards the filter hides are a "+N" on the chip that clears it, so a count on the rail always has
 * its cards in reach. Nothing waiting, no chip.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { BellRing, ChevronLeft, ChevronRight } from "@/lib/icons";
import { cn } from "@/lib/utils";
import { applyAssistantCard, setAssistantCardFilter, useAssistantCardsStore } from "@/stores/assistant-cards-store";
import { applyOpenCardResult, orderWaitingCards, useOpenCards } from "@/stores/assistant-open-cards-store";
import { jumpToWaitingCard, useWaitingJumpStore } from "@/stores/assistant-waiting-jump-store";
import type { AssistantCard } from "../../../shared/assistant-cards";
import { WaitingStreamCard } from "./cards/waiting-stream-card";
import { DecisionSet } from "./cards/decision-set/decision-set";
import { isDecisionCard } from "@/lib/decision-set/decision-set-model";
import { WaitingBadge } from "./manager-chip";

export const WAITING_LABEL = "Waiting on you";

/**
 * The chip's shell, sized like the footer's other chips (`FOOTER_CHIP`: 28px, 26px on a phone) and
 * tinted like the connection chip's alert. Its parts are buttons of their own, so it is a group.
 * On a phone the last part's 44px hit area reaches 11px past the chip, so the chip keeps that much
 * margin inside the row's clip.
 */
const CHIP =
  "footer-fade-in relative inline-flex h-7 shrink-0 items-center rounded-full border border-error/35 bg-error/10 text-error " +
  "md:@max-[420px]/chat:h-8 max-md:mr-3 max-md:h-[26px]";

/** The part that jumps: bell, label and count. Grows only up and down to 44px on a phone. */
const GO =
  "relative inline-flex h-full items-center gap-1.5 whitespace-nowrap rounded-full pl-2.5 pr-2 text-[11.5px] font-medium " +
  "transition-[background-color,transform] duration-150 motion-safe:active:scale-[0.97] can-hover:hover:bg-error/10 " +
  "max-md:pl-[7px] max-md:after:absolute max-md:after:inset-x-0 max-md:after:-inset-y-2.5 max-md:after:content-[''] " +
  "[&_svg]:size-3.5 [&_svg]:shrink-0";

/** ‹ and ›: 22px drawn on a phone, a 44 × 44 hit area around it. */
const STEP =
  "relative inline-flex size-6 shrink-0 items-center justify-center rounded-full text-error/80 " +
  "transition-[background-color,color] duration-150 can-hover:hover:bg-error/10 can-hover:hover:text-error " +
  "max-md:size-[22px] max-md:after:absolute max-md:after:-inset-x-[11px] max-md:after:-inset-y-[11px] max-md:after:content-[''] " +
  "[&_svg]:size-3.5";

/**
 * Which card the chip is on, by id. A card that arrives moves the chip to itself (without scrolling
 * the stream: the user may be reading); an answered card leaves the chip at its place in the list,
 * which now holds the next one; a jump from elsewhere (a red count, a follow-up's "Show") moves it
 * to the card the stream landed on.
 */
function useChipPosition(cards: readonly AssistantCard[]) {
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
    // Only a new jump moves the chip; the list changing under it does not.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jumped]);

  let index = cards.findIndex((c) => c.id === currentId);
  if (index < 0) index = Math.min(lastIndex.current, cards.length - 1);
  lastIndex.current = Math.max(index, 0);
  return { index, setCurrentId };
}

function WaitingChip({ cards, elsewhere }: { cards: readonly AssistantCard[]; elsewhere: number }) {
  const { index, setCurrentId } = useChipPosition(cards);
  const current = index >= 0 ? cards[index]! : null;
  const go = (card: AssistantCard) => { setCurrentId(card.id); jumpToWaitingCard(card.id); };
  const step = (by: number) => go(cards[(index + by + cards.length) % cards.length]!);

  return (
    <div
      role="group"
      aria-label={WAITING_LABEL}
      className={CHIP}
      data-waiting-dock=""
      data-waiting-count={cards.length}
    >
      {current ? (
        <button
          type="button"
          onClick={() => go(current)}
          aria-label={`Go to "${current.title}", waiting on you`}
          className={GO}
          data-waiting-go=""
        >
          <BellRing />
          <span className="text-text">Waiting</span>
          <WaitingBadge count={cards.length} />
        </button>
      ) : (
        <span className="inline-flex items-center gap-1.5 pl-2.5 pr-1 text-[11.5px] max-md:pl-[7px] [&_svg]:size-3.5"><BellRing /></span>
      )}
      {cards.length > 1 && (
        <span className="flex shrink-0 items-center pr-0.5" data-waiting-pager="">
          <button type="button" className={STEP} onClick={() => step(-1)} aria-label="Previous waiting card">
            <ChevronLeft />
          </button>
          <span className="min-w-7 text-center text-[11px] font-medium tabular-nums text-text-2" data-waiting-position="">
            {index + 1}/{cards.length}
          </span>
          <button type="button" className={STEP} onClick={() => step(1)} aria-label="Next waiting card">
            <ChevronRight />
          </button>
        </span>
      )}
      {elsewhere > 0 && (
        <button
          type="button"
          onClick={() => setAssistantCardFilter(null)}
          aria-label={`${elsewhere} more waiting in other projects: show all projects`}
          title={`${elsewhere} more waiting in other projects`}
          className={cn(STEP, "mr-0.5 w-auto px-1.5 text-[11px] font-semibold max-md:w-auto")}
          data-waiting-elsewhere=""
        >
          +{elsewhere}
        </button>
      )}
    </div>
  );
}

export function AssistantWaitingChip() {
  const all = useOpenCards();
  const filter = useAssistantCardsStore((s) => s.filter);
  if (!all || all.length === 0) return null;
  const ordered = orderWaitingCards(all);
  const shown = filter ? ordered.filter((c) => c.projectName === filter) : ordered;
  // A filter change is a different list, not new cards arriving.
  return <WaitingChip key={filter ?? "*"} cards={shown} elsewhere={ordered.length - shown.length} />;
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
  const scope = useMemo(() => (filter ? (c: AssistantCard) => c.projectName === filter : () => true), [filter]);
  if (!all?.length) return null;
  const ordered = orderWaitingCards(all);
  const shown = filter ? ordered.filter((c) => c.projectName === filter) : ordered;
  if (!shown.length) return null;
  return (
    <section aria-label={WAITING_LABEL} className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 pb-4" data-waiting-list="">
      <h3 className="text-[13px] font-semibold text-text-primary">{WAITING_LABEL} · {shown.length}</h3>
      {/* Decisions are answered together, in the set; every other waiting card is drawn whole. */}
      {shown.filter((card) => !isDecisionCard(card)).map((card) => <WaitingStreamCard key={card.id} card={card} onCard={takeCard} />)}
      {shown.some(isDecisionCard) && <DecisionSet scope={scope} />}
    </section>
  );
}
