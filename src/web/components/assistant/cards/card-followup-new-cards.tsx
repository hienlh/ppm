/**
 * Under a card the user replied to, when the manager answered with a new card: only the new card
 * is named, with "Show" to scroll the stream to it (drawn whole at its own place) while it waits. The turn's text is not
 * shown — it repeated what the card says, and the two read as the same answer twice.
 */
import { ArrowRight } from "@/lib/icons";
import { focusWaitingCards, useOpenCards } from "@/stores/assistant-open-cards-store";
import type { AssistantCard } from "../../../../shared/assistant-cards";
import { cardTime } from "./card-shell";

export const NEW_CARD_FOLLOWUP_NOTE = "The manager answered your reply with a new card";

export function FollowUpNewCards({ card, newCards, at }: {
  card: AssistantCard;
  newCards: Array<{ id: string; title: string }>;
  at: number;
}) {
  // Read, never loaded from here: the stream and its "Waiting on you" dock keep the list.
  const open = useOpenCards(false);
  const waiting = new Set((open ?? []).map((c) => c.id));
  return (
    <div className="mx-3.5 mb-3 rounded-md border border-border bg-panel-2 px-2.5 py-2 text-sm" data-card-followup="" data-card-followup-new-cards="">
      <p className="pb-1 text-[11px] font-medium text-text-subtle">
        {NEW_CARD_FOLLOWUP_NOTE} · {cardTime(at)}
      </p>
      <ul className="space-y-0.5">
        {newCards.map((c) => (
          <li key={c.id} className="flex min-w-0 items-center gap-1.5" data-card-followup-new-card={c.id}>
            <ArrowRight className="size-3.5 shrink-0 text-text-subtle" />
            <span className="min-w-0 truncate font-medium text-text-primary">{c.title}</span>
            {waiting.has(c.id) && (
              <button
                type="button"
                onClick={() => focusWaitingCards(card.projectName, c.id)}
                className="ml-auto inline-flex min-h-11 shrink-0 items-center px-1 text-xs font-medium text-primary md:min-h-7"
                aria-label={`Go to "${c.title}", waiting on you`}
              >
                Show
              </button>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
