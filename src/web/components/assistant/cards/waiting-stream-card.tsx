/**
 * A card that waits on the user, at its own place in the Assistant's stream: drawn once and whole,
 * its body unclipped and its one row of buttons at its end. The dock above the composer only names
 * it and jumps here; a jump outlines it for a moment so the eye finds it. The outline is drawn just
 * inside the card's edge, over it, so nothing around the card has to make room for it.
 */
import { cn } from "@/lib/utils";
import { useWaitingJumpStore } from "@/stores/assistant-waiting-jump-store";
import type { AssistantCard as Card } from "../../../../shared/assistant-cards";
import { AssistantCard } from "./assistant-card";

export function WaitingStreamCard({ card, onCard }: { card: Card; onCard?: (card: Card) => void }) {
  const lit = useWaitingJumpStore((s) => s.lit === card.id);
  return (
    <div
      // Always outlined, in a transparent colour until lit, so the outline fades in and out.
      className={cn("rounded-xl outline-2 -outline-offset-2 transition-[outline-color] duration-300", lit ? "outline-error" : "outline-transparent")}
      data-waiting-card={card.id}
      data-highlighted={lit ? "" : undefined}
    >
      <AssistantCard card={card} onCard={onCard} />
    </div>
  );
}
