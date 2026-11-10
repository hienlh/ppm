/**
 * Tells every PPM screen about a card: `assistant:card` with the card as it is now, then
 * `assistant:waiting_changed` with the counts, and — when the waiting counts moved — the manager
 * list again, whose rows carry each project's count. Loaded on use: the global socket and the chat
 * registry load after the services that create cards.
 */
import { broadcastGlobalEvent } from "../../server/ws/global.ts";
import type { AssistantCard, AssistantWaiting } from "../../shared/assistant-cards.ts";
import { createLogger } from "../logger.ts";

const log = createLogger("assistant-cards");

export const ASSISTANT_CARD_EVENT = "assistant:card";
export const ASSISTANT_WAITING_EVENT = "assistant:waiting_changed";

export async function announceCard(card: AssistantCard, waiting: AssistantWaiting, waitingMoved: boolean): Promise<void> {
  try {
    broadcastGlobalEvent({ type: ASSISTANT_CARD_EVENT, card });
    broadcastGlobalEvent({ type: ASSISTANT_WAITING_EVENT, total: waiting.total, byProject: waiting.byProject });
    if (waitingMoved) {
      const { announceManagersChanged } = await import("../assistant-managers/manager-chats-announce.ts");
      await announceManagersChanged([]);
    }
  } catch (e) {
    log.warn(`could not announce card ${card.id}: ${(e as Error).message}`);
  }
}
