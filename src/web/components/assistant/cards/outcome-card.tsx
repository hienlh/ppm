/**
 * Cards that only tell the user something: a manager's done or failed report (or a failure PPM
 * saw itself, which carries no manager's provenance line), and the Assistant pausing its own
 * messages. The morning digest has its own card (`digest-card.tsx`).
 */
import { CircleCheckIcon, ExternalLink, Pause, X, XCircle } from "@/lib/icons";
import { dismissAssistantCard } from "@/lib/assistant-cards-api";
import type { AssistantCard } from "../../../../shared/assistant-cards";
import { CardButton, CardShell } from "./card-shell";
import { openManagerChat, useCardAction } from "./use-card-action";

type Props = { card: AssistantCard; onCard?: (card: AssistantCard) => void };

export function OutcomeCard({ card, onCard }: Props) {
  const { busy, error, run } = useCardAction(onCard);
  const failed = card.kind === "failed";
  return (
    <CardShell
      card={card}
      look={failed ? { label: "Failed", Icon: XCircle, tone: "fail" } : { label: "Done", Icon: CircleCheckIcon, tone: "ok" }}
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
      {card.payload.detected && <p className="text-xs text-text-subtle">Seen by PPM: the manager chat has not reported on it.</p>}
    </CardShell>
  );
}

export function BudgetCard({ card, onCard }: Props) {
  const { busy, error, run } = useCardAction(onCard);
  return (
    <CardShell
      card={card}
      look={{ label: "Assistant paused messaging", Icon: Pause, tone: "need" }}
      error={error}
      actions={(
        <CardButton variant="ghost" disabled={busy} onClick={() => void run(() => dismissAssistantCard(card.id))}>
          <X className="size-3.5" />Dismiss
        </CardButton>
      )}
    >
      <p className="text-text-secondary">{card.body || card.title}</p>
    </CardShell>
  );
}
