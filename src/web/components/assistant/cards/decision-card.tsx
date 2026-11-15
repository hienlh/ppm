/**
 * A manager asking the user to decide: needs-decision and urgent reports. The draft, when there is
 * one, is shown whole and verbatim, with hidden characters made visible.
 *
 * "OK, send" (or "OK" with no draft) is offered only when the server says the whole decision is on
 * the card and nothing in it was hidden; it names the exact draft by its hash. "Reply" opens the
 * reply bar under the chat (in a manager chat, under the card), where the user's own words go to the manager chat word for word.
 */
import { BellRing, Check, ExternalLink, Send, TriangleAlert, Undo2, X } from "@/lib/icons";
import { CardImages } from "./card-images";
import { dismissAssistantCard, okAssistantCard } from "@/lib/assistant-cards-api";
import { escapeHiddenCharacters } from "../../../../shared/reveal-hidden-characters";
import type { AssistantCard } from "../../../../shared/assistant-cards";
import { CardButton, CardShell, CardText } from "./card-shell";
import { openCardManagerChat, useCardAction } from "./use-card-action";
import { useCardReplyHost } from "./card-reply-host";

export function DecisionCard({ card, onCard }: { card: AssistantCard; onCard?: (card: AssistantCard) => void }) {
  const { busy, error, run } = useCardAction(onCard);
  const { replyTo, inManagerChat } = useCardReplyHost();
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
      {draft && (
        <figure className="overflow-hidden rounded-lg border border-border bg-panel-2" data-card-draft="">
          <figcaption className="flex items-center gap-1.5 border-b border-border px-3 py-1.5 text-[11px] text-text-subtle">
            <Send className="size-3 shrink-0" />
            <span className="shrink-0 font-medium uppercase tracking-wide">Draft</span>
            <span className="min-w-0 truncate">to {escapeHiddenCharacters(draft.to)}</span>
          </figcaption>
          {/* Shown whole: "OK, send" approves exactly this text. */}
          <p className="whitespace-pre-wrap break-words px-3 py-2.5 font-mono text-[12.5px] leading-relaxed text-text-primary">{escapeHiddenCharacters(draft.text)}</p>
        </figure>
      )}
      {draft && !card.okOffered && card.status === "open" && (
        <p className="text-xs text-text-subtle">This draft is too long or holds a hidden value, so it cannot be approved here. Answer with Reply, or open the manager chat.</p>
      )}
      {card.payload.urgentCapped && (
        <p className="text-xs text-text-subtle">Held for the morning: this manager already raised its urgent reports tonight.</p>
      )}
    </CardShell>
  );
}
