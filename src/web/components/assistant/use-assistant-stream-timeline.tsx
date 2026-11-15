/**
 * The Assistant's stream as an extension of its chat: the cards placed among the messages by time,
 * wake turns answered `[no reply]` folded to one line, and the project filter. Cards are filtered
 * on the server; turns are filtered over the loaded window only, and while a filter is on older
 * pages load from "Load earlier" alone.
 *
 * A card that waits on the user is the one place it is drawn: whole, with its buttons. So every
 * waiting card the filter lets in is drawn here even before its page of history is loaded — taken
 * from the waiting list the red counts are made of, and placed before the oldest loaded message
 * until the page that reaches its time comes in. The dock above the composer jumps to it. Once
 * answered (or set aside) it folds to one line that opens it again, read-only.
 */
import { useEffect, useMemo } from "react";
import { useManagerChats } from "@/hooks/use-manager-chats";
import {
  ensureAssistantCards, loadEarlierAssistantCards, useAssistantCardsStore,
} from "@/stores/assistant-cards-store";
import { collapsedWakeTurns, hiddenByProjectFilter } from "@/lib/assistant-stream-filter";
import { rowTimes } from "@/lib/assistant-timeline-merge";
import type { ChatTimelineExtension, ChatTimelineItem } from "@/components/chat/chat-timeline-extension";
import { REPORT_KINDS, type AssistantCard as Card } from "../../../shared/assistant-cards";
import { AssistantCard } from "./cards/assistant-card";
import { WaitingStreamCard } from "./cards/waiting-stream-card";
import { AnsweredCardFold, isAnsweredDecision } from "./cards/answered-card-fold";
import { applyAssistantCard } from "@/stores/assistant-cards-store";
import { applyOpenCardResult, isWaitingCard, useOpenCards } from "@/stores/assistant-open-cards-store";
import { WakeTurnLine } from "./wake-turn-line";

/** Report cards that landed in a wake turn's window: what that turn read. */
export function reportsRead(cards: readonly Card[], since: number, at: number): number {
  return cards.filter((c) => (REPORT_KINDS as readonly string[]).includes(c.kind) && c.createdAt > since && c.createdAt <= at).length;
}

/**
 * Whether older cards should be fetched to keep up with the chat's history: the loaded messages
 * reach further back than the oldest loaded card, and the server has older ones.
 */
export function needsEarlierCards(oldestRowAt: number | null, cards: readonly Card[], nextBefore: number | null): boolean {
  if (nextBefore === null || oldestRowAt === null || cards.length === 0) return false;
  return oldestRowAt < cards[cards.length - 1]!.createdAt;
}

/**
 * The cards the stream draws: its loaded pages, plus every waiting card the filter lets in that no
 * loaded page holds yet. A card in both is taken from the pages, which follow every event too.
 */
export function streamCards(loaded: readonly Card[], waiting: readonly Card[], filter: string | null): Card[] {
  const have = new Set(loaded.map((c) => c.id));
  const extra = waiting.filter((c) => !have.has(c.id) && (!filter || c.projectName === filter));
  return extra.length ? [...loaded, ...extra] : [...loaded];
}

/** An answer on a waiting card: the stream's list and the waiting list both take it at once. */
function takeCard(card: Card): void {
  applyAssistantCard(card);
  applyOpenCardResult(card);
}

export function useAssistantStreamTimeline(): ChatTimelineExtension {
  useEffect(() => ensureAssistantCards(), []);
  const cards = useAssistantCardsStore((s) => s.cards);
  const filter = useAssistantCardsStore((s) => s.filter);
  const nextBefore = useAssistantCardsStore((s) => s.nextBefore);
  const managers = useManagerChats();
  const open = useOpenCards();
  const managerSession = filter ? managers?.find((m) => m.projectName === filter)?.sessionId ?? null : null;

  return useMemo<ChatTimelineExtension>(() => ({
    build: (rows) => {
      const list = cards ?? [];
      const items: ChatTimelineItem[] = streamCards(list, open ?? [], filter).map((card) => {
        const waiting = isWaitingCard(card);
        return {
          key: `card:${card.id}`,
          at: card.createdAt,
          node: waiting
            ? <WaitingStreamCard card={card} onCard={takeCard} />
            : isAnsweredDecision(card) ? <AnsweredCardFold card={card} /> : <AssistantCard card={card} />,
          keep: waiting,
        };
      });
      const hidden = new Set<string>();
      for (const turn of collapsedWakeTurns(rows)) {
        for (const id of turn.ids) hidden.add(id);
        if (!filter) items.push({ key: `wake:${turn.ids[0]}`, at: turn.at, node: <WakeTurnLine reports={reportsRead(list, turn.since, turn.at)} /> });
      }
      if (filter) for (const id of hiddenByProjectFilter(rows, { projectName: filter, sessionId: managerSession })) hidden.add(id);
      // With every project shown, older cards follow the history the user scrolled back to.
      const times = rowTimes(rows);
      if (!filter && needsEarlierCards(times.length ? times[0]! : null, list, nextBefore)) {
        setTimeout(() => void loadEarlierAssistantCards(), 0);
      }
      return { items, hidden };
    },
    manualPaging: !!filter,
    hasEarlier: nextBefore !== null,
    onLoadEarlier: () => void loadEarlierAssistantCards(),
  }), [cards, filter, managerSession, nextBefore, open]);
}
