/**
 * A manager asking the user to decide: needs-decision and urgent reports. The draft, when there is
 * one, is shown whole and verbatim, with hidden characters made visible.
 *
 * "OK, send" (or "OK" with no draft) is offered only when the server says the whole decision is on
 * the card and nothing in it was hidden; it names the exact draft by its hash. "Edit" opens the
 * reply bar under the chat, where the user's own words go to the manager chat word for word.
 */
import { BellRing, Check, ExternalLink, Pencil, TriangleAlert, X } from "@/lib/icons";
import { dismissAssistantCard, okAssistantCard } from "@/lib/assistant-cards-api";
import { useCardReplyStore } from "@/stores/assistant-card-reply-store";
import { escapeHiddenCharacters } from "../../../../shared/reveal-hidden-characters";
import type { AssistantCard } from "../../../../shared/assistant-cards";
import { CardButton, CardShell } from "./card-shell";
import { openCardManagerChat, useCardAction } from "./use-card-action";

export function DecisionCard({ card, onCard }: { card: AssistantCard; onCard?: (card: AssistantCard) => void }) {
  const { busy, error, run } = useCardAction(onCard);
  const replyTo = useCardReplyStore((s) => s.replyTo);
  const urgent = card.kind === "urgent";
  const draft = card.payload.draft;
  return (
    <CardShell
      card={card}
      look={{ label: urgent ? "Urgent" : "Needs your decision", Icon: urgent ? TriangleAlert : BellRing, tone: "need" }}
      error={error}
      actions={(
        <>
          {card.okOffered && (
            <CardButton variant="primary" disabled={busy} onClick={() => void run(() => okAssistantCard(card.id, draft?.sha256 ?? null))}>
              <Check className="size-3.5" />{draft ? "OK, send" : "OK"}
            </CardButton>
          )}
          <CardButton disabled={!card.sessionId} onClick={() => replyTo(card)}>
            <Pencil className="size-3.5" />Edit
          </CardButton>
          <CardButton variant="ghost" secondary onClick={() => openCardManagerChat(card)} disabled={!card.sessionId}>
            <ExternalLink className="size-3.5" />Open manager chat
          </CardButton>
          <CardButton variant="ghost" secondary disabled={busy} onClick={() => void run(() => dismissAssistantCard(card.id))}>
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
      {draft && !card.okOffered && card.status === "open" && (
        <p className="text-xs text-text-subtle">This draft is too long or holds a hidden value, so it cannot be approved here. Reply with Edit, or open the manager chat.</p>
      )}
      {card.payload.urgentCapped && (
        <p className="text-xs text-text-subtle">Held for the morning: this manager already raised its urgent reports tonight.</p>
      )}
    </CardShell>
  );
}
