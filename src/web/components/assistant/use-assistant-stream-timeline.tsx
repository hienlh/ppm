/**
 * The Assistant's stream as an extension of its chat: the cards placed among the messages by time,
 * wake turns answered `[no reply]` folded to one line, and the project filter. Cards are filtered
 * on the server; turns are filtered over the loaded window only, and while a filter is on older
 * pages load from "Load earlier" alone.
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

export function useAssistantStreamTimeline(): ChatTimelineExtension {
  useEffect(() => ensureAssistantCards(), []);
  const cards = useAssistantCardsStore((s) => s.cards);
  const filter = useAssistantCardsStore((s) => s.filter);
  const nextBefore = useAssistantCardsStore((s) => s.nextBefore);
  const managers = useManagerChats();
  const managerSession = filter ? managers?.find((m) => m.projectName === filter)?.sessionId ?? null : null;

  return useMemo<ChatTimelineExtension>(() => ({
    build: (rows) => {
      const list = cards ?? [];
      const items: ChatTimelineItem[] = list.map((card) => ({ key: `card:${card.id}`, at: card.createdAt, node: <AssistantCard card={card} /> }));
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
  }), [cards, filter, managerSession, nextBefore]);
}
