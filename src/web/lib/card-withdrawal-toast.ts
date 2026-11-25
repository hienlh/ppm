/**
 * One toast when a card this tab showed as waiting is withdrawn by its author (a manager chat, or
 * the PPM Assistant): what went, why, and Undo, which brings it back. Said by every tab that was
 * showing it, once per card; nothing is said for a card the user dismissed or answered.
 */
import { toast } from "sonner";
import { restoreAssistantCard } from "@/lib/assistant-cards-api";
import { cardWithdrawal, type AssistantCard } from "../../shared/assistant-cards";

const said = new Set<string>();

/** The toast's words for a withdrawn card; null for any other card. */
export function withdrawalToastText(card: AssistantCard): { title: string; description: string } | null {
  const withdrawn = cardWithdrawal(card);
  if (!withdrawn) return null;
  const who = card.answer?.by === "assistant" ? "The Assistant" : `The ${card.projectName ?? "project"} manager`;
  return withdrawn.supersededBy
    ? { title: `${who} replaced a card`, description: `“${card.title}” → “${withdrawn.supersededBy.title}”` }
    : { title: `${who} withdrew a card`, description: `“${card.title}”: ${withdrawn.reason}` };
}

export function announceWithdrawal(card: AssistantCard): void {
  const text = withdrawalToastText(card);
  if (!text || said.has(card.id)) return;
  said.add(card.id);
  toast(text.title, {
    description: text.description,
    action: { label: "Undo", onClick: () => void restoreAssistantCard(card.id).catch(() => toast.error("Could not bring the card back")) },
  });
}
