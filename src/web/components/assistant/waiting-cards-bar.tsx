/**
 * "Waiting on you": the cards that still wait on the user, pinned where the user cannot miss them
 * — above the Assistant's stream, and above a manager chat's composer for that chat's own cards.
 * The stream places a card by the time it was made, so an open one drifts up among later messages;
 * this bar keeps it in view until it is answered.
 *
 * One card shows at a time, whole and with its own buttons, and ‹ › step to the next. A new card
 * moves the bar to itself; a press on a red count (`focus`) opens it on that project's first card.
 * Either way the card it lands on is outlined for a moment, so the eye finds it.
 *
 * A desktop opens the card under the header, in a box that scrolls. A phone has no room for that:
 * half a screen of card over half a screen of chat read as broken. There the bar is one 44 px row
 * naming the card, and opening it shows the card full screen in a sheet with the pager and a
 * close button, the chat hidden behind it. A new card does not take the phone's screen by itself.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { BellRing, ChevronDown, ChevronLeft, ChevronRight, ChevronUp, X } from "@/lib/icons";
import { cn } from "@/lib/utils";
import { useIsMobile } from "@/hooks/use-is-mobile";
import { BottomSheet } from "@/components/ui/mobile-bottom-sheet";
import { useCardReplyStore } from "@/stores/assistant-card-reply-store";
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
  /** How tall the card area may grow before it scrolls on a desktop; the host knows its room. */
  slotHeight?: string;
}

const NAV = "grid size-11 shrink-0 place-items-center rounded-full text-text-secondary can-hover:hover:bg-surface-elevated can-hover:hover:text-text-primary md:size-7";

/** In the Assistant on a desktop: a share of its own body (a size container), never past half the screen. */
export const ASSISTANT_SLOT_HEIGHT = "max-h-[min(50dvh,46cqh)]";

function Pager({ index, count, step }: { index: number; count: number; step: (by: number) => void }) {
  if (count < 2) return null;
  return (
    <div className="flex shrink-0 items-center md:rounded-full md:border md:border-border md:bg-surface" data-waiting-pager="">
      <button type="button" className={NAV} onClick={() => step(-1)} aria-label="Previous waiting card">
        <ChevronLeft className="size-4" />
      </button>
      <span className="min-w-10 text-center text-[11px] font-medium tabular-nums text-text-secondary" data-waiting-position="">
        {index + 1}/{count}
      </span>
      <button type="button" className={NAV} onClick={() => step(1)} aria-label="Next waiting card">
        <ChevronRight className="size-4" />
      </button>
    </div>
  );
}

function Title({ label, count }: { label: string; count: number }) {
  return (
    <>
      <span aria-hidden className="grid size-6 shrink-0 place-items-center rounded-full bg-error/10 text-error">
        <BellRing className="size-3.5" />
      </span>
      <span className="shrink-0 text-[13px] font-semibold text-text-primary">{label}</span>
      <WaitingBadge count={count} />
    </>
  );
}

