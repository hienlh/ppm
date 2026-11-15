/**
 * A decision the user no longer has to make, in the Assistant's stream: one line naming the card,
 * its project, how it ended ("OK given in PPM", "Chose "Ship tonight"", "You replied", "Dismissed")
 * and when, so a chat full of answered cards still reads as a conversation. A press opens the card
 * whole again, read-only (it has no buttons any more, only its status line), and a second press
 * folds it. Opening scrolls the stream just enough to show the card's last line above the footer
 * (never so far that the line itself leaves the top). Whether a card is open is kept by id outside
 * the component: the stream re-places a card among new messages as they arrive, which mounts it
 * afresh.
 */
import { useEffect, useRef } from "react";
import { Check, ChevronDown, MessageCircle, X } from "@/lib/icons";
import { create } from "zustand";
import { revealInScrollList } from "@/lib/reveal-in-scroll-list";
import { cn } from "@/lib/utils";
import { WAITING_CARD_KINDS, type AssistantCard as Card } from "../../../../shared/assistant-cards";
import { AssistantCard } from "./assistant-card";
import { cardStatusLine, cardTime } from "./card-shell";

/** A card that asked the user for something and no longer waits: folded in the stream. */
export function isAnsweredDecision(card: Card): boolean {
  return WAITING_CARD_KINDS.includes(card.kind) && card.status !== "open";
}

const useUnfolded = create<{ ids: ReadonlySet<string> }>(() => ({ ids: new Set() }));

function toggle(id: string): void {
  useUnfolded.setState((s) => {
    const ids = new Set(s.ids);
    if (ids.has(id)) ids.delete(id); else ids.add(id);
    return { ids };
  });
}

/** How the card ended, without the time (the line shows the time on its own). */
export function answerSummary(card: Card): string {
  const line = cardStatusLine(card) ?? "Answered";
  const at = card.answer ? ` · ${cardTime(card.answer.at)}` : "";
  return at && line.endsWith(at) ? line.slice(0, -at.length) : line;
}

export function AnsweredCardFold({ card }: { card: Card }) {
  const open = useUnfolded((s) => s.ids.has(card.id));
  const box = useRef<HTMLDivElement>(null);
  const pressed = useRef(false);
  // Only an open the user just asked for scrolls; a card that mounts open (re-placed) stays put.
  useEffect(() => {
    if (!open || !pressed.current || !box.current) return;
    pressed.current = false;
    revealInScrollList(box.current, "reveal");
  }, [open]);
  const panel = `answered-card-${card.id}`;
  // Set aside (dismissed, or it stopped waiting by itself) reads differently from answered.
  const setAside = card.status === "dismissed" || card.status === "gone";
  const Mark = setAside ? X : Check;
  return (
    <div ref={box} className="w-full space-y-2" data-answered-card={card.id} data-answered-open={open ? "" : undefined}>
      <button
        type="button"
        onClick={() => { pressed.current = true; toggle(card.id); }}
        aria-expanded={open}
        aria-controls={panel}
        className="flex min-h-11 w-full min-w-0 items-center gap-2.5 rounded-xl border border-border bg-surface/60 px-3 py-1.5 text-left can-hover:hover:bg-surface-elevated"
        data-answered-toggle=""
      >
        <span aria-hidden className={cn("grid size-6 shrink-0 place-items-center rounded-full", setAside ? "bg-panel-2 text-text-secondary" : "bg-success/10 text-success")}>
          <Mark className="size-3.5" />
        </span>
        {/* Two lines: the card, then how it ended. Narrow, each truncates on its own. */}
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="min-w-0 truncate text-[13px] font-medium text-text-primary" data-answered-title="">{card.title}</span>
            {card.projectName && (
              <span className="shrink-0 rounded-full border border-border bg-panel-2 px-1.5 text-[11px] font-medium text-text-secondary">{card.projectName}</span>
            )}
          </span>
          <span className="flex min-w-0 items-center gap-1 text-xs text-text-secondary">
            <span className="min-w-0 truncate" data-answered-summary="">{answerSummary(card)}</span>
            {card.followUp && (
              <span className="inline-flex shrink-0 items-center gap-0.5 text-primary" data-answered-followup="">
                <MessageCircle className="size-3" />manager answered
              </span>
            )}
          </span>
        </span>
        <time className="shrink-0 text-[11px] tabular-nums text-text-subtle">{cardTime(card.answer?.at ?? card.updatedAt)}</time>
        <ChevronDown className={cn("size-4 shrink-0 text-text-subtle transition-transform", open && "rotate-180")} />
      </button>
      {open && (
        <div id={panel}>
          <AssistantCard card={card} />
        </div>
      )}
    </div>
  );
}
