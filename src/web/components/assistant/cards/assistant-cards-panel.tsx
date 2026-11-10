/**
 * The cards above the Assistant's chat: what needs the user, newest first, with the count of those
 * still waiting. Folded to its header when nothing waits, so the chat keeps the room. A card waits
 * on no model turn: it is here the moment PPM stores it.
 */
import { useEffect, useState } from "react";
import { BellRing, ChevronDown } from "@/lib/icons";
import { cn } from "@/lib/utils";
import { useAssistantCards } from "@/hooks/use-assistant-cards";
import { AssistantCard } from "./assistant-card";

export function AssistantCardsPanel() {
  const { cards, waiting, error, apply } = useAssistantCards();
  const [open, setOpen] = useState(false);
  // Opens by itself when something starts waiting; the user may fold it again.
  useEffect(() => { if (waiting > 0) setOpen(true); }, [waiting]);
  if (cards === null || (cards.length === 0 && !error)) return null;

  return (
    <section className="flex max-h-[60%] min-h-0 shrink-0 flex-col border-b border-border md:max-h-[45%]" aria-label="Assistant cards" data-assistant-cards="">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex min-h-11 shrink-0 items-center gap-2 px-3 text-left text-sm md:min-h-8 md:text-xs"
      >
        <BellRing className="size-4 shrink-0 text-text-secondary md:size-3.5" />
        <span className="font-medium text-text-primary">Cards</span>
        {waiting > 0 && (
          <span className="rounded-full bg-error px-1.5 text-[11px] font-semibold leading-4 text-white" data-waiting-count="">{waiting} waiting</span>
        )}
        <ChevronDown className={cn("ml-auto size-4 shrink-0 text-text-subtle transition-transform", open && "rotate-180")} />
      </button>
      {open && (
        <div className="min-h-0 flex-1 space-y-2 overflow-y-auto px-3 pb-3">
          {error && <p className="text-xs text-error">{error}</p>}
          {cards.map((card) => <AssistantCard key={card.id} card={card} onCard={apply} />)}
        </div>
      )}
    </section>
  );
}
