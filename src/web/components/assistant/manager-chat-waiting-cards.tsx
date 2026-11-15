/**
 * A manager chat's own cards that still wait on the user, above its composer: what this chat
 * reported to the PPM Assistant (a decision, an urgent report, a held rules change), answered
 * right here — OK, Reply (the reply bar opens under the card, and the words go to this chat word
 * for word), Dismiss. A request of the chat's own (an approval, a question) is left out: the chat
 * already shows it as its own card.
 *
 * Shown only while the chat is a project's manager; nothing is fetched for any other chat.
 */
import { useCallback, useMemo, useState } from "react";
import { useManagerChats } from "@/hooks/use-manager-chats";
import { applyAssistantCard } from "@/stores/assistant-cards-store";
import { applyOpenCardResult, orderWaitingCards, useOpenCards } from "@/stores/assistant-open-cards-store";
import { ANSWERABLE_CARD_KINDS, type AssistantCard } from "../../../shared/assistant-cards";
import { CardReplyBar } from "./cards/card-reply-bar";
import { CardReplyHostContext, type CardReplyHost } from "./cards/card-reply-host";
import { WaitingCardsBar } from "./waiting-cards-bar";
import { WAITING_LABEL } from "./assistant-waiting-cards";

export const MANAGER_WAITING_NOTE = "This chat's reports to the PPM Assistant. Answer them here or in the Assistant.";

/** The cards a manager chat shows: its own, minus its requests, in the order the user steps through. */
export function managerChatWaitingCards(cards: readonly AssistantCard[], sessionId: string): AssistantCard[] {
  return orderWaitingCards(cards.filter((c) => c.sessionId === sessionId && !ANSWERABLE_CARD_KINDS.includes(c.kind)));
}

function takeCard(card: AssistantCard): void {
  applyAssistantCard(card);
  applyOpenCardResult(card);
}

export function ManagerChatWaitingCards({ sessionId }: { sessionId: string | null }) {
  const managers = useManagerChats();
  const isManager = !!sessionId && !!managers?.some((m) => m.sessionId === sessionId);
  const all = useOpenCards(isManager);
  const [replyId, setReplyId] = useState<string | null>(null);
  const closeReply = useCallback(() => setReplyId(null), []);
  const host = useMemo<CardReplyHost>(() => ({ replyTo: (card) => setReplyId(card.id), inManagerChat: true }), []);

  if (!isManager || !all || !sessionId) return null;
  const mine = managerChatWaitingCards(all, sessionId);
  if (mine.length === 0) return null;
  return (
    <CardReplyHostContext.Provider value={host}>
      <div className="px-2 md:px-3" data-manager-waiting-cards="">
        <div className="overflow-hidden rounded-xl border border-border shadow-sm">
          <WaitingCardsBar
            cards={mine}
            label={WAITING_LABEL}
            onCard={takeCard}
            note={<p className="px-3 pb-1.5 text-[11px] text-text-subtle">{MANAGER_WAITING_NOTE}</p>}
          >
            {(card) => replyId === card.id ? (
              <div className="pt-2">
                <CardReplyBar target={{ cardId: card.id, projectName: card.projectName, title: card.title }} onClose={closeReply} />
              </div>
            ) : null}
          </WaitingCardsBar>
        </div>
      </div>
    </CardReplyHostContext.Provider>
  );
}
