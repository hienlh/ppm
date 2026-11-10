/**
 * A manager asking the user to decide: needs-decision and urgent reports. The draft, when there is
 * one, is shown whole and verbatim, with hidden characters made visible. Sending it ("OK, send")
 * and editing it arrive with the reply path; here the card opens the manager chat or is dismissed.
 */
import { BellRing, ExternalLink, TriangleAlert, X } from "@/lib/icons";
import { dismissAssistantCard } from "@/lib/assistant-cards-api";
import { escapeHiddenCharacters } from "../../../../shared/reveal-hidden-characters";
import type { AssistantCard } from "../../../../shared/assistant-cards";
import { CardButton, CardShell } from "./card-shell";
import { openManagerChat, useCardAction } from "./use-card-action";

export function DecisionCard({ card, onCard }: { card: AssistantCard; onCard?: (card: AssistantCard) => void }) {
  const { busy, error, run } = useCardAction(onCard);
  const urgent = card.kind === "urgent";
  const draft = card.payload.draft;
  return (
    <CardShell
      card={card}
      look={{ label: urgent ? "Urgent" : "Needs your decision", Icon: urgent ? TriangleAlert : BellRing, tone: "need" }}
      error={error}
      actions={(
        <>
          <CardButton onClick={() => openManagerChat(card)} disabled={!card.sessionId}>
            <ExternalLink className="size-3.5" />Open manager chat
          </CardButton>
          <CardButton variant="ghost" disabled={busy} onClick={() => void run(() => dismissAssistantCard(card.id))}>
            <X className="size-3.5" />Dismiss
          </CardButton>
        </>
      )}
    >
      <h4 className="text-sm font-semibold">{card.title}</h4>
      {card.body && <p className="whitespace-pre-wrap break-words text-text-secondary">{card.body}</p>}
      {draft && (
        <div className="rounded-lg border border-dashed border-border bg-panel-2 px-3 py-2" data-card-draft="">
          <span className="block text-[11px] text-text-subtle">To: {escapeHiddenCharacters(draft.to)}</span>
          <p className="whitespace-pre-wrap break-words font-mono text-xs">{escapeHiddenCharacters(draft.text)}</p>
        </div>
      )}
      {card.payload.urgentCapped && (
        <p className="text-xs text-text-subtle">Held for the morning: this manager already raised its urgent reports tonight.</p>
      )}
    </CardShell>
  );
}
