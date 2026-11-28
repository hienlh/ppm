/**
 * A manager asking the user to decide: needs-decision and urgent reports. The draft, when there is
 * one, is shown whole and verbatim, with hidden characters made visible.
 *
 * "OK, send" (or "OK" with no draft) is offered only when the server says the whole decision is on
 * the card and nothing in it was hidden; it names the exact draft by its hash. A card that offers
 * choices gets one button per choice in place of OK, under the same rule. "Reply" opens the
 * reply bar under the chat (in a manager chat, under the card), where the user's own words go to the manager chat word for word.
 */
import { BellRing, Check, ExternalLink, TriangleAlert, Undo2, X } from "@/lib/icons";
import { CardDraft } from "./card-draft";
import { CardImages } from "./card-images";
import { CardFiles } from "./card-files";
import { chooseAssistantCardOption, dismissAssistantCard, okAssistantCard } from "@/lib/assistant-cards-api";
import { CardChoices } from "./card-choices";
import type { AssistantCard } from "../../../../shared/assistant-cards";
import { CardButton, CardShell, CardText } from "./card-shell";
import { openCardManagerChat, useCardAction } from "./use-card-action";
import { useCardReplyHost } from "./card-reply-host";
import { CardHandedOffTasks } from "./card-task-items";

export function DecisionCard({ card, onCard }: { card: AssistantCard; onCard?: (card: AssistantCard) => void }) {
  const { busy, error, run } = useCardAction(onCard);
  const { replyTo, inManagerChat } = useCardReplyHost();
  const urgent = card.kind === "urgent";
  const draft = card.payload.draft;
  const options = card.payload.options ?? [];
  const open = card.status === "open";
  return (
    <CardShell
      card={card}
      look={{ label: urgent ? "Urgent" : "Needs your decision", Icon: urgent ? TriangleAlert : BellRing, tone: "need" }}
      error={error}
      actions={(
        <>
          {card.okOffered && options.length === 0 && (
            <CardButton variant="primary" disabled={busy} onClick={() => void run(() => okAssistantCard(card.id, draft?.sha256 ?? null))}>
              <Check className="size-3.5" />{draft ? "OK, send" : "OK"}
            </CardButton>
          )}
          <CardButton disabled={!card.sessionId} onClick={() => replyTo(card)}>
            <Undo2 className="size-3.5" />Reply
          </CardButton>
        </>
      )}
      secondary={(
        <>
          {!inManagerChat && (
            <CardButton variant="ghost" secondary title="Open manager chat" onClick={() => openCardManagerChat(card)} disabled={!card.sessionId}>
              <ExternalLink className="size-3.5" />Open chat
            </CardButton>
          )}
          <CardButton variant="ghost" secondary disabled={busy} onClick={() => void run(() => dismissAssistantCard(card.id))}>
            <X className="size-3.5" />Dismiss
          </CardButton>
        </>
      )}
    >
      <h4 className="text-[15px] font-semibold leading-snug text-text-primary" data-card-title="">{card.title}</h4>
      {card.body && <CardText text={card.body} fold={card.status !== "open"} projectName={card.projectName} />}
      <CardImages images={card.payload.images} />
      <CardFiles files={card.payload.files} />
      {card.payload.tasks && <CardHandedOffTasks projectName={card.projectName} tasks={card.payload.tasks} />}
      {options.length > 0 && (
        <CardChoices
          options={options}
          pressable={open && card.okOffered === true}
          chosenId={card.answer?.choice?.id}
          disabled={busy}
          onChoose={(optionId) => void run(() => chooseAssistantCardOption(card.id, optionId))}
        />
      )}
      {options.length > 0 && !card.okOffered && open && (
        <p className="text-xs text-text-subtle">These choices are too long or hold a hidden value, so they cannot be pressed here. Answer with Reply, or open the manager chat.</p>
      )}
      {draft && <CardDraft draft={draft} />}
      {draft && !card.okOffered && open && (
        <p className="text-xs text-text-subtle">This draft is too long or holds a hidden value, so it cannot be approved here. Answer with Reply, or open the manager chat.</p>
      )}
      {card.payload.urgentCapped && (
        <p className="text-xs text-text-subtle">Held for the morning: this manager already raised its urgent reports tonight.</p>
      )}
    </CardShell>
  );
}
