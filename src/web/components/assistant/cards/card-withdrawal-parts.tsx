/**
 * The parts of a card that card withdrawal adds:
 *
 * - under a card its author withdrew: the card that replaced it ("Show new card", while that one
 *   waits) and Restore, which brings the withdrawn card back to "Waiting on you";
 * - on the card that replaced others: one line naming what it replaces;
 * - on a waiting card whose task was closed: a line saying so (Dismiss is the card's own button).
 *
 * The buttons are the cards' own `CardButton`s (28px, 26px on a phone: design guidelines rule 3).
 */
import { ArrowRight, RotateCcw } from "@/lib/icons";
import { restoreAssistantCard } from "@/lib/assistant-cards-api";
import { focusWaitingCards, useOpenCards } from "@/stores/assistant-open-cards-store";
import { cardWithdrawal, type AssistantCard } from "../../../../shared/assistant-cards";
import { CardButton } from "./card-shell";
import { useCardAction } from "./use-card-action";

/** Show new card and Restore, under a withdrawn card's status line. */
export function WithdrawnCardActions({ card }: { card: AssistantCard }) {
  const withdrawn = cardWithdrawal(card);
  const open = useOpenCards(false);
  const { busy, error, run } = useCardAction();
  if (!withdrawn) return null;
  const next = withdrawn.supersededBy;
  const nextWaits = !!next && (open ?? []).some((c) => c.id === next.id);
  return (
    <div className="border-t border-border px-3.5 py-2" data-card-withdrawn-actions="">
      {error && <p className="pb-2 text-xs text-error" role="alert">{error}</p>}
      <div className="flex flex-row-reverse gap-2 *:flex-1 md:flex-row md:*:flex-none">
        {nextWaits && (
          <CardButton onClick={() => focusWaitingCards(card.projectName, next.id)} title={`Go to "${next.title}"`}>
            <ArrowRight className="size-3.5" />Show new card
          </CardButton>
        )}
        <CardButton variant="ghost" secondary disabled={busy} onClick={() => void run(() => restoreAssistantCard(card.id))}
          title="Bring this card back to Waiting on you">
          <RotateCcw className="size-3.5" />Restore
        </CardButton>
      </div>
    </div>
  );
}

/** "Replaces “…”" on a card that took the place of earlier ones. */
export function CardReplacesLine({ card }: { card: AssistantCard }) {
  const replaced = card.payload.supersedes ?? [];
  if (replaced.length === 0) return null;
  const names = replaced.map((c) => `“${c.title}”`).join(", ");
  return (
    <p className="text-xs text-text-subtle" data-card-replaces="">
      Replaces {replaced.length === 1 ? "an earlier card" : `${replaced.length} earlier cards`}: <span className="text-text-secondary">{names}</span>
    </p>
  );
}

/** "Task ppm/76 was closed (done)" on a card that still waits. */
export function CardTaskClosedLine({ card }: { card: AssistantCard }) {
  const closed = card.payload.taskClosed;
  const task = card.payload.aboutTask;
  if (card.status !== "open" || !closed || !task) return null;
  return (
    <p className="rounded-md bg-panel-2 px-2.5 py-1.5 text-xs text-text-secondary" data-card-task-closed="">
      Task {task.ref} was closed{closed.closedAs ? ` (${closed.closedAs})` : ""}. If this no longer needs you, dismiss it.
    </p>
  );
}
