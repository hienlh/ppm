/**
 * Cards that only tell the user something: a manager's done or failed report (or a failure PPM
 * saw itself, which carries no manager's provenance line), and the Assistant pausing its own
 * messages. The morning digest has its own card (`digest-card.tsx`).
 */
import { CircleCheckIcon, ExternalLink, Pause, X, XCircle } from "@/lib/icons";
import { CardImages } from "./card-images";
import { dismissAssistantCard } from "@/lib/assistant-cards-api";
import type { AssistantCard } from "../../../../shared/assistant-cards";
import { CardButton, CardShell, CardText } from "./card-shell";
import { openCardManagerChat, useCardAction } from "./use-card-action";
import { CardTaskChanges } from "./card-task-items";

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
        <CardButton title="Open manager chat" onClick={() => openCardManagerChat(card)} disabled={!card.sessionId}>
          <ExternalLink className="size-3.5" />Open chat
        </CardButton>
      )}
      secondary={(
        <CardButton variant="ghost" secondary disabled={busy} onClick={() => void run(() => dismissAssistantCard(card.id))}>
          <X className="size-3.5" />Dismiss
        </CardButton>
      )}
    >
      <h4 className="text-[15px] font-semibold leading-snug text-text-primary" data-card-title="">{card.title}</h4>
      {/* A report only tells: long text folds even while the card is open. */}
      {/* A task-changes card lists its changes as rows with Undo; the body repeats them as text for Telegram. */}
      {card.body && !card.payload.taskChanges?.length && <CardText text={card.body} fold projectName={card.projectName} />}
      {!!card.payload.taskChanges?.length && <p className="text-xs text-text-subtle">Made in a turn PPM started, not one you wrote in.</p>}
      <CardImages images={card.payload.images} />
      {card.payload.taskChanges && <CardTaskChanges changes={card.payload.taskChanges} />}
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
