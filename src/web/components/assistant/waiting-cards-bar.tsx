/**
 * "Waiting on you": the cards that still wait on the user, pinned where the user cannot miss them
 * — above the Assistant's stream, and above a manager chat's composer for that chat's own cards.
 * The stream places a card by the time it was made, so an open one drifts up among later messages;
 * this bar keeps it in view until it is answered.
 *
 * One card shows at a time, whole and with its own buttons, and ‹ › step to the next. A new card
 * opens the bar on itself; a press on a red count (`focus`) opens it on that project's first card.
 * Either way the card it lands on is outlined for a moment, so the eye finds it. The header is one
 * 44 px row on a phone and folds the bar to that row; folded, it still names the current card.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { BellRing, ChevronDown, ChevronLeft, ChevronRight } from "@/lib/icons";
import { cn } from "@/lib/utils";
import type { AssistantCard as Card } from "../../../shared/assistant-cards";
import { AssistantCard } from "./cards/assistant-card";
import { CardStickyActionsContext } from "./cards/card-shell";
import { WaitingBadge } from "./manager-chip";

/** How long the card the bar lands on stays outlined. */
export const WAITING_HIGHLIGHT_MS = 1800;

export interface WaitingBarFocus {
  /** The card to show; null shows the first. */
  cardId: string | null;
  nonce: number;
}

interface Props {
  /** In the order the user steps through them. */
  cards: readonly Card[];
  label: string;
  focus?: WaitingBarFocus | null;
  onCard?: (card: Card) => void;
  /** Under the shown card: an inline reply bar, a "more in other projects" line. */
  children?: (card: Card) => ReactNode;
  /** A line under the header that stays even when the bar is folded. */
  note?: ReactNode;
  /** How tall the card area may grow before it scrolls; the host knows how much room it has. */
  slotHeight?: string;
}

const NAV = "grid size-11 shrink-0 place-items-center rounded-full text-text-secondary can-hover:hover:bg-surface-elevated can-hover:hover:text-text-primary md:size-7";

/** In the Assistant: a share of its own body (a size container), and never past half the screen. */
export const ASSISTANT_SLOT_HEIGHT = "max-h-[min(42dvh,46cqh)] md:max-h-[min(50dvh,46cqh)]";

export function WaitingCardsBar({ cards, label, focus, onCard, children, note, slotHeight = ASSISTANT_SLOT_HEIGHT }: Props) {
  const [currentId, setCurrentId] = useState<string | null>(cards[0]?.id ?? null);
  const [open, setOpen] = useState(true);
  const [flash, setFlash] = useState(0);
  const lastIndex = useRef(0);
  const known = useRef<Set<string> | null>(null);
  const root = useRef<HTMLElement>(null);

  let index = cards.findIndex((c) => c.id === currentId);
  // The shown card was answered: stay at its place in the list, which now holds the next one.
  if (index < 0) index = Math.min(lastIndex.current, cards.length - 1);
  lastIndex.current = Math.max(index, 0);
  const current = index >= 0 ? cards[index]! : null;

  const land = (id: string | null) => {
    setCurrentId(id);
    setOpen(true);
    setFlash((n) => n + 1);
  };

  // A card that was not there before: open the bar on it.
  useEffect(() => {
    const ids = new Set(cards.map((c) => c.id));
    const before = known.current;
    known.current = ids;
    if (!before) return;
    const fresh = [...cards].reverse().find((c) => !before.has(c.id));
    if (fresh) land(fresh.id);
  }, [cards]);

  // A press on a red count.
  useEffect(() => {
    if (!focus) return;
    land(focus.cardId ?? cards[0]?.id ?? null);
    root.current?.scrollIntoView?.({ block: "nearest" });
    // Only a new press moves the bar; the list changing under it does not.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus?.nonce]);

  const [lit, setLit] = useState(false);
  useEffect(() => {
    if (!flash) return;
    setLit(true);
    const t = setTimeout(() => setLit(false), WAITING_HIGHLIGHT_MS);
    return () => clearTimeout(t);
  }, [flash]);

  if (!current) return null;
  const step = (by: number) => land(cards[(index + by + cards.length) % cards.length]!.id);

  return (
    <section
      ref={root}
      aria-label={label}
      className="shrink-0 border-b border-border bg-panel-2/60"
      data-waiting-cards=""
      data-waiting-count={cards.length}
    >
      <div className="flex items-center gap-1 pl-3 pr-1.5">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          className="flex min-h-11 min-w-0 flex-1 items-center gap-2 text-left md:min-h-10"
          data-waiting-toggle=""
        >
          <span aria-hidden className="grid size-6 shrink-0 place-items-center rounded-full bg-error/10 text-error">
            <BellRing className="size-3.5" />
          </span>
          <span className="shrink-0 text-[13px] font-semibold text-text-primary">{label}</span>
          <WaitingBadge count={cards.length} />
          {!open && (
            <span className="min-w-0 truncate text-xs text-text-secondary" data-waiting-summary="">
              {current.projectName ? `${current.projectName} · ` : ""}{current.title}
            </span>
          )}
        </button>
        {cards.length > 1 && (
          <div className="flex shrink-0 items-center md:rounded-full md:border md:border-border md:bg-surface" data-waiting-pager="">
            <button type="button" className={NAV} onClick={() => step(-1)} aria-label="Previous waiting card">
              <ChevronLeft className="size-4" />
            </button>
            <span className="min-w-10 text-center text-[11px] font-medium tabular-nums text-text-secondary" data-waiting-position="">
              {index + 1}/{cards.length}
            </span>
            <button type="button" className={NAV} onClick={() => step(1)} aria-label="Next waiting card">
              <ChevronRight className="size-4" />
            </button>
          </div>
        )}
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-label={open ? "Fold the waiting cards" : "Show the waiting cards"}
          className={NAV}
        >
          <ChevronDown className={cn("size-4 transition-transform", open && "rotate-180")} />
        </button>
      </div>
      {note}
      {open && (
        // The card scrolls here and keeps its buttons at the bottom; a phone keeps most of the
        // screen for the conversation and the keyboard.
        <div className={cn("overflow-y-auto px-3 pb-3", slotHeight)} data-waiting-slot="">
          <div
            key={current.id}
            className={cn("rounded-xl transition-shadow duration-300", lit && "ring-2 ring-error ring-offset-2 ring-offset-panel-2")}
            data-waiting-card={current.id}
            data-highlighted={lit ? "" : undefined}
          >
            <CardStickyActionsContext.Provider value>
              <AssistantCard card={current} onCard={onCard} />
            </CardStickyActionsContext.Provider>
          </div>
          {children?.(current)}
        </div>
      )}
    </section>
  );
}
