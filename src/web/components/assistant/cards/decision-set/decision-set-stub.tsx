/**
 * Where a waiting decision used to be drawn in the Assistant's stream: one line naming it, kept at
 * its own place so the conversation still reads in order. The card itself is answered in the set
 * after the last message; a press here takes the user there, on this card's tab.
 */
import { BellRing, TriangleAlert } from "@/lib/icons";
import { cn } from "@/lib/utils";
import { jumpToWaitingCard } from "@/stores/assistant-waiting-jump-store";
import type { AssistantCard } from "../../../../../shared/assistant-cards";
import { cardTime } from "../card-shell";

export function DecisionSetStub({ card }: { card: AssistantCard }) {
  const urgent = card.kind === "urgent";
  const Icon = urgent ? TriangleAlert : BellRing;
  return (
    <button
      type="button"
      onClick={() => jumpToWaitingCard(card.id)}
      className="flex min-h-11 w-full min-w-0 items-center gap-2.5 rounded-xl border border-dashed border-warning/40 bg-warning/5 px-3 py-1.5 text-left can-hover:hover:bg-warning/10"
      data-decision-stub={card.id}
    >
      <span aria-hidden className={cn("grid size-6 shrink-0 place-items-center rounded-full [&_svg]:size-3.5", urgent ? "bg-error/10 text-error-ink" : "bg-warning/10 text-warning-ink")}>
        <Icon />
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-[13px] font-medium text-text-primary">{card.title}</span>
        <span className="truncate text-xs text-text-secondary">
          {card.projectName ? `${card.projectName} · ` : ""}{urgent ? "urgent · " : ""}waiting in the set below
        </span>
      </span>
      <time className="shrink-0 text-[11px] tabular-nums text-text-subtle">{cardTime(card.createdAt)}</time>
      <span className="shrink-0 text-[11.5px] font-medium text-warning-ink max-md:hidden">Answer ↓</span>
    </button>
  );
}
