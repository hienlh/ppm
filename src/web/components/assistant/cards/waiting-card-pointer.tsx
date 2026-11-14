/**
 * A card that is waiting, at its place in the Assistant's stream. The card itself — its text and
 * its buttons — is in "Waiting on you" above the stream, so here it is only named: kind, project,
 * time, title, and "Show", which opens the bar on it. Drawing it whole in both places put a second
 * set of OK / Reply right under the first, which read as a glitch. Once answered, the stream draws
 * the card in full again, with how it ended.
 */
import type { ComponentType } from "react";
import { ArrowUp, BellRing, CircleHelp, Pause, ScrollText, ShieldAlert, TriangleAlert } from "@/lib/icons";
import { focusWaitingCards } from "@/stores/assistant-open-cards-store";
import type { AssistantCard, AssistantCardKind } from "../../../../shared/assistant-cards";
import { CardShell, type CardLook } from "./card-shell";

const LOOK: Partial<Record<AssistantCardKind, { label: string; Icon: ComponentType<{ className?: string }> }>> = {
  needs_decision: { label: "Needs your decision", Icon: BellRing },
  urgent: { label: "Urgent", Icon: TriangleAlert },
  approval: { label: "Needs your approval", Icon: ShieldAlert },
  question: { label: "Needs your answer", Icon: CircleHelp },
  rules_change: { label: "Rules change waiting", Icon: ScrollText },
  budget: { label: "Assistant paused messaging", Icon: Pause },
};

export const POINTER_NOTE = "Waiting on you, in the bar above";

export function WaitingCardPointer({ card }: { card: AssistantCard }) {
  const look: CardLook = { ...(LOOK[card.kind] ?? { label: "Waiting on you", Icon: BellRing }), tone: "need" };
  return (
    <CardShell card={card} look={look} pointer>
      <h4 className="line-clamp-2 text-[15px] font-semibold leading-snug text-text-primary" data-card-title="">{card.title}</h4>
      <p className="flex flex-wrap items-center gap-x-1.5 text-xs text-text-secondary" data-card-pointer-note="">
        <ArrowUp className="size-3.5 shrink-0" />
        {POINTER_NOTE}
        <span aria-hidden>·</span>
        <button
          type="button"
          onClick={() => focusWaitingCards(card.projectName, card.id)}
          className="inline-flex min-h-11 items-center font-medium text-primary md:min-h-7"
          aria-label={`Show "${card.title}" in Waiting on you`}
        >
          Show
        </button>
      </p>
    </CardShell>
  );
}