export function WaitingCardsBar({ cards, label, focus, onCard, children, note, slotHeight = ASSISTANT_SLOT_HEIGHT }: Props) {
  const phone = useIsMobile();
  const [currentId, setCurrentId] = useState<string | null>(cards[0]?.id ?? null);
  // Unfolded under the header on a desktop; on a phone, whether the full-screen sheet is up.
  const [open, setOpen] = useState(!phone);
  const [flash, setFlash] = useState(0);
  const lastIndex = useRef(0);
  const known = useRef<Set<string> | null>(null);
  const root = useRef<HTMLElement>(null);

  let index = cards.findIndex((c) => c.id === currentId);
  // The shown card was answered: stay at its place in the list, which now holds the next one.
  if (index < 0) index = Math.min(lastIndex.current, cards.length - 1);
  lastIndex.current = Math.max(index, 0);
  const current = index >= 0 ? cards[index]! : null;

  const land = (id: string | null, opening: boolean) => {
    setCurrentId(id);
    if (opening) setOpen(true);
    setFlash((n) => n + 1);
  };

  // A card that was not there before: the bar moves to it. A desktop unfolds; a phone's screen
  // is not taken over by a card nobody asked to see, so there only the row names it.
  useEffect(() => {
    const ids = new Set(cards.map((c) => c.id));
    const before = known.current;
    known.current = ids;
    if (!before) return;
    const fresh = [...cards].reverse().find((c) => !before.has(c.id));
    if (fresh) land(fresh.id, !phone);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cards]);

  // A press on a red count, or on "Show" beside the card's place in the stream.
  useEffect(() => {
    if (!focus) return;
    land(focus.cardId ?? cards[0]?.id ?? null, true);
    root.current?.scrollIntoView?.({ block: "nearest" });
    // Only a new press moves the bar; the list changing under it does not.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus?.nonce]);

  // Answering a card in the Assistant's own composer: on a phone the sheet steps aside for it.
  const replying = useCardReplyStore((s) => s.target !== null);
  useEffect(() => { if (phone && replying) setOpen(false); }, [phone, replying]);

  const [lit, setLit] = useState(false);
  useEffect(() => {
    if (!flash) return;
    setLit(true);
    const t = setTimeout(() => setLit(false), WAITING_HIGHLIGHT_MS);
    return () => clearTimeout(t);
  }, [flash]);

  if (!current) return null;
  const step = (by: number) => land(cards[(index + by + cards.length) % cards.length]!.id, true);

  const card = (
    <>
      {/* The landing outline is drawn just inside the card's edge: a ring outside it is cut by
          the scroll box, and an inset one is painted under the card. */}
      <div
        key={current.id}
        className={cn("rounded-xl transition-shadow duration-300", lit && "outline-2 -outline-offset-2 outline-error")}
        data-waiting-card={current.id}
        data-highlighted={lit ? "" : undefined}
      >
        <CardStickyActionsContext.Provider value>
          <AssistantCard card={current} onCard={onCard} />
        </CardStickyActionsContext.Provider>
      </div>
      {children?.(current)}
    </>
  );

  if (phone) {
    return (
      <section
        ref={root}
        aria-label={label}
        className="shrink-0 border-b border-border bg-panel-2/60"
        data-waiting-cards=""
        data-waiting-count={cards.length}
      >
        <button
          type="button"
          onClick={() => setOpen(true)}
          aria-haspopup="dialog"
          aria-expanded={open}
          className="flex min-h-11 w-full min-w-0 items-center gap-2 pl-3 pr-1.5 text-left"
          data-waiting-toggle=""
        >
          <Title label={label} count={cards.length} />
          <span className="min-w-0 flex-1 truncate text-xs text-text-secondary" data-waiting-summary="">
            {current.projectName ? `${current.projectName} · ` : ""}{current.title}
          </span>
          <span aria-hidden className="grid size-11 shrink-0 place-items-center text-text-secondary">
            <ChevronUp className="size-4" />
          </span>
        </button>
        {note}
        <BottomSheet open={open} onClose={() => setOpen(false)} zIndex={45} className="flex h-[var(--sheet-vh)] flex-col p-0">
          <div role="dialog" aria-modal="true" aria-label={label} className="flex min-h-0 flex-1 flex-col" data-waiting-sheet="">
            <div className="flex shrink-0 items-center gap-1 border-b border-border pl-3 pr-1">
              <span className="flex min-w-0 flex-1 items-center gap-2"><Title label={label} count={cards.length} /></span>
              <Pager index={index} count={cards.length} step={step} />
              <button type="button" onClick={() => setOpen(false)} aria-label="Close the waiting cards" className={NAV}>
                <X className="size-5" />
              </button>
            </div>
            {/* The whole card scrolls here; its buttons stick to the bottom of the sheet. */}
            <div className="min-h-0 flex-1 overflow-y-auto px-3 pt-3" data-waiting-slot="">
              {card}
            </div>
          </div>
        </BottomSheet>
      </section>
    );
  }

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
          <Title label={label} count={cards.length} />
          {!open && (
            <span className="min-w-0 truncate text-xs text-text-secondary" data-waiting-summary="">
              {current.projectName ? `${current.projectName} · ` : ""}{current.title}
            </span>
          )}
        </button>
        <Pager index={index} count={cards.length} step={step} />
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
        // The gap under the card sits outside the scrolling box: inside it, text would show
        // through under the button row that sticks to the box's bottom.
        <div className="pb-3">
          <div className={cn("overflow-y-auto px-3", slotHeight)} data-waiting-slot="">
            {card}
          </div>
        </div>
      )}
    </section>
  );
}
